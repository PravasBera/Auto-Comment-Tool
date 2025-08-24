/**
 * Facebook Auto Comment Tool (V2.0) — MongoDB Edition
 * ---------------------------------------------------
 * - Static: / -> views/index.html, /admin -> public/admin.html
 * - Cookie sid + /session + /events (SSE logs: ready, log, info, warn, error, success, summary)
 * - Multi-user store: MongoDB (pending/approved/blocked + expiry + notes)
 * - Admin auth: /admin/login (JWT, simple user/pass) + protected routes:
 *     /admin/users, /admin/approve, /admin/block, /admin/unblock, /admin/expire, /admin/delete
 * - Upload tokens/comments/postlinks
 * - Start/Stop job with delay/limit/shuffle
 * - FB link→commentable id resolver (pfbid, story.php, groups, numeric, actor_post) + /resolveLink
 * - Error classifier + per-session SSE clients
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const _fetch = require("node-fetch");
const fetch = global.fetch || _fetch;
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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PUBLIC_DIR = path.join(__dirname, "public");
const VIEWS_DIR = path.join(__dirname, "views");
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(VIEWS_DIR)) fs.mkdirSync(VIEWS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

// -------------------- MongoDB (Users) --------------------
const connectDB = (() => {
  try {
    // support both: module exports a function OR already connects
    const mod = require("./db");
    return typeof mod === "function" ? mod : null;
  } catch {
    return null;
  }
})();

const UserSchema = new mongoose.Schema(
  {
    sessionId: { type: String, index: true, unique: true },
    status: { type: String, enum: ["pending", "approved", "blocked"], default: "pending" },
    blocked: { type: Boolean, default: false },
    expiry: { type: Number, default: null }, // ms timestamp or null
    notes: { type: String, default: "" },
    approvedAt: { type: String, default: null },
    createdAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  { versionKey: false }
);

const User = mongoose.models.User || mongoose.model("User", UserSchema);

async function ensureUser(sessionId) {
  let u = await User.findOne({ sessionId }).lean();
  if (!u) {
    const now = Date.now();
    u = await User.create({
      sessionId,
      status: "pending",
      blocked: false,
      expiry: null,
      notes: "",
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    u = u.toObject();
  }
  return u;
}

async function setUser(sessionId, patch = {}) {
  const upd = { ...patch, updatedAt: Date.now() };
  const u = await User.findOneAndUpdate({ sessionId }, { $set: upd }, { new: true }).lean();
  return u || null;
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
  try {
    let sid = req.cookies?.sid;
    if (!sid) {
      sid = generateUserId(); // custom ID generator
      res.cookie("sid", sid, {
        httpOnly: false,
        maxAge: 180 * 24 * 60 * 60 * 1000,
        sameSite: "lax",
      });
    }
    req.sessionId = sid;
    await ensureUser(sid);
    next();
  } catch (e) {
    console.error("Session init error:", e);
    next(e);
  }
});

// -------------------- Small utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

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
  // numeric id OR actor_post id
  if (/^\d+$/.test(raw) || /^\d+_\d+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    // story.php?id=ACTOR&story_fbid=FBID
    const story = u.searchParams.get("story_fbid");
    const actor = u.searchParams.get("id");
    if (story && actor && /^\d+$/.test(story) && /^\d+$/.test(actor)) {
      return `${actor}_${story}`;
    }
    // /{actor}/posts/{id}
    let m = u.pathname.match(/\/(\d+)\/posts\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;
    // /groups/{group}/permalink/{id}/
    m = u.pathname.match(/\/groups\/(\d+)\/permalink\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;
    // ?fbid=NUMERIC
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
    if (/^\d+_\d+$/.test(id)) return id; // already actor_post style
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

// -------------------- SSE state per session --------------------
/** Map<sessionId, { running:boolean, abort:boolean, clients:Set<res> }> */
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
  const u = await ensureUser(sid);
  res.json({ id: sid, status: u.status, expiry: u.expiry, blocked: u.blocked });
});

app.get("/whoami", async (req, res) => {
  const u = await ensureUser(req.sessionId);
  res.json({ ok: true, user: u });
});

// -------------------- SSE endpoint --------------------
app.get("/events", async (req, res) => {
  let sessionId = req.query.sessionId || req.sessionId || randomUUID();
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

  // named events: session, user
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

// -------------------- Admin auth (simple user/pass + JWT) --------------------
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123"; // CHANGE in production
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
  const list = await User.find({}).lean().sort({ updatedAt: -1 });
  res.json({ ok: true, users: list });
});

