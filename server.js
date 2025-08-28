/**
 * Facebook Auto Comment Tool (Pro) — Full Server (Mongo + Multi-Post + Packs)
 * ---------------------------------------------------------------------------
 * Features:
 * - Static: / -> views/index.html, /admin -> public/admin.html
 * - Cookie sid + /session + /events (SSE logs: ready, log, info, warn, error, success, summary)
 * - MongoDB users: pending/approved/blocked + expiry + notes
 * - Admin (JWT): /admin/login + /admin/users + /admin/approve/block/unblock/expire/delete
 * - Upload per-session token/comment/postlink (+ names) to uploads/{sessionId}/
 * - Manual Section: up to 4 posts, each with:
 *      target (link or id), namesText (one per line), optional perPostTokensText,
 *      commentPack: Bengali | Benglish | Hinglish | Mix | Default
 * - Comment Packs (server-side files): uploads/packs/{bengali,benglish,hinglish,mix}.txt
 * - Mix loop (token × comment × post round-robin per post)
 * - Delay / Limit / Shuffle comments
 * - FB link→commentable id resolver (+ /resolveLink) + Graph lookup + refine to object_id
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

// ✅ Multer Storage Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // ✅ user যে নাম দিয়েছে সেটাই থাকবে
  }
});

const upload = multer({ storage });

// ===== Custom User ID Generator with ALPHA / BETA / GAMMA / DELTA =====
function generateUserId() {
  const prefixes = ["USER-ALPHA-", "USER-BETA-", "USER-GAMMA-", "USER-DELTA-"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
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

userSchema.pre("save", function(next) {
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
app.get("/", (_req, res) => res.sendFile(path.join(VIEWS_DIR, "index.html")));

// admin.html (static UI)
app.get("/admin", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));


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

const shuffleArr = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// === Anti-abuse tuned defaults (server-side) ===
const DEFAULTS = {
  // human-like pacing / anti-burst
  roundJitterMaxMs: 80,            // প্রতি রাউন্ডে ছোট জিটার
  tokenCooldownMs:10,              // একই টোকেনের মধ্যে বাধ্যতামূলক গ্যাপ (off)
  quotaPerTokenPerHour:100,         // প্রতি টোকেনে প্রতি ঘন্টায় কোটাসীমা (off)
  namesPerComment: 1,              // ১টা নাম/কমেন্ট
  limitPerPost: 50,                 // প্রতি পোস্টে লিমিট (off)

  // error policy
  removeBadTokens: true,           // invalid/locked টোকেন বাদ
  blockedBackoffMs: 10 * 60 * 1000,// 10 মিনিট ব্যাকঅফ (368/blocked হলে)
  requestTimeoutMs: 12000,         // 12s timeout
  retryCount: 1,                   // 1 বার retry (network/timeout only)

  // logging
  sseBatchMs: 600,                   // SSE ব্যাচিং on

  // token rotation scope
  tokenGlobalRing: false           // per-post ring (safer)
};

// ------------------ Link Cleaner ------------------
function cleanPostLink(link) {
  if (!link) return null;
  link = String(link).trim();

  // শুধুই সংখ্যায় post id
  if (/^\d+$/.test(link)) return link;

  // story.php?id=UID&story_fbid=PID
  const storyMatch = link.match(/story\.php\?[^#]*story_fbid=(\d+)&id=(\d+)/);
  if (storyMatch) return `${storyMatch[2]}_${storyMatch[1]}`;

  // /groups/GID/permalink/PID/
  const groupMatch = link.match(/\/groups\/(\d+)\/permalink\/(\d+)/);
  if (groupMatch) return `${groupMatch[1]}_${groupMatch[2]}`;

  // /USERID/posts/POSTID (শেষে slash/query থাকতে পারে)
  const userPostMatch = link.match(/facebook\.com\/(\d+)\/posts\/(\d+)/);
  if (userPostMatch) return `${userPostMatch[1]}_${userPostMatch[2]}`;

  // /posts/POSTID (কোন UID নেই)
  const simplePost = link.match(/\/posts\/(\d+)/);
  if (simplePost) return simplePost[1];

  // pfbid ধরার জন্য
  const pfbidMatch = link.match(/(pfbid\w+)/i);
  if (pfbidMatch) return pfbidMatch[1];

  return null;
}

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
  try {
    const normalized = canonicalizePfbidInput(linkOrPfbidLike);
    const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(
      normalized
    )}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(api);
    const json = await res.json();
    if (json?.og_object?.id) return String(json.og_object.id);
    if (json?.id) return String(json.id);
  } catch {}
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

  // ✅ NEW: handle 368 + abusive/disallowed copy
  if (
    code === 368 ||
    msg.includes("deemed abusive") ||
    msg.includes("otherwise disallowed") ||
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
    } catch {
      job.clients.delete(res); // dead client remove
    }
  }
}

function sseLine(sessionId, type = "log", text = "", meta = {}) {
  sseBroadcast(sessionId, {
    ts: Date.now(),   // timestamp
    type,             // "log" | "success" | "warn" | "error" | "ready"
    text,             // main message string
    meta              // optional extra info { name, post, comment }
  });
}

// --- named SSE event (e.g. "token")
function sseNamed(sessionId, eventName, payloadObj = {}) {
  const job = getJob(sessionId);
  const payload = `event: ${eventName}\n` + `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { job.clients.delete(res); }
  }
}

function logBoth(sessionId, type, text, meta = null) {
  // UI (SSE)
  sseLine(sessionId, type, text, meta || {});
  // Server console
  const tag = type.toUpperCase();
  if (meta) {
    console.log(`[${tag}] [${sessionId}] ${text}`, meta);
  } else {
    console.log(`[${tag}] [${sessionId}] ${text}`);
  }
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

// -------------------- User status endpoints --------------------
app.get("/user", async (req, res) => {
  const sid = req.query.sessionId || req.sessionId;
  if (!sid) return res.status(400).json({ error: "no-session" });

  const u = await ensureUser(sid);

  res.set("Cache-Control", "no-store");
  res.json({
    sessionId: sid,
    status: u.status,
    approved: u.status === "approved",
    blocked: u.blocked,
    expiry: u.expiry,
  });
});

app.get("/api/user", async (req, res) => {
  const sid = req.query.sessionId || req.sessionId;
  if (!sid) return res.status(400).json({ error: "no-session" });

  const u = await ensureUser(sid);

  res.set("Cache-Control", "no-store");
  res.json({
    sessionId: sid,
    status: u.status,
    approved: u.status === "approved",
    blocked: u.blocked,
    expiry: u.expiry,
  });
});

// -------------------- SSE endpoint --------------------
app.get("/events", async (req, res) => {
  const sessionId = req.query.sessionId || req.sessionId || generateUserId();

  // ensure session cookie
  if (!req.cookies?.sid || req.cookies.sid !== sessionId) {
    res.cookie("sid", sessionId, {
      httpOnly: false,
      maxAge: 180 * 24 * 60 * 60 * 1000,
      sameSite: "lax",
    });
  }

  const job  = getJob(sessionId);
  const user = await ensureUser(sessionId);

  // SSE headers
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  job.clients.add(res);

  // send session id (default message)
  // send session id as a named event so frontend doesn't log raw object
sseNamed(sessionId, "session", { sessionId });

  // send current user status (named event)
  res.write(
    "event: user\n" +
    `data: ${JSON.stringify({
      sessionId,
      status:  user.status,
      blocked: user.blocked,
      expiry:  user.expiry,
      message: user.blocked
        ? "Your access is blocked."
        : (user.status === "approved"
            ? (user.expiry
                ? `Your access will expire on ${new Date(+user.expiry).toLocaleString()}`
                : "You have lifetime access.")
            : "Send UserID to admin for approval.")
    })}\n\n`
  );

  // notify ready
  sseLine(sessionId, "ready", "SSE connected");

  // heartbeat (keep-alive)
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
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

// ----------------- Basic FB Link Resolver (route + helpers) -----------------
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
    // accept BOTH spellings so frontend <input name="postlinks"> কাজ করে
    { name: "postlinks", maxCount: 1 },
    { name: "postLinks", maxCount: 1 },
    { name: "uploadNames", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // ✅ sessionId fallback: query/body না থাকলে cookie-session ব্যবহার
      const sessionId =
        req.query.sessionId ||
        req.body.sessionId ||
        req.sessionId;

      if (!sessionId) {
        return res.status(400).json({ ok: false, message: "sessionId required" });
      }

      // ✅ access check (approved/blocked/expired)
      const user = await User.findOne({ sessionId }).lean();
      const allowed = isUserAllowed(user);
      if (!allowed.ok) {
        sseLine(sessionId, "error", `Access denied for upload: ${allowed.reason}`);
        return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
      }

      // ✅ per-session folder
      const sessionDir = path.join(UPLOAD_DIR, sessionId);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      // ✅ save tokens/comments
      if (req.files?.tokens?.[0]) {
        fs.renameSync(req.files.tokens[0].path, path.join(sessionDir, "tokens.txt"));
      }
      if (req.files?.comments?.[0]) {
        fs.renameSync(req.files.comments[0].path, path.join(sessionDir, "comments.txt"));
      }

      // ✅ postlinks vs postLinks — যেটা আছে সেটাই নাও
      const postFile = (req.files?.postlinks?.[0]) || (req.files?.postLinks?.[0]);
      if (postFile) {
        fs.renameSync(postFile.path, path.join(sessionDir, "postlinks.txt"));
      }

      const postLinksPath = path.join(sessionDir, "postlinks.txt");
let links = [];
if (fs.existsSync(postLinksPath)) {
  const rawLinks = fs.readFileSync(postLinksPath, "utf8");
  console.log("📂 postlinks.txt content:\n", rawLinks);
  links = rawLinks
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(cleanPostLink)
    .filter(l => l !== null);
  console.log("✅ Parsed links:", links);
} else {
  console.log("ℹ️ postlinks.txt not found (skip parsing).");
}

      // ✅ names textarea (optional)
      // ছিল: const uploadNames = req.body.uploadNames || "";
const uploadNames = req.body.names || req.body.uploadNames || "";
if (uploadNames && uploadNames.trim()) {
  fs.writeFileSync(path.join(sessionDir, "uploadNames.txt"), uploadNames, "utf-8");
}

      // ✅ simple counter (per-session ফাইল থেকেই)
      const countLines = (p) =>
        fs.existsSync(p)
          ? fs.readFileSync(p, "utf-8").split(/\r?\n/).map(s => s.trim()).filter(Boolean).length
          : 0;

      const tCount = countLines(path.join(sessionDir, "tokens.txt"));
      const cCount = countLines(path.join(sessionDir, "comments.txt"));
      const pCount = countLines(path.join(sessionDir, "postlinks.txt"));
      const nCount = countLines(path.join(sessionDir, "uploadNames.txt"));

      sseLine(
        sessionId,
        "info",
        `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount}, names:${nCount})`
      );

      return res.json({
        ok: true,
        success: true,
        tokens: tCount,
        comments: cCount,
        postLinks: pCount,
        names: nCount,
      });
    } catch (err) {
      console.error("Upload failed:", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ---------------- Stop job ----------------
app.post("/stop", (req, res) => {
  const sessionId = req.body?.sessionId || req.query?.sessionId || null;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const job = getJob(sessionId);
  if (job && job.running) {
    job.abort = true;
    job.running = false;
    sseLine(sessionId, "warn", "Stop requested by user");
    return res.json({ ok: true, message: "Job stopping..." });
  }
  return res.json({ ok: false, message: "No active job" });
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

  // ------------------------------------------------------------
// SUPER FAST RUNNER
// fireGap  = uiDelay / totalIds
// roundGap = uiDelay / ceil(totalIds/3)
// প্রতি রাউন্ড শুরুর আগে posts/tokens/comments/names একটু reshuffle
// ------------------------------------------------------------
async function runJobSuperFast({
  sessionId, resolvedTargets, tokenName,
  uiDelayMs, totalIds, limit,
  requestTimeoutMs, blockedBackoffMs, tokenCooldownMs, retryCount
}) {
  const job = getJob(sessionId);
  const P = resolvedTargets.length;
  const fireGap  = totalIds > 0 ? Math.max(0, Math.floor(uiDelayMs / totalIds)) : 0;
  const batchCnt = Math.max(1, Math.ceil(totalIds / 3));
  const roundGap = Math.max(0, Math.floor(uiDelayMs / batchCnt));

  let sent = 0, okCount = 0, failCount = 0;

  const state = resolvedTargets.map(() => ({ tok:0, cmt:0, name:0, sent:0 }));
  const tState = new Map();
  const ensureT = (tok) => {
    if (!tState.has(tok)) tState.set(tok,{nextAt:0,hourlyCount:0,windowStart:Date.now(),removed:false,backoff:0});
    return tState.get(tok);
  };

  async function sendOne(pIdx){
    const tgt = resolvedTargets[pIdx];
    const st  = state[pIdx];
    if (!tgt.tokens.length || !tgt.comments.length) { logBoth(sessionId,"warn",`Skipped (missing) on ${tgt.id}`); return false; }

    const token   = tgt.tokens[st.tok % tgt.tokens.length];
    const comment = tgt.comments[st.cmt % tgt.comments.length];
    const nameArr = tgt.namesList.length ? [tgt.namesList[st.name % tgt.namesList.length]] : [];
    const message = buildCommentWithNames(comment, nameArr);

    const ts = ensureT(token);
    if (ts.removed || Date.now() < ts.nextAt) return false;

    try{
      await Promise.race([
        postComment({ token, postId: tgt.id, message }),
        new Promise((_,rej)=>setTimeout(()=>rej({message:"Request timeout"}), requestTimeoutMs))
      ]);
      okCount++; sent++;
      st.sent++; st.tok++; st.cmt++; st.name++;
      ts.hourlyCount++; ts.nextAt = Math.max(ts.nextAt, Date.now() + tokenCooldownMs); ts.backoff=0;
      logBoth(sessionId,"log",`✔ ${tokenName[token]||"Account"} → "${message}" on ${tgt.id}`);
    } catch(err){
      failCount++; sent++;
      const cls = classifyError(err);
      if (cls.kind==="INVALID_TOKEN"||cls.kind==="ID_LOCKED"){ ts.removed = true; }
      else if (cls.kind==="COMMENT_BLOCKED"){ ts.backoff = Math.min(Math.max(blockedBackoffMs,(ts.backoff||0)*2 || blockedBackoffMs), 30*60*1000); ts.nextAt = Math.max(ts.nextAt, Date.now()+ts.backoff); }
      else if (cls.kind==="NO_PERMISSION"){ ts.nextAt = Math.max(ts.nextAt, Date.now()+60_000); }
      logBoth(sessionId,"error",`✖ ${tokenName[token]||"Account"} → ${cls.human} (${tgt.id})`);
    }
    return (limit && sent>=limit);
  }

  logBoth(sessionId,"info",`SUPER FAST → fireGap:${fireGap}ms, roundGap:${roundGap}ms, posts:${P}, totalIds:${totalIds}`);

  while(!job.abort && (!limit || sent < limit)){
    // round reshuffle (posts + their rings)
    const order = [...Array(P).keys()].sort(()=>Math.random()-0.5);
    for (const t of resolvedTargets){
      if (t.tokens.length   > 1) t.tokens.sort(()=>Math.random()-0.5);
      if (t.comments.length > 1) t.comments.sort(()=>Math.random()-0.5);
      if (t.namesList.length> 1) t.namesList.sort(()=>Math.random()-0.5);
    }

    for (const idx of order){
      const stop = await sendOne(idx);
      if (stop) break;
      if (fireGap>0) await sleep(fireGap);
      if (job.abort || (limit && sent>=limit)) break;
    }

    if (job.abort || (limit && sent>=limit)) break;
    if (roundGap>0) await sleep(roundGap);
  }

  logBoth(sessionId,"summary","SUPER FAST finished",{ sent:okCount+failCount, ok:okCount, failed:failCount });
  const j=getJob(sessionId); j.running=false; j.abort=false;
  logBoth(sessionId,"info","Job closed");
}

// ------------------------------------------------------------
// EXTREME RUNNER
// batchCount = ceil(totalIds / postsCount)
// roundGap   = uiDelay / batchCount
// প্রতি কমেন্টে micro jitter ~80–120ms (anti-burst)
// ------------------------------------------------------------
async function runJobExtreme({
  sessionId, resolvedTargets, tokenName,
  uiDelayMs, totalIds, postsCount, limit,
  requestTimeoutMs, blockedBackoffMs, tokenCooldownMs, retryCount
}) {
  const job = getJob(sessionId);
  const batchCount = Math.max(1, Math.ceil(totalIds / Math.max(1, postsCount)));
  const roundGap   = Math.max(0, Math.floor(uiDelayMs / batchCount));
  const micro = () => 80 + Math.floor(Math.random()*41); // 80–120ms

  let sent = 0, okCount=0, failCount=0;

  const state = resolvedTargets.map(() => ({ tok:0, cmt:0, name:0, sent:0 }));
  const tState = new Map();
  const ensureT = (tok) => {
    if (!tState.has(tok)) tState.set(tok,{nextAt:0,hourlyCount:0,windowStart:Date.now(),removed:false,backoff:0});
    return tState.get(tok);
  };

  async function fireOne(pIdx){
    const tgt = resolvedTargets[pIdx];
    const st  = state[pIdx];
    if (!tgt.tokens.length || !tgt.comments.length) return;

    const token   = tgt.tokens[st.tok % tgt.tokens.length];
    const comment = tgt.comments[st.cmt % tgt.comments.length];
    const nameArr = tgt.namesList.length ? [tgt.namesList[st.name % tgt.namesList.length]] : [];
    const message = buildCommentWithNames(comment, nameArr);

    const ts = ensureT(token);
    if (ts.removed || Date.now() < ts.nextAt) return;

    try{
      await Promise.race([
        postComment({ token, postId: tgt.id, message }),
        new Promise((_,rej)=>setTimeout(()=>rej({message:"Request timeout"}), requestTimeoutMs))
      ]);
      okCount++; sent++;
      st.sent++; st.tok++; st.cmt++; st.name++;
      ts.hourlyCount++; ts.nextAt = Math.max(ts.nextAt, Date.now()+tokenCooldownMs); ts.backoff=0;
      logBoth(sessionId,"log",`✔ ${tokenName[token]||"Account"} → "${message}" on ${tgt.id}`);
    }catch(err){
      failCount++; sent++;
      const cls = classifyError(err);
      if (cls.kind==="INVALID_TOKEN"||cls.kind==="ID_LOCKED"){ ts.removed = true; }
      else if (cls.kind==="COMMENT_BLOCKED"){ ts.backoff = Math.min(Math.max(blockedBackoffMs,(ts.backoff||0)*2 || blockedBackoffMs), 30*60*1000); ts.nextAt = Math.max(ts.nextAt, Date.now()+ts.backoff); }
      else if (cls.kind==="NO_PERMISSION"){ ts.nextAt = Math.max(ts.nextAt, Date.now()+60_000); }
      logBoth(sessionId,"error",`✖ ${tokenName[token]||"Account"} → ${cls.human} (${tgt.id})`);
    }
  }

  logBoth(sessionId,"info",`EXTREME → burst+micro-jitter, roundGap:${roundGap}ms, posts:${postsCount}, totalIds:${totalIds}`);

  while(!job.abort && (!limit || sent < limit)){
    const order = [...Array(postsCount).keys()].sort(()=>Math.random()-0.5);
    for (const idx of order){
      await fireOne(idx);
      if (limit && sent>=limit) break;
      await sleep(micro());
    }
    if (job.abort || (limit && sent>=limit)) break;
    if (roundGap>0) await sleep(roundGap);
  }

  logBoth(sessionId,"summary","EXTREME finished",{ sent:okCount+failCount, ok:okCount, failed:failCount });
  const j=getJob(sessionId); j.running=false; j.abort=false;
  logBoth(sessionId,"info","Job closed");
}

// --------------------- Core Run Job (round-parallel + burst + guards) ---------------------
// ✅ ঠিক করা
async function runJob(
  job,
  {
    sessionId,
    resolvedTargets,
    tokenName,
    delayMs,
    maxCount,
    // knobs (defaults)
    burstPerPost = 1,
    limitPerPost = 0,
    namesPerComment = 1,
    tokenGlobalRing = false,
    tokenCooldownMs = 0,
    quotaPerTokenPerHour = 0,
    removeBadTokens = true,
    blockedBackoffMs = 10 * 60 * 1000,
    requestTimeoutMs = 12000,
    retryCount = 1,
    roundJitterMaxMs = 80,
    sseBatchMs = 0,
    shuffleEveryRound = false,
  }
) {
    let okCount = 0;
    let failCount = 0;
    const counters = {};

  // --- token order map (1-based) ---
  const tokenOrder = new Map();
  {
    let order = 1;
    for (const t of resolvedTargets) {
      for (const tok of t.tokens) {
        if (!tokenOrder.has(tok)) tokenOrder.set(tok, order++);
      }
    }
  }
  // named emitter for token status
  function pushTokenStatus(tok, status, extra = {}) {
    sseNamed(sessionId, "token", {
      token: tok,
      position: tokenOrder.get(tok) || null,
      status,
      ...extra
    });
  }

  // --- optional local batching of normal logs ---
  let batch = [];
  let batchTimer = null;
  function flushBatch() {
    if (!batch.length) return;
    for (const e of batch) sseBroadcast(sessionId, e);
    batch = [];
  }
  function out(type, text, extra = {}) {
    const payloadObj = { t: Date.now(), type, text, ...extra };
    if (sseBatchMs > 0) {
      batch.push(payloadObj);
      if (!batchTimer) {
        batchTimer = setTimeout(() => { flushBatch(); batchTimer = null; }, sseBatchMs);
      }
    } else {
      sseBroadcast(sessionId, payloadObj);
    }
  }

  try {
    const postCount = resolvedTargets.length;
    if (!postCount) { out("error", "No targets to run."); return; }

    // per-post pointers
    const state = resolvedTargets.map(() => ({
      tokenIndex: 0,
      commentIndex: 0,
      nameIndex: 0,
      sent: 0
    }));

    // optional global token ring
    let globalTokens = [];
    let globalTokIdx = 0;
    if (tokenGlobalRing) {
      const set = new Set();
      for (const t of resolvedTargets) for (const tok of t.tokens) set.add(tok);
      globalTokens = Array.from(set);
    }

    // per-token state
    const tokenState = new Map(); // token -> { nextAvailableAt, hourlyCount, windowStart, removed, backoffMs }
    function ensureTokenState(tok) {
      if (!tokenState.has(tok)) {
        tokenState.set(tok, {
          nextAvailableAt: 0,
          hourlyCount: 0,
          windowStart: Date.now(),
          removed: false,
          backoffMs: 0
        });
      }
      return tokenState.get(tok);
    }
    function tokenQuotaOk(st) {
      if (!quotaPerTokenPerHour) return true;
      const now = Date.now();
      if (now - st.windowStart >= 3600_000) { st.windowStart = now; st.hourlyCount = 0; }
      return st.hourlyCount < quotaPerTokenPerHour;
    }

    // timeout+retry wrapper
    async function attemptWithTimeout(fn) {
      let lastErr;
      for (let i = 0; i <= retryCount; i++) {
        lastErr = undefined;
        try {
          const race = Promise.race([
            fn(),
            new Promise((_, rej) => setTimeout(() => rej({ message: "Request timeout" }), requestTimeoutMs))
          ]);
          return await race;
        } catch (e) {
          lastErr = e;
          const msg = (e?.message || "").toLowerCase();
          const retryable =
            !e?.code && !e?.error_subcode &&
            (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch") || msg.includes("socket"));
          if (!retryable || i === retryCount) throw e;
          await sleep(150 + Math.floor(Math.random() * 200));
        }
      }
      throw lastErr;
    }

    let sent = 0;

    while (!job.abort && (!maxCount || sent < maxCount)) {
  if (job.abort) break;

  const promises = [];
  const advanced = []; // {postIdx, times}

      // -------- per round, visit each post once --------
      for (let pIdx = 0; pIdx < postCount; pIdx++) {
        const tgt = resolvedTargets[pIdx];
        const st = state[pIdx];

        if (limitPerPost && st.sent >= limitPerPost) continue;

        // how many attempts for this post this round
        const burst = Math.max(1, burstPerPost);
        let actualBurst = burst;
        if (limitPerPost) actualBurst = Math.min(actualBurst, Math.max(0, limitPerPost - st.sent));
        if (!tgt.tokens.length || !tgt.comments.length) {
          out("warn", `Skipped: missing tokens/comments for ${tgt.id}`);
          continue;
        }

        let usedTimes = 0;

        // ---- inner burst for this post ----
        for (let b = 0; b < actualBurst; b++) {
          // pick token/comment
          let token;
          if (tokenGlobalRing) {
            if (!globalTokens.length) break;
            token = globalTokens[globalTokIdx % globalTokens.length];
            globalTokIdx++;
          } else {
            token = tgt.tokens[st.tokenIndex % tgt.tokens.length];
          }
          const commentBase = tgt.comments[st.commentIndex % tgt.comments.length];

          // token guards
          const tState = ensureTokenState(token);
          if (tState.removed) continue;
          if (Date.now() < tState.nextAvailableAt) continue;
          if (!tokenQuotaOk(tState)) continue;

          // names slice (k per comment)
          let ns = [];
          if (tgt.namesList.length && namesPerComment > 0) {
            for (let k = 0; k < namesPerComment; k++) {
              const n = tgt.namesList[(st.nameIndex + k) % tgt.namesList.length];
              ns.push(n);
            }
          }

          const message = buildCommentWithNames(commentBase, ns);
          usedTimes++;

          const doSend = async () => {
            const outc = await attemptWithTimeout(() =>
              postComment({ token, postId: tgt.id, message })
            );

            okCount++;
            out("log", `✔ ${tokenName[token] || "Account"} → "${message}" on ${tgt.id}`, {
              account: tokenName[token] || "Account",
              comment: message,
              postId: tgt.id,
              resultId: outc?.id || null,
            });

            // update token state then publish OK
            tState.hourlyCount++;
            tState.nextAvailableAt = Math.max(tState.nextAvailableAt, Date.now() + tokenCooldownMs);
            tState.backoffMs = 0;
            st.sent++;
            pushTokenStatus(token, "OK", { next: tState.nextAvailableAt || null });
          };

          // fire the attempt with error classification
          promises.push(
  (async () => {
    try {
      await doSend();
    } catch (err) {
      failCount++;
      const cls = classifyError(err);
      counters[cls.kind] = (counters[cls.kind] || 0) + 1;

      if (cls.kind === "INVALID_TOKEN" || cls.kind === "ID_LOCKED") {
        if (removeBadTokens) tState.removed = true;
        pushTokenStatus(token, "REMOVED");
      } else if (cls.kind === "COMMENT_BLOCKED") {
        tState.backoffMs = Math.min(
          Math.max(blockedBackoffMs, (tState.backoffMs || 0) * 2 || blockedBackoffMs),
          30 * 60 * 1000
        );
        tState.nextAvailableAt = Math.max(tState.nextAvailableAt, Date.now() + tState.backoffMs);
        pushTokenStatus(token, "BACKOFF", { until: tState.nextAvailableAt });
      } else if (cls.kind === "NO_PERMISSION") {
        tState.nextAvailableAt = Math.max(tState.nextAvailableAt, Date.now() + 60_000);
        pushTokenStatus(token, "NO_PERMISSION", { until: tState.nextAvailableAt });
      } else {
        pushTokenStatus(token, "UNKNOWN");
      }

      out("error", `✖ ${tokenName[token] || "Account"} → ${cls.human} (${tgt.id})`, {
        account: tokenName[token] || "Account",
        postId: tgt.id,
        errKind: cls.kind,
        errMsg: err?.message || String(err),
      });
    }
  })()
);

        if (usedTimes > 0) {
          advanced.push({ postIdx: pIdx, times: usedTimes });
        }
      } // end per-post loop

      // ——— round settled ———
      if (!promises.length) {
        out("warn", "Nothing to attempt this round (guards/limits/inputs).");
        break;
      }

      await Promise.allSettled(promises);
      sent += promises.length;

      if (maxCount && sent >= maxCount) {
        out("info", `Limit reached: ${sent}/${maxCount}`);
        break;
      }

      // advance round-robin pointers per post by how many attempts actually used
      for (const a of advanced) {
        const st = state[a.postIdx];
        st.tokenIndex  += a.times;
        st.commentIndex+= a.times;
        st.nameIndex   += a.times * Math.max(1, namesPerComment);
      }

      if (job.abort) break;

      // per-round delay + small jitter
      const jitter = roundJitterMaxMs ? Math.floor(Math.random() * roundJitterMaxMs) : 0;
      const waitMs = Math.max(0, delayMs + jitter);
      if (waitMs > 0) await sleep(waitMs);

      if (shuffleEveryRound) {
        for (const t of resolvedTargets) {
          if (t.tokens.length)    t.tokens    = shuffleArr(t.tokens);
          if (t.comments.length)  t.comments  = shuffleArr(t.comments);
          if (t.namesList.length) t.namesList = shuffleArr(t.namesList);
        }
        if (resolvedTargets.length > 1) {
          resolvedTargets.sort(() => Math.random() - 0.5);
        }
      }
    } // <-- CLOSE THE while (...) LOOP HERE

    if (job.abort) out("warn", "Job aborted by user.");

    out("summary", "Run finished", {
      sent: okCount + failCount,
      ok: okCount,
      failed: failCount,
      counters,
      message: "token expiry / id locked / wrong link / action blocked — classified above.",
    });
  } catch (e) {
    out("error", `Fatal: ${e.message || e}`);
  } finally {
    const j = getJob(sessionId);
    j.running = false;
    j.abort = false;
    flushBatch();
    sseLine(sessionId, "info", "Job closed");
  }
}

// -------------------- Start Job --------------------
app.post("/start", async (req, res) => {
  const sessionId = req.body?.sessionId || req.query?.sessionId || null;
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

// ---- options (UI) ----
const body = req.body || {};
const speedMode = String(body.delayMode || "fast").toLowerCase(); // fast | superfast | extreme

let delaySec = parseInt(body.delay, 10);
if (isNaN(delaySec) || delaySec < 0) delaySec = 20;
const delayMs = delaySec * 1000;

let limit = parseInt(body.limit, 10);
if (isNaN(limit) || limit < 0) limit = 0;

// ✅ FAST = per-round shuffle (true only for fast mode)
const shuffleEveryRound = (speedMode === "fast");

// ✅ শুরুতেই একবার shuffle করতে চাইলে (optional)
const shuffleStart = true; // চাইলে false দাও

// === server-side tuned defaults (no UI needed)
const requestTimeoutMs     = DEFAULTS.requestTimeoutMs;
const blockedBackoffMs     = DEFAULTS.blockedBackoffMs;
const tokenCooldownMs      = DEFAULTS.tokenCooldownMs;
const retryCount           = DEFAULTS.retryCount;
const roundJitterMaxMs     = DEFAULTS.roundJitterMaxMs;
const quotaPerTokenPerHour = DEFAULTS.quotaPerTokenPerHour;
const namesPerComment      = DEFAULTS.namesPerComment;
const limitPerPost         = DEFAULTS.limitPerPost;
const sseBatchMs           = DEFAULTS.sseBatchMs;
const removeBadTokens      = DEFAULTS.removeBadTokens;
const tokenGlobalRing      = DEFAULTS.tokenGlobalRing;        // 0 = no batching

  // ---- load per-session files
  const sessionDir = path.join(UPLOAD_DIR, sessionId);

  const pTokens = path.join(sessionDir, "tokens.txt");
  const pCmts  = path.join(sessionDir, "comments.txt");

  // allow postlinks.txt OR id.txt
  const pLinksTxt = path.join(sessionDir, "postlinks.txt");
  const pLinksId  = path.join(sessionDir, "id.txt");
  const pLinks = fs.existsSync(pLinksTxt) ? pLinksTxt : (fs.existsSync(pLinksId) ? pLinksId : null);

  const pNames = path.join(sessionDir, "uploadNames.txt");

  const readLines = (p) =>
    fs.existsSync(p) ? cleanLines(fs.readFileSync(p, "utf-8")) : [];

  const fileTokens   = readLines(pTokens);
  const fileComments = readLines(pCmts);
  const fileLinks    = pLinks ? readLines(pLinks).map(cleanPostLink).filter(l => l !== null) : [];
  const fileNames    = readLines(pNames);

  if (!fileTokens.length) {
    sseLine(sessionId, "warn", "No tokens uploaded for this session.");
  }
  if (!fileComments.length) {
    sseLine(sessionId, "warn", "No comments uploaded for this session.");
  }
  if (!fileLinks.length) {
    sseLine(sessionId, "warn", "No post links uploaded for this session.");
  }

  // ---- manual posts
  let manualTargets = [];
  if (Array.isArray(body.posts) && body.posts.length) {
    manualTargets = body.posts.slice(0, 4).map(p => ({
      target: p.target || p,                 
      namesTxt: p.names || "",                // ✅ fixed (was namesText mismatch)
      perPostTokensText: p.tokens || "",
      commentPack: p.commentPack || "Default",
      commentsTxt: p.comments || ""
    }));
  }

  // fallback → if no manualTargets, use global postlinks
  if (!manualTargets.length && fileLinks.length) {
    manualTargets = fileLinks.map(lnk => ({
      target: lnk,
      namesTxt: fileNames.join("\n"),
      perPostTokensText: "",
      commentPack: "Default",
    }));
  }

  console.log("📂 File Links from postlinks:", fileLinks);
  console.log("📝 Manual Posts from body:", body.posts);
  console.log("🎯 Final Manual Targets:", manualTargets);

  if (!manualTargets.length) {
    sseLine(sessionId, "error", "No posts provided (manual or postlinks/id.txt).");
    return res.status(400).json({ ok: false, message: "No posts" });
  }

  // ---- build targets
  let targets = manualTargets.map((p) => {
    const perPostTokens = p.perPostTokensText ? cleanLines(p.perPostTokensText) : [];
    const chosenPack = (p.commentPack && p.commentPack !== "Default") 
      ? (loadPackComments(p.commentPack) || []) 
      : [];

    let tokens = perPostTokens.length ? perPostTokens : fileTokens;
    let comments = chosenPack.length
      ? chosenPack
      : (p.commentsTxt ? cleanLines(p.commentsTxt) : fileComments);

    // ✅ fixed namesTxt usage
    let names = p.namesTxt && p.namesTxt.trim() ? cleanLines(p.namesTxt) : fileNames;

    if (shuffleStart) {
  if (tokens.length)   tokens   = shuffleArr(tokens);
  if (comments.length) comments = shuffleArr(comments);
  if (names.length)    names    = shuffleArr(names);
}

    return {
      rawTarget: p.target,
      tokens,
      comments,
      namesList: names,
    };
  });

  // ---- resolve targets
  const anyToken = targets.find(t => t.tokens.length)?.tokens[0] || fileTokens[0] || null;
  if (!anyToken) {
    sseLine(sessionId, "error", "No token available to resolve links.");
    return res.status(400).json({ ok: false, message: "No tokens available" });
  }

  async function resolveOne(tgt) {
    let id = tryExtractGraphPostId(tgt.rawTarget);
    if (!id) id = await resolveViaGraphLookup(tgt.rawTarget, anyToken);
    if (!id) {
      sseLine(sessionId, "warn", `Could not resolve: ${tgt.rawTarget}`);
      return null;
    }
    id = await refineCommentTarget(id, anyToken);
    return { ...tgt, id };
  }

  const resolvedTargets = [];
  for (const t of targets) {
    try {
      const r = await resolveOne(t);
      if (r && r.id) resolvedTargets.push(r);
    } catch (e) {
      sseLine(sessionId, "warn", `Resolve failed for ${t.rawTarget}: ${e?.message || e}`);
    }
  }
  if (!resolvedTargets.length) {
    sseLine(sessionId, "error", "No valid targets after resolve.");
    return res.status(400).json({ ok: false, message: "No valid targets" });
  }

  // ---- tokenName map
  const tokenSet = new Set();
  resolvedTargets.forEach(t => t.tokens.forEach(tok => tokenSet.add(tok)));
  const tokenName = {};
  for (const tok of tokenSet) {
    tokenName[tok] = await getAccountName(tok);
  }

// ---- start job
job.running = true;
job.abort = false;

res.json({ ok: true, message: "Job started" });

// ✅ এখানে নতুন sseLine বসাবে
sseLine(
  sessionId,
  "info",
  `Starting… posts:${resolvedTargets.length}, delay:${delaySec}s, limit:${limit || "∞"}, roundShuffle:${shuffleEveryRound}, startShuffle:${shuffleStart}`
);

// ---- choose runner by speedMode ----
if (speedMode === "superfast") {
  runJobSuperFast({
    sessionId,
    resolvedTargets,
    tokenName,
    uiDelayMs: delayMs,
    totalIds: resolvedTargets.reduce(
      (n, t) => n + Math.min(t.tokens.length, t.comments.length),
      0
    ),
    limit,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    blockedBackoffMs: DEFAULTS.blockedBackoffMs,
    tokenCooldownMs: DEFAULTS.tokenCooldownMs,
    retryCount: DEFAULTS.retryCount,
  });
} else if (speedMode === "extreme") {
  runJobExtreme({
    sessionId,
    resolvedTargets,
    tokenName,
    uiDelayMs: delayMs,
    totalIds: resolvedTargets.reduce(
      (n, t) => n + Math.min(t.tokens.length, t.comments.length),
      0
    ),
    postsCount: resolvedTargets.length,
    limit,
    requestTimeoutMs: DEFAULTS.requestTimeoutMs,
    blockedBackoffMs: DEFAULTS.blockedBackoffMs,
    tokenCooldownMs: DEFAULTS.tokenCooldownMs,
    retryCount: DEFAULTS.retryCount,
  });
} else {
  runJob(job, {
    sessionId,
    resolvedTargets,
    tokenName,
    delayMs,
    maxCount: limit,
    shuffleEveryRound,
    // ... চাইলে অন্য knobs এখানে দাও
  });
}
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
