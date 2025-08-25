/**
 * Facebook Auto Comment Tool (Pro) — Full Server (Mongo + Multi-Post + Packs)
 * ---------------------------------------------------------------------------
 * Features:
 * - Static: / -> views/index.html, /admin -> public/admin.html
 * - Cookie sid + /session + /events (SSE logs: ready, log, info, warn, error, success, summary)
 * - MongoDB users: pending/approved/blocked + expiry + notes
 * - Admin (JWT): /admin/login + /admin/users + /admin/approve/block/unblock/expire/delete
 * - Upload global token/comment/postlink (filesystem)
 * - Manual Section: up to 4 posts, each with:
 *      target (link or id), namesText (one per line), optional perPostTokensText,
 *      commentPack: Bengali | Benglish | Hinglish | Mix | Default
 * - Comment Packs (server-side files): uploads/packs/{bengali,benglish,hinglish,mix}.txt
 * - Mix loop (token × comment × post round-robin)
 * - Delay / Limit / Shuffle comments
 * - FB link→commentable id resolver (+ /resolveLink)
 * - Error classifier, graceful stop, per-session job state
 *
 * ENV:
 *   PORT=3000
 *   MONGO_URI=mongodb://127.0.0.1:27017/fbtool
 *   JWT_SECRET=change_me
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// ===== Custom User ID Generator =====
function generateUserId() {
  const prefix = "USER-ALPHA-";
  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  return prefix + randomPart;
}

// -------------------- App setup --------------------
const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fbtool";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

// -------------------- MongoDB (Mongoose) --------------------
mongoose.set("strictQuery", false);

const userSchema = new mongoose.Schema(
  {
    sessionId: { type: String, index: true, unique: true },
    status: { type: String, enum: ["pending", "approved", "blocked"], default: "pending" },
    blocked: { type: Boolean, default: false },
    expiry: { type: Number, default: null }, // ms timestamp
    notes: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { collection: "users" }
);

userSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});
const User = mongoose.model("User", userSchema);

async function connectMongo() {
  await mongoose.connect(MONGO_URI, {
    dbName: new URL(MONGO_URI).pathname?.slice(1) || "fbtool",
  });
  console.log("✅ MongoDB connected");
}

// -------------------- Paths --------------------
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const VIEWS_DIR = path.join(ROOT, "views");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const PACKS_DIR = path.join(UPLOAD_DIR, "packs");

for (const dir of [PUBLIC_DIR, VIEWS_DIR, UPLOAD_DIR, PACKS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.static(PUBLIC_DIR));

// index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "index.html"));
});

// admin.html (static UI)
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// -------------------- Upload setup --------------------
const upload = multer({ dest: UPLOAD_DIR });

// -------------------- User DB helpers (Mongo) --------------------
async function ensureUser(sessionId) {
  let u = await User.findOne({ sessionId }).lean();
  if (!u) {
    const now = Date.now();
    const doc = new User({
      sessionId,
      status: "pending",
      blocked: false,
      expiry: null,
      notes: "",
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await doc.save();
    u = doc.toObject();
  }
  return u;
}

async function setUser(sessionId, patch = {}) {
  const doc = await User.findOneAndUpdate(
    { sessionId },
    { $set: { ...patch, updatedAt: Date.now() } },
    { new: true }
  ).lean();
  return doc || null;
}

async function deleteUser(sessionId) {
  await User.deleteOne({ sessionId });
  return true;
}

function isUserAllowed(u) {
  if (!u) return { ok: false, reason: "UNKNOWN_USER" };
  if (u.status === "blocked" || u.blocked) return { ok: false, reason: "BLOCKED" };
  if (u.status !== "approved") return { ok: false, reason: "PENDING" };
  if (u.expiry && Date.now() > Number(u.expiry)) return { ok: false, reason: "EXPIRED" };
  return { ok: true };
}

// -------------------- Cookie session --------------------
app.use(async (req, res, next) => {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = generateUserId();
    res.cookie("sid", sid, {
      httpOnly: false,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    });
  }
  req.sessionId = sid;
  try {
    await ensureUser(sid);
  } catch (e) {
    console.error("ensureUser error:", e);
  }
  next();
});

// -------------------- Small utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (txt) =>
  String(txt || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

// pfbid helpers
const PFBID_RE = /^(pfbid[a-zA-Z0-9]+)$/i;
const PFBID_IN_TEXT_RE = /(pfbid[a-zA-Z0-9]+)/i;

function canonicalizePfbidInput(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (PFBID_IN_TEXT_RE.test(raw)) return u.toString();
    return raw;
  } catch {
    const m = String(raw).trim().match(PFBID_RE);
    if (m) return `https://www.facebook.com/${m[1]}`;
    return raw;
  }
}

function tryExtractGraphPostId(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw) || /^\d+_\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const story = u.searchParams.get("story_fbid");
    const actor = u.searchParams.get("id");
    if (story && actor && /^\d+$/.test(story) && /^\d+$/.test(actor)) {
      return `${actor}_${story}`;
    }
    let m = u.pathname.match(/\/(\d+)\/posts\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;
    m = u.pathname.match(/\/groups\/(\d+)\/permalink\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;
    const fbid = u.searchParams.get("fbid");
    if (fbid && /^\d+$/.test(fbid)) return fbid;
    return null;
  } catch {
    return null;
  }
}

async function resolveViaGraphLookup(linkOrPfbidLike, token) {
  const normalized = canonicalizePfbidInput(linkOrPfbidLike);
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(
    normalized
  )}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(api);
  const json = await res.json();
  if (json?.og_object?.id) return String(json.og_object.id);
  if (json?.id) return String(json.id);
  return null;
}

async function refineCommentTarget(id, token) {
  try {
    if (/^\d+_\d+$/.test(id)) return id;
    const ep = `https://graph.facebook.com/v19.0/${encodeURIComponent(
      id
    )}?fields=object_id,status_type,from,permalink_url&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(ep);
    const json = await res.json();
    if (json?.object_id && /^\d+$/.test(String(json.object_id))) return String(json.object_id);
    return id;
  } catch {
    return id;
  }
}

async function getAccountName(token) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=name&access_token=${encodeURIComponent(token)}`
    );
    const j = await res.json();
    return j?.name || "Unknown Account";
  } catch {
    return "Unknown Account";
  }
}

async function postComment({ token, postId, message }) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(postId)}/comments`;
  const body = new URLSearchParams({ message, access_token: token });
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json();
  if (!res.ok || json?.error) {
    const err = json?.error || { message: `HTTP ${res.status}` };
    throw err;
  }
  if (!json?.id) throw { message: "Comment id missing in response" };
  return json;
}

function classifyError(err) {
  const code = err?.code || err?.error_subcode || 0;
  const msg = (err?.message || "").toLowerCase();
  if (code === 190 || msg.includes("expired") || msg.includes("session has expired"))
    return { kind: "INVALID_TOKEN", human: "Invalid or expired token" };
  if (msg.includes("permission") || msg.includes("insufficient"))
    return { kind: "NO_PERMISSION", human: "Missing permission to comment" };
  if (
    msg.includes("not found") ||
    msg.includes("unsupported") ||
    msg.includes("cannot be accessed") ||
    msg.includes("unknown object")
  )
    return { kind: "WRONG_POST_ID", human: "Wrong or inaccessible post id/link" };
  if (
    msg.includes("temporarily blocked") ||
    msg.includes("rate limit") ||
    msg.includes("reduced") ||
    msg.includes("block")
  )
    return { kind: "COMMENT_BLOCKED", human: "Comment blocked or rate limited" };
  if (msg.includes("checkpoint") || msg.includes("locked") || msg.includes("hold"))
    return { kind: "ID_LOCKED", human: "Account locked/checkpoint" };
  return { kind: "UNKNOWN", human: err?.message || "Unknown error" };
}

// --------------- Name tag helpers (#First_Last) ----------------
function toHashTagName(raw) {
  if (!raw) return "";
  const pieces = String(raw)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/[^A-Za-z0-9]/g, ""));
  if (!pieces.length) return "";
  if (pieces.length === 1) return `#${pieces[0]}`;
  return `#${pieces[0]}_${pieces.slice(1).join("_")}`;
}
function buildCommentWithNames(baseComment, namesList) {
  // If names provided, prepend ALL names (space separated). Else just return base.
  if (!namesList || !namesList.length) return baseComment;
  const tags = namesList.map(toHashTagName).filter(Boolean).join(" ");
  return `${tags} ${baseComment}`.trim();
}

// -------------------- SSE state per session --------------------
const jobs = new Map();
function getJob(sessionId) {
  if (!sessionId) throw new Error("sessionId required");
  if (!jobs.has(sessionId)) {
    jobs.set(sessionId, { running: false, abort: false, clients: new Set() });
  }
  return jobs.get(sessionId);
}
function sseBroadcast(sessionId, payloadObj) {
  const job = getJob(sessionId);
  const payload = `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of job.clients) {
    try {
      res.write(payload);
    } catch {}
  }
}
function sseLine(sessionId, type, text, extra = {}) {
  sseBroadcast(sessionId, { t: Date.now(), type, text, ...extra });
}

// -------------------- Health & session helpers --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/session", async (req, res) => {
  const sid = req.sessionId;
  const u = await User.findOne({ sessionId: sid }).lean();
  res.json({
    id: sid,
    status: u?.status || "pending",
    expiry: u?.expiry || null,
    blocked: u?.blocked || false,
  });
});

app.get("/whoami", async (req, res) => {
  const u = await User.findOne({ sessionId: req.sessionId }).lean();
  res.json({ ok: true, user: u || null });
});

// -------------------- SSE endpoint --------------------
app.get("/events", async (req, res) => {
  let sessionId = req.query.sessionId || req.sessionId || generateUserId();
  if (!req.cookies?.sid || req.cookies.sid !== sessionId) {
    res.cookie("sid", sessionId, {
      httpOnly: false,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    });
  }
  const job = getJob(sessionId);
  const user = await ensureUser(sessionId);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  job.clients.add(res);

  res.write(`event: session\n`);
  res.write(`data: ${sessionId}\n\n`);

  res.write(`event: user\n`);
  res.write(
    `data: ${JSON.stringify({
      sessionId,
      status: user.status,
      blocked: user.blocked,
      expiry: user.expiry,
    })}\n\n`
  );

  sseLine(sessionId, "ready", "SSE connected");

  req.on("close", () => {
    job.clients.delete(res);
  });
});

// -------------------- Admin auth (JWT) --------------------
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "Bullet";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "00000";

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME) return res.json({ ok: false, message: "Invalid username" });
  if ((password || "") !== ADMIN_PASSWORD) return res.json({ ok: false, message: "Invalid password" });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "6h" });
  res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, message: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ ok: false, message: "Invalid token" });
  }
}

// -------------------- Admin protected APIs --------------------
app.get("/admin/users", requireAdmin, async (_req, res) => {
  const list = await User.find({}).sort({ updatedAt: -1 }).lean();
  res.json({ ok: true, users: list });
});

app.post("/admin/approve", requireAdmin, async (req, res) => {
  const { username, expiry } = req.body || {};
  const user = await setUser(username, {
    status: "approved",
    blocked: false,
    approvedAt: new Date(),
    expiry: expiry ? (Date.parse(expiry) || null) : null,
  });
  if (!user) return res.json({ ok: false, message: "User not found" });
  res.json({ ok: true, user });
});

app.post("/admin/block", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  const user = await setUser(username, { status: "blocked", blocked: true });
  if (!user) return res.json({ ok: false, message: "User not found" });
  res.json({ ok: true, user });
});

app.post("/admin/unblock", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  const user = await setUser(username, { status: "approved", blocked: false });
  if (!user) return res.json({ ok: false, message: "User not found" });
  res.json({ ok: true, user });
});

app.post("/admin/expire", requireAdmin, async (req, res) => {
  const { username, expiry } = req.body || {};
  const user = await setUser(username, { expiry: expiry ? (Date.parse(expiry) || null) : null });
  if (!user) return res.json({ ok: false, message: "User not found" });
  res.json({ ok: true, user });
});

app.post("/admin/delete", requireAdmin, async (req, res) => {
  const { username } = req.body || {};
  const ok = await deleteUser(username);
  res.json({ ok });
});

// ----------------- FB Link Resolver (route + helpers) -----------------
function base58Decode(str) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(0);
  for (let char of str) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    num = num * BigInt(58) + BigInt(idx);
  }
  return num.toString();
}
function pfbidToPostId(pfbid) {
  let clean = String(pfbid).replace(/^pfbid/i, "").replace(/[_-]/g, "");
  const decoded = base58Decode(clean);
  return decoded.slice(-16);
}

app.post("/resolveLink", async (req, res) => {
  try {
    const { link } = req.body || {};
    if (!link) return res.json({ success: false, error: "No link provided" });

    let postId = null;
    let userId = null;

    if (link.includes("pfbid")) {
      const match = link.match(/(pfbid[A-Za-z0-9]+)/i);
      if (match) postId = pfbidToPostId(match[1]);
      const uidMatch = link.match(/facebook\.com\/(\d+)/);
      if (uidMatch) userId = uidMatch[1];
    } else if (link.includes("story.php")) {
      const url = new URL(link);
      postId = url.searchParams.get("story_fbid");
      userId = url.searchParams.get("id");
    } else if (link.includes("/posts/")) {
      const parts = link.split("/");
      const idx = parts.indexOf("posts");
      if (idx !== -1) {
        userId = parts[idx - 1];
        postId = parts[idx + 1];
      }
    } else if (/^\d+(_\d+)?$/.test(link.trim())) {
      postId = link.trim();
    }

    if (!postId) return res.json({ success: false, error: "Could not resolve post id" });
    return res.json({ success: true, postId, userId: userId || null });
  } catch (err) {
    console.error("resolveLink error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- Upload (protected by user access) --------------------
app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
  ]),
  async (req, res) => {
    const sessionId = req.query.sessionId || req.body.sessionId || req.sessionId || null;
    if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

    const user = await User.findOne({ sessionId }).lean();
    const allowed = isUserAllowed(user);
    if (!allowed.ok) {
      sseLine(sessionId, "error", `Access denied for upload: ${allowed.reason}`);
      return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
    }

    try {
      if (req.files?.tokens?.[0])
        fs.renameSync(req.files.tokens[0].path, path.join(UPLOAD_DIR, "token.txt"));
      if (req.files?.comments?.[0])
        fs.renameSync(req.files.comments[0].path, path.join(UPLOAD_DIR, "comment.txt"));
      if (req.files?.postlinks?.[0])
        fs.renameSync(req.files.postlinks[0].path, path.join(UPLOAD_DIR, "postlink.txt"));

      const tCount = fs.existsSync(path.join(UPLOAD_DIR, "token.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "token.txt"), "utf-8")).length
        : 0;
      const cCount = fs.existsSync(path.join(UPLOAD_DIR, "comment.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "comment.txt"), "utf-8")).length
        : 0;
      const pCount = fs.existsSync(path.join(UPLOAD_DIR, "postlink.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "postlink.txt"), "utf-8")).length
        : 0;

      sseLine(
        sessionId,
        "info",
        `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount})`
      );
      res.json({ ok: true, tokens: tCount, comments: cCount, postlinks: pCount });
    } catch (e) {
      sseLine(sessionId, "error", `Upload failed: ${e.message}`);
      res.status(500).json({ ok: false, message: "Upload failed", error: e.message });
    }
  }
);

// -------------------- Stop/Start job --------------------
app.post("/stop", (req, res) => {
  const sessionId = req.body?.sessionId || req.sessionId || null;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const job = getJob(sessionId);
  if (job.running) {
    job.abort = true;
    sseLine(sessionId, "warn", "Stop requested by user");
    return res.json({ ok: true, message: "Stopping..." });
  }
  res.json({ ok: true, message: "No active job" });
});

// --------- Comment pack loader ----------
function loadPackComments(name) {
  const map = {
    bengali: "bengali.txt",
    benglish: "benglish.txt",
    hinglish: "hinglish.txt",
    mix: "mix.txt",
  };
  const key = String(name || "").toLowerCase();
  const file = map[key];
  if (!file) return null;
  const full = path.join(PACKS_DIR, file);
  if (!fs.existsSync(full)) return null;
  return cleanLines(fs.readFileSync(full, "utf-8"));
}

// -------------------- Start job (Manual + Upload Hybrid) --------------------
app.post("/start", async (req, res) => {
  const sessionId = req.body?.sessionId || req.sessionId || null;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const user = await User.findOne({ sessionId }).lean();
  const allowed = isUserAllowed(user);
  if (!allowed.ok) {
    sseLine(sessionId, "error", `Access denied: ${allowed.reason}`);
    return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
  }

  const job = getJob(sessionId);
  if (job.running) {
    return res.status(409).json({ ok: false, message: "Another job is running. Stop it first." });
  }

  // New manual payload
  const {
    posts = [], // up to 4
    delay = "5",
    limit = "0",
    useShuffle = "false",
  } = req.body || {};

  res.json({ ok: true, message: "Started" });

  (async () => {
    try {
      job.running = true;
      job.abort = false;

      sseLine(sessionId, "info", "Job started");

      // Global files
      const pToken = path.join(UPLOAD_DIR, "token.txt");
      const pCmt = path.join(UPLOAD_DIR, "comment.txt");
      const pLinks = path.join(UPLOAD_DIR, "postlink.txt");

      if (!fs.existsSync(pToken)) {
        sseLine(sessionId, "warn", "token.txt missing (will rely on per-post tokens if provided)");
      }
      if (!fs.existsSync(pCmt)) {
        sseLine(sessionId, "warn", "comment.txt missing (use a pack or manual)");
      }

      const globalTokens = fs.existsSync(pToken) ? cleanLines(fs.readFileSync(pToken, "utf-8")) : [];
      const globalComments = fs.existsSync(pCmt) ? cleanLines(fs.readFileSync(pCmt, "utf-8")) : [];
      const fileLinks = fs.existsSync(pLinks) ? cleanLines(fs.readFileSync(pLinks, "utf-8")) : [];

      // Build targets
      // Manual posts (max 4), plus any links from postlink.txt if manual empty.
      let manualTargets = Array.isArray(posts) ? posts.slice(0, 4) : [];
      if (!manualTargets.length && fileLinks.length) {
        manualTargets = fileLinks.map((lnk) => ({
          target: lnk,
          namesText: "",
          perPostTokensText: "",
          commentPack: "Default",
        }));
      }

      if (!manualTargets.length) {
        sseLine(sessionId, "error", "No posts provided (manual or postlink.txt).");
        return;
      }

      // Resolve account names for all tokens we might use (global + per-post unique)
      const tokenSet = new Set(globalTokens);
      for (const p of manualTargets) {
        const lines = cleanLines(p?.perPostTokensText || "");
        for (const t of lines) tokenSet.add(t);
      }
      const allTokens = Array.from(tokenSet).filter(Boolean);

      if (!allTokens.length) {
        sseLine(sessionId, "error", "No tokens (global token.txt or per-post tokens) supplied.");
        return;
      }

      sseLine(sessionId, "info", `Resolving account names for ${allTokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < allTokens.length; i++) {
        if (job.abort) {
          sseLine(sessionId, "warn", "Aborted while resolving names.");
          return;
        }
        const t = allTokens[i];
        try {
          tokenName[t] = await getAccountName(t);
        } catch {
          tokenName[t] = `Account#${i + 1}`;
        }
        await sleep(120);
      }

      // Resolve links → final comment ids
      // Use first available token for resolver
      const resolverToken = allTokens[0];

      sseLine(sessionId, "info", `Resolving ${manualTargets.length} target(s)...`);
      const resolvedTargets = [];
      for (const p of manualTargets) {
        if (job.abort) {
          sseLine(sessionId, "warn", "Aborted while resolving targets.");
          return;
        }
        const raw = (p?.target || "").trim();
        if (!raw) continue;
        let finalId = null;
        const quick = tryExtractGraphPostId(raw);
        if (quick) {
          finalId = await refineCommentTarget(quick, resolverToken);
        } else {
          const via = await resolveViaGraphLookup(raw, resolverToken);
          if (via) finalId = await refineCommentTarget(via, resolverToken);
        }
        if (finalId) {
          // Prepare names list
          const namesList = cleanLines(p?.namesText || "");
          // Prepare comments for this post (pack or global)
          let packKey = String(p?.commentPack || "Default").toLowerCase();
          let postComments = null;
          if (packKey !== "default") {
            postComments = loadPackComments(packKey);
          }
          if (!postComments || !postComments.length) {
            postComments = [...globalComments];
          }
          // Prepare token list for this post (per-post tokens or global)
          const perPostTokens = cleanLines(p?.perPostTokensText || "");
          const usableTokens = perPostTokens.length ? perPostTokens : [...globalTokens];

          resolvedTargets.push({
            raw,
            id: finalId,
            namesList,
            comments: postComments,
            tokens: usableTokens,
          });

          sseLine(
            sessionId,
            "info",
            `Resolved: ${raw} → ${finalId} | names:${namesList.length} | comments:${postComments.length} | tokens:${usableTokens.length}`
          );
        } else {
          sseLine(sessionId, "warn", `Unresolved link: ${raw}`);
        }
        await sleep(100);
      }

      if (!resolvedTargets.length) {
        sseLine(sessionId, "error", "Could not resolve any post IDs from inputs.");
        return;
      }

      // Shuffle per post comments if asked
      const doShuffle = String(useShuffle) === "true";
      for (const tgt of resolvedTargets) {
        if (doShuffle && tgt.comments.length > 1) {
          for (let i = tgt.comments.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tgt.comments[i], tgt.comments[j]] = [tgt.comments[j], tgt.comments[i]];
          }
        }
      }

      const delayMs = Math.max(0, parseInt(delay, 10) || 0) * 1000;
      const maxCount = Math.max(0, parseInt(limit, 10) || 0);

      let okCount = 0,
        failCount = 0;
      const counters = {
        INVALID_TOKEN: 0,
        WRONG_POST_ID: 0,
        NO_PERMISSION: 0,
        COMMENT_BLOCKED: 0,
        ID_LOCKED: 0,
        UNKNOWN: 0,
      };

      sseLine(
        sessionId,
        "success",
        `Ready: posts=${resolvedTargets.length}, delay=${delayMs / 1000}s, limit=${
          maxCount || "∞"
        }`
      );

      // ---------- MIX LOOP ----------
      // Round robins: post index, token index per post, comment index per post, name index per post.
      const postCount = resolvedTargets.length;
      const state = resolvedTargets.map((t) => ({
        tokenIndex: 0,
        commentIndex: 0,
        nameIndex: 0,
      }));

      let sent = 0;
      let postIndex = 0;

      while (!job.abort && (!maxCount || sent < maxCount)) {
        const tgt = resolvedTargets[postIndex % postCount];
        const st = state[postIndex % postCount];

        if (!tgt.tokens.length) {
          sseLine(sessionId, "warn", `Skipped: no tokens for post ${tgt.id}`);
          // move to next post
          postIndex++;
          continue;
        }
        if (!tgt.comments.length) {
          sseLine(sessionId, "warn", `Skipped: no comments for post ${tgt.id}`);
          postIndex++;
          continue;
        }

        const token = tgt.tokens[st.tokenIndex % tgt.tokens.length];
        const commentBase = tgt.comments[st.commentIndex % tgt.comments.length];

        // Build names for this turn (if any)
        let namesSlice = [];
        if (tgt.namesList.length) {
          // 1 name per comment step; you can change to multiple if you want
          namesSlice = [tgt.namesList[st.nameIndex % tgt.namesList.length]];
        }

        const message = buildCommentWithNames(commentBase, namesSlice);

        try {
          const out = await postComment({ token, postId: tgt.id, message });
          okCount++;
          sent++;
          sseLine(sessionId, "log", `✔ ${tokenName[token] || "Account"} → "${message}" on ${tgt.id}`, {
            account: tokenName[token] || "Account",
            comment: message,
            postId: tgt.id,
            resultId: out.id || null,
          });
        } catch (err) {
          failCount++;
          sent++;
          const cls = classifyError(err);
          counters[cls.kind] = (counters[cls.kind] || 0) + 1;
          sseLine(sessionId, "error", `✖ ${tokenName[token] || "Account"} → ${cls.human} (${tgt.id})`, {
            account: tokenName[token] || "Account",
            postId: tgt.id,
            errKind: cls.kind,
            errMsg: err?.message || String(err),
          });
        }

        // advance per-post indices (mix loop)
        st.tokenIndex++;
        st.commentIndex++;
        st.nameIndex++;

        // advance post pointer
        postIndex++;

        if (delayMs > 0 && !job.abort) await sleep(delayMs);
      }

      if (job.abort) sseLine(sessionId, "warn", "Job aborted by user.");

      sseLine(sessionId, "summary", "Run finished", {
        sent: okCount + failCount,
        ok: okCount,
        failed: failCount,
        counters,
        message:
          "token expiry / id locked / wrong link / action blocked — classified above (per SSE).",
      });
    } catch (e) {
      sseLine(sessionId, "error", `Fatal: ${e.message || e}`);
    } finally {
      const job2 = getJob(sessionId);
      job2.running = false;
      job2.abort = false;
      sseLine(sessionId, "info", "Job closed");
    }
  })();
});

// -------------------- Boot --------------------
connectMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Mongo connection failed:", err);
    process.exit(1);
  });