// Approve (optional expiry; if absent => lifetime)
app.post("/admin/approve", requireAdmin, async (req, res) => {
  const { username, expiry } = req.body || {};
  const user = await setUser(username, {
    status: "approved",
    blocked: false,
    approvedAt: new Date().toISOString(),
    expiry: expiry ? Date.parse(expiry) || null : null,
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
  const user = await setUser(username, { expiry: expiry ? Date.parse(expiry) || null : null });
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
  // best-effort numeric tail from pfbid
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

    const user = await ensureUser(sessionId);
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

app.post("/start", async (req, res) => {
  const sessionId = req.body?.sessionId || req.sessionId || null;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const user = await ensureUser(sessionId);
  const allowed = isUserAllowed(user);
  if (!allowed.ok) {
    sseLine(sessionId, "error", `Access denied: ${allowed.reason}`);
    return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
  }

  const job = getJob(sessionId);
  if (job.running) {
    return res.status(409).json({ ok: false, message: "Another job is running. Stop it first." });
  }

  const {
    postId = "",
    link1 = "",
    link2 = "",
    link3 = "",
    delay = "5",
    limit = "0",
    useShuffle = "false",
  } = req.body;

  res.json({ ok: true, message: "Started" });

  (async () => {
    try {
      job.running = true;
      job.abort = false;

      sseLine(sessionId, "info", "Job started");

      const pToken = path.join(UPLOAD_DIR, "token.txt");
      const pCmt = path.join(UPLOAD_DIR, "comment.txt");
      const pLinks = path.join(UPLOAD_DIR, "postlink.txt");

      if (!fs.existsSync(pToken)) {
        sseLine(sessionId, "error", "token.txt missing. Upload first.");
        return;
      }
      if (!fs.existsSync(pCmt)) {
        sseLine(sessionId, "error", "comment.txt missing. Upload first.");
        return;
      }

      let tokens = cleanLines(fs.readFileSync(pToken, "utf-8"));
      let comments = cleanLines(fs.readFileSync(pCmt, "utf-8"));
      let manual = [postId, link1, link2, link3].filter(Boolean);
      let filelnk = fs.existsSync(pLinks) ? cleanLines(fs.readFileSync(pLinks, "utf-8")) : [];
      let inputs = [...manual, ...filelnk];

      if (!tokens.length) {
        sseLine(sessionId, "error", "No tokens in token.txt");
        return;
      }
      if (!comments.length) {
        sseLine(sessionId, "error", "No comments in comment.txt");
        return;
      }
      if (!inputs.length) {
        sseLine(sessionId, "error", "No Post ID/Link provided (form or postlink.txt)");
        return;
      }

      // Resolve account names
      sseLine(sessionId, "info", `Resolving account names for ${tokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < tokens.length; i++) {
        if (job.abort) {
          sseLine(sessionId, "warn", "Aborted while resolving names.");
          return;
        }
        try {
          tokenName[tokens[i]] = await getAccountName(tokens[i]);
        } catch {
          tokenName[tokens[i]] = `Account#${i + 1}`;
        }
        await sleep(120);
      }

      // Resolve links → final comment ids
      sseLine(sessionId, "info", `Resolving ${inputs.length} post link/id(s)...`);
      const resolvedPosts = [];
      const wrongLinks = [];
      const resolverToken = tokens[0];

      for (const raw of inputs) {
        if (job.abort) {
          sseLine(sessionId, "warn", "Aborted while resolving posts.");
          return;
        }

        let finalId = null;
        const quick = tryExtractGraphPostId(raw);
        if (quick) {
          finalId = await refineCommentTarget(quick, resolverToken);
        } else {
          const via = await resolveViaGraphLookup(raw, resolverToken);
          if (via) finalId = await refineCommentTarget(via, resolverToken);
        }

        if (finalId) {
          resolvedPosts.push({ raw, id: finalId });
          sseLine(sessionId, "info", `Resolved: ${raw} → ${finalId}`);
        } else {
          wrongLinks.push(raw);
          sseLine(sessionId, "warn", `Unresolved link: ${raw}`);
        }
        await sleep(100);
      }

      if (!resolvedPosts.length) {
        sseLine(sessionId, "error", "Could not resolve any post IDs from inputs.");
        if (wrongLinks.length) sseLine(sessionId, "warn", `Unresolved: ${wrongLinks.length} link(s).`);
        return;
      }
      sseLine(sessionId, "success", `Final resolvable posts: ${resolvedPosts.length}`);
      if (wrongLinks.length) sseLine(sessionId, "warn", `Wrong/unsupported link(s): ${wrongLinks.length}`);

      const doShuffle = String(useShuffle) === "true";
      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
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

      sseLine(sessionId, "info", `Delay: ${delayMs / 1000}s, Limit: ${maxCount || "∞"}`);

      // main loop (round-robin over tokens, comments, posts)
      let count = 0;
      let i = 0;

      while (!job.abort && (!maxCount || count < maxCount)) {
        const token = tokens[i % tokens.length];
        const comment = comments[i % comments.length];
        const post = resolvedPosts[i % resolvedPosts.length];
        const acc = tokenName[token] || `Account#${(i % tokens.length) + 1}`;

        try {
          const out = await postComment({ token, postId: post.id, message: comment });
          okCount++;
          count++;
          sseLine(sessionId, "log", `✔ ${acc} → "${comment}" on ${post.id}`, {
            account: acc,
            comment,
            postId: post.id,
            resultId: out.id || null,
          });
        } catch (err) {
          failCount++;
          count++;
          const cls = classifyError(err);
          counters[cls.kind] = (counters[cls.kind] || 0) + 1;
          sseLine(sessionId, "error", `✖ ${acc} → ${cls.human} (${post.id})`, {
            account: acc,
            postId: post.id,
            errKind: cls.kind,
            errMsg: err.message || String(err),
          });
        }

        if (delayMs > 0 && !job.abort) await sleep(delayMs);
        i++;
      }

      const sent = okCount + failCount;
      if (job.abort) sseLine(sessionId, "warn", "Job aborted by user.");

      sseLine(sessionId, "summary", "Run finished", {
        sent,
        ok: okCount,
        failed: failCount,
        counters,
        message: "token expiry / id locked / wrong link / action blocked — all classified above",
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
(async () => {
  try {
    if (connectDB) {
      await connectDB();
    } else if (!mongoose.connection.readyState) {
      // Fallback: connect here if db.js didn't provide a function but also didn't connect.
      if (!process.env.MONGO_URI) {
        console.warn("⚠️  MONGO_URI not set and db.js didn't export a connector. Skipping explicit connect.");
      } else {
        await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      }
    }

    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("DB connect/start error:", err);
    process.exit(1);
  }
})();
