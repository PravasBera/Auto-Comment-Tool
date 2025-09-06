/**
 * Facebook Auto Comment Tool (Pro) â€” Full Server (Mongo + Multi-Post + Packs)
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
 * - Mix loop (token Ã— comment Ã— post round-robin per post)
 * - Delay / Limit / Shuffle comments
 * - FB linkâ†’commentable id resolver (+ /resolveLink) + Graph lookup + refine to object_id
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
const liveUploads = new Map(); // sessionId -> { tokens: [], comments: [], postlinks: [], names: [] }
require("dotenv").config();


const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/x-www-form-urlencoded"
};

// ===== Multer: use memory storage (no disk writes) =====
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 2 } // 2MB per file (চাইলে কম/বেশি করো)
});

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

// --- START: safe upload helpers (paste after shuffleArr) ---
const ALLOWED_UPLOAD_EXT = new Set([".txt"]); // চাইলে এক্সটেনশন বাড়াও

function sanitizeFilename(name) {
  const base = path.basename(String(name || ""));
  // keep alnum, underscore, dash, dot and space; replace others with _
  return base.replace(/[^\w\-. ]+/g, "_");
}

async function safeMove(srcPath, destDir, originalName) {
  // ensure dest dir
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const ext = String(path.extname(originalName || "") || "").toLowerCase();
  if (!ALLOWED_UPLOAD_EXT.has(ext)) {
    // remove temp file if invalid and throw
    try { fs.unlinkSync(srcPath); } catch (e) {}
    throw new Error(`Invalid upload file type: ${ext || "<none>"}`);
  }

  const cleanName = sanitizeFilename(originalName || "upload.txt");
  const finalName = `${Date.now()}_${cleanName}`;
  const destPath = path.join(destDir, finalName);

  // try atomic rename first (fast)
  try {
    fs.renameSync(srcPath, destPath);
    return destPath;
  } catch (errRename) {
    // fallback to copy+unlink (cross-device)
    try {
      fs.copyFileSync(srcPath, destPath);
      try { fs.unlinkSync(srcPath); } catch (e) {}
      return destPath;
    } catch (errCopy) {
      try { fs.unlinkSync(srcPath); } catch (e) {}
      throw new Error(`Failed to move uploaded file: ${errCopy.message || errRename.message}`);
    }
  }
}
// --- END helper ---

// -------------------- Error Classifier --------------------
function classifyError(err) {
  const msg = (err?.message || "").toLowerCase();

  if (msg.includes("invalid token") || msg.includes("session has been invalidated")) {
    return { kind: "INVALID_TOKEN", human: "Invalid or expired token" };
  }
  if (msg.includes("id locked") || msg.includes("checkpoint")) {
    return { kind: "ID_LOCKED", human: "Account locked / checkpoint" };
  }
  if (msg.includes("enrolled in a blocking") || msg.includes("logged-in checkpoint") || msg.includes("enrolled") ) {
  return { kind: "ID_LOCKED", human: "Account blocked by checkpoint" };
  }
  if (msg.includes("commenting too fast") || msg.includes("temporarily blocked")) {
    return { kind: "COMMENT_BLOCKED", human: "Commenting temporarily blocked" };
  }
  if (msg.includes("permission") || msg.includes("not authorized")) {
    return { kind: "NO_PERMISSION", human: "No permission on post" };
  }
  if (msg.includes("abusive") || msg.includes("policy") || msg.includes("community standards")) {
    return { kind: "ABUSIVE", human: "Blocked: Abusive / Policy violation" };
  }

  return { kind: "UNKNOWN", human: msg || "Unknown error" };
}

// ------------------ Link Cleaner ------------------
function cleanPostLink(link) {
  if (!link) return null;
  link = String(link).trim();

  // à¦¶à§à¦§à§à¦‡ à¦¸à¦‚à¦–à§à¦¯à¦¾à§Ÿ post id
  if (/^\d+$/.test(link)) return link;

  // story.php?id=UID&story_fbid=PID
  const storyMatch = link.match(/story\.php\?[^#]*story_fbid=(\d+)&id=(\d+)/);
  if (storyMatch) return `${storyMatch[2]}_${storyMatch[1]}`;

  // /groups/GID/permalink/PID/
  const groupMatch = link.match(/\/groups\/(\d+)\/permalink\/(\d+)/);
  if (groupMatch) return `${groupMatch[1]}_${groupMatch[2]}`;

  // /USERID/posts/POSTID (à¦¶à§‡à¦·à§‡ slash/query à¦¥à¦¾à¦•à¦¤à§‡ à¦ªà¦¾à¦°à§‡)
  const userPostMatch = link.match(/facebook\.com\/(\d+)\/posts\/(\d+)/);
  if (userPostMatch) return `${userPostMatch[1]}_${userPostMatch[2]}`;

  // /posts/POSTID (à¦•à§‹à¦¨ UID à¦¨à§‡à¦‡)
  const simplePost = link.match(/\/posts\/(\d+)/);
  if (simplePost) return simplePost[1];

  // pfbid à¦§à¦°à¦¾à¦° à¦œà¦¨à§à¦¯
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

// -------------------- Multi-version Graph fetch --------------------
async function fetchGraphWithFallback(path, token, versions = ["v19.0","v15.0","v7.0"]) {
  for (const ver of versions) {
    try {
      const url = `https://graph.facebook.com/${ver}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url, { headers: COMMON_HEADERS });
      const json = await res.json();
      if (res.ok && !json.error) {
        return { ok: true, json, via: ver };
      }
    } catch (e) {
      console.log(`⚠️ ${ver} failed:`, e.message);
    }
  }
  return { ok: false, json: null, via: null };
}

async function resolveViaGraphLookup(linkOrPfbidLike, token) {
  try {
    const normalized = canonicalizePfbidInput(linkOrPfbidLike);
    const path = `?id=${encodeURIComponent(normalized)}`;
    const { ok, json, via } = await fetchGraphWithFallback(path, token);

    if (ok) {
      if (json?.og_object?.id) return String(json.og_object.id);
      if (json?.id) return String(json.id);
    }
  } catch {}
  return null;
}

async function refineCommentTarget(id, token) {
  try {
    if (/^\d+_\d+$/.test(id)) return id;
    const path = `${encodeURIComponent(id)}?fields=object_id,status_type,from,permalink_url`;
    const { ok, json, via } = await fetchGraphWithFallback(path, token);

    if (ok && json?.object_id && /^\d+$/.test(String(json.object_id))) {
      return String(json.object_id);
    }
    return id;
  } catch {
    return id;
  }
}

async function getAccountName(token) {
  try {
    const path = `me?fields=name`;
    const { ok, json, via } = await fetchGraphWithFallback(path, token);

    if (ok) return json?.name || "Unknown Account";
    return "Unknown Account";
  } catch {
    return "Unknown Account";
  }
}

// -------------------- Post Comment (Dual System with Loophole) --------------------
// শুধুই v15 ব্যবহার করে postComment — checkpoint/errors কে bubble up করে
async function postComment({ token, postId, message }) {
  const url = `https://graph.facebook.com/v15.0/${encodeURIComponent(postId)}/comments`;
  const body = new URLSearchParams({ message, access_token: token });

  try {
    const res = await fetch(url, { method: "POST", body }); // Content-Type set automatically
    const json = await res.json().catch(() => ({}));

    // success -> return
    if (res.ok && json && json.id) {
      return { ok: true, id: json.id, via: "v15" };
    }

    // error handling
    const errMsg = (json?.error?.message || "").toString().toLowerCase();

    // checkpoint/blocking/locked-like messages -> throw so caller can mark token removed
    if (errMsg.includes("checkpoint") || errMsg.includes("blocking") || errMsg.includes("locked") || errMsg.includes("enrolled") || errMsg.includes("action blocked")) {
      throw { message: json.error?.message || "Blocked / checkpoint", code: json.error?.code || null };
    }

    // permission / unsupported -> throw so caller can handle (previous code returned null to fallback)
    if (errMsg.includes("permission") || errMsg.includes("unsupported") || errMsg.includes("not authorized")) {
      throw json?.error || { message: json?.error?.message || `Permission / unsupported: HTTP ${res.status}` };
    }

    // 다른 কোনো error -> throw so caller classifies it
    throw json?.error || { message: `HTTP ${res.status}` };
  } catch (e) {
    // যদি catch-এ checkpoint-like message আসে (কেউ আগে throw করে ফেলল), আবার rethrow করো
    const em = (e && e.message) ? String(e.message).toLowerCase() : "";
    if (em.includes("checkpoint") || em.includes("blocking") || em.includes("locked") || em.includes("enrolled") || em.includes("action blocked") || em.includes("blocked / checkpoint")) {
      throw e;
    }
    // otherwise bubble up the error (so runJob's classifyError can run)
    throw e;
  }
}

// -------------------- Send Message (Dual System with Loophole) --------------------
// ব্যবহার করো: replace your existing sendMessage with this
async function sendMessage({ token, convoId, message }) {
  // পরিবর্তনীয়: v15 loophole that matches your Python `t_<convoId>` + JSON body
  async function tryLoopholeV15() {
    const url = `https://graph.facebook.com/v15.0/t_${encodeURIComponent(convoId)}`;
    const bodyJson = JSON.stringify({
      access_token: token,
      message
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson
      });
      const json = await res.json();
      const errMsg = (json?.error?.message || "").toLowerCase();

      // success (some loophole responses may or may not include id — but check)
      if (res.ok && json?.id) {
        return { ok: true, id: json.id, via: "loophole-v15" };
      }

      // explicit blocked/checkpoint detection → bubble up so caller can remove token
      if (errMsg.includes("checkpoint") || errMsg.includes("blocking") || errMsg.includes("locked") || errMsg.includes("enrolled") || errMsg.includes("action blocked")) {
        throw { message: json.error?.message || "Blocked / checkpoint", code: json.error?.code || null };
      }

      // permission/unsupported — return null so caller may fallback to other methods (or mark as fail)
      if (errMsg.includes("permission") || errMsg.includes("unsupported") || errMsg.includes("not authorized")) {
        return null;
      }

      // any other error → throw (caller will classify)
      if (json?.error) throw json.error;
      // no error object and not ok → treat as null (fallback)
      return null;
    } catch (e) {
      const em = String(e?.message || "").toLowerCase();
      // if it's checkpoint-like, rethrow so runJob marks token removed
      if (em.includes("checkpoint") || em.includes("blocking") || em.includes("locked") || em.includes("enrolled") || em.includes("blocked / checkpoint")) {
        throw e;
      }
      // otherwise log and return null (so caller may try other fallbacks)
      console.log("⚠️ Loophole v15 request failed:", e && (e.message || e));
      return null;
    }
  }

  // 1) try v15 loophole only (as you asked)
  const resLo = await tryLoopholeV15();
  if (resLo) return resLo;

  // 2) optional fallback to official messages API (keep or remove)
  // If you want ONLY v15, remove the below fallback block.
  const pageUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(convoId)}/messages`;
  const pageBody = new URLSearchParams({
    messaging_type: "MESSAGE_TAG",
    tag: "ACCOUNT_UPDATE",
    message: JSON.stringify({ text: message }),
    access_token: token
  });

  const res2 = await fetch(pageUrl, { method: "POST", body: pageBody });
  const json2 = await res2.json();
  if (!res2.ok || json2?.error) {
    throw json2?.error || { message: `HTTP ${res2.status}` };
  }
  if (!json2?.id) throw { message: "Message id missing in response" };
  return { ok: true, id: json2.id, via: "page" };
}

// ---------------------------
// Detect Target Type (Post vs Conversation)
// ---------------------------
function detectTargetType(idOrUrl) {
  if (!idOrUrl) return "unknown";
  const s = String(idOrUrl).trim();

  // 🔹 Messenger detect
  if (/facebook\.com\/messages\/t\/(\d+)/i.test(s)) return "message";
  if (/^https?:\/\/(www\.)?facebook\.com\/t\/(\d+)/i.test(s)) return "message";

  // যদি pure convoId হয়
  if (/^\d{16,}$/.test(s)) return "message";   // 16+ digit = convoId

  // 🔹 Post detect (already server এ helper আছে)
  if (/^https?:\/\//i.test(s)) {
    if (/\/posts\/|story_fbid=|\/permalink\//i.test(s)) return "comment";
    if (/\/photo\.php\?fbid=\d+/i.test(s)) return "comment";
    if (/\/video\.php\?v=\d+/i.test(s)) return "comment";
  }

  // শুধু সংখ্যা → FBID (post or actor)
  if (/^\d+$/.test(s)) {
    if (s.length < 16) return "comment"; // ছোট ID ~ post/page
  }

  // fallback → tryExtractGraphPostId
  const tryPost = tryExtractGraphPostId(s);
  if (tryPost) return "comment";

  return "unknown";
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

// === Session AbortController utilities ===
// place this near the top (just before or after `const jobs = new Map();`)

const sessionControllers = new Map();

function createSessionController(sessionId) {
  if (!sessionId) return null;
  // যদি আগের controller থাকে, আগে তাকে abort করে replace করো
  if (sessionControllers.has(sessionId)) {
    try { sessionControllers.get(sessionId).abort(); } catch (e) {}
  }
  const ac = new AbortController();
  sessionControllers.set(sessionId, ac);
  return ac;
}

function getSessionController(sessionId) {
  if (!sessionId) return null;
  return sessionControllers.get(sessionId) || null;
}

function clearSessionController(sessionId) {
  if (!sessionId) return;
  try {
    const c = sessionControllers.get(sessionId);
    if (c) try { c.abort(); } catch (e) {}
  } finally {
    sessionControllers.delete(sessionId);
  }
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

// Replace existing sseBroadcast + sseLine with these implementations:

function sseBroadcast(sessionId, payloadObj) {
  const job = getJob(sessionId);
  // ensure timestamp key name consistent (ts)
  if (!payloadObj.ts) payloadObj.ts = Date.now();
  const payload = `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of job.clients) {
    try {
      res.write(payload);
    } catch {
      job.clients.delete(res);
    }
  }
}

function sseLine(sessionId, type = "log", text = "", meta = {}) {
  const job = getJob(sessionId);
  // flatten meta into top-level to match client expectation
  const payloadObj = {
    ts: Date.now(),
    type,
    text,
    // copy meta fields to top-level (if keys conflict, meta wins intentionally)
    ...meta
  };

  // keep server-side log memory (string array)
  if (!job.logs) job.logs = [];
  job.logs.push(`[${new Date().toLocaleTimeString()}] ${type.toUpperCase()} ${text}`);
  if (job.logs.length > 500) job.logs.shift();

  sseBroadcast(sessionId, payloadObj);
}

// --- named SSE event (e.g. "token")
function sseNamed(sessionId, eventName, payloadObj = {}) {
  const job = getJob(sessionId);
  // inside sseBroadcast before stringify
payloadObj.ts = payloadObj.ts || payloadObj.t || Date.now();
  const payload = `event: ${eventName}\n` + `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of job.clients) {
    try { res.write(payload); } catch { job.clients.delete(res); }
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
  // নতুন — cookie-priority: cookie থাকলে সেটা ব্যবহার করো। cookie না থাকলে query-param, না থাকলে generate।
let sessionId = req.cookies?.sid || null;

if (!sessionId) {
  // cookie না থাকলে query param থেকে দেখো (but only if provided)
  if (req.query && req.query.sessionId) {
    sessionId = String(req.query.sessionId);
  } else {
    sessionId = generateUserId();
  }

  // set cookie once (respect deployment; change sameSite/secure for prod)
  res.cookie("sid", sessionId, {
    httpOnly: false,
    maxAge: 180 * 24 * 60 * 60 * 1000,
    sameSite: "lax", // যদি cross-site করা লাগে: "none" ও secure:true
  });
}

// attach to req for consistency
req.sessionId = sessionId;

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


// ---------------- In-memory upload (no disk writes) ----------------
app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
    { name: "postLinks", maxCount: 1 },
    { name: "uploadNames", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // determine sessionId (prefer cookie if exists, otherwise create transient id)
      let sessionId = req.cookies?.sid || req.body?.sessionId || req.query?.sessionId;
      if (!sessionId) {
        sessionId = generateUserId();
        res.cookie("sid", sessionId, { httpOnly: false, maxAge: 180 * 24 * 60 * 60 * 1000, sameSite: "lax" });
      }

      // Access check (keep your DB rules)
      const user = await User.findOne({ sessionId }).lean().catch(() => null);
      const allowed = isUserAllowed(user);
      if (!allowed.ok) {
        // note: sseLine may be undefined if SSE not connected — guard it
        try { sseLine(sessionId, "error", `Access denied for upload: ${allowed.reason}`); } catch (e) {}
        return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
      }

      // init store
      if (!liveUploads.has(sessionId)) {
        liveUploads.set(sessionId, { tokens: [], comments: [], postlinks: [], names: [] });
      }
      const store = liveUploads.get(sessionId);

      // helper -> use your existing cleanLines for consistent trimming/filtering
      const parseBufferToLines = (buf) => {
        if (!buf) return [];
        const txt = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        return cleanLines(txt);
      };

      // --- tokens (file OR body tokens)
      if (req.files?.tokens?.[0]) {
        try {
          const arr = parseBufferToLines(req.files.tokens[0].buffer);
          store.tokens = arr;
        } catch (e) {
          try { sseLine(sessionId, "error", `Token parsing failed: ${e.message || e}`); } catch(_) {}
          return res.status(400).json({ ok: false, message: "Invalid tokens file", error: String(e) });
        }
      } else if (req.body?.tokens && String(req.body.tokens).trim()) {
        store.tokens = cleanLines(String(req.body.tokens));
      }

      // --- comments (file OR body)
      if (req.files?.comments?.[0]) {
        try {
          const arr = parseBufferToLines(req.files.comments[0].buffer);
          store.comments = arr;
        } catch (e) {
          try { sseLine(sessionId, "error", `Comments parsing failed: ${e.message || e}`); } catch(_) {}
          return res.status(400).json({ ok: false, message: "Invalid comments file", error: String(e) });
        }
      } else if (req.body?.comments && String(req.body.comments).trim()) {
        store.comments = cleanLines(String(req.body.comments));
      }

      // --- postlinks (support both field names; file OR body)
      const postFileObj = req.files?.postlinks?.[0] || req.files?.postLinks?.[0];
      let rawPosts = [];
      if (postFileObj) {
        rawPosts = parseBufferToLines(postFileObj.buffer);
      } else if (req.body?.postlinks && String(req.body.postlinks).trim()) {
        rawPosts = cleanLines(String(req.body.postlinks));
      }

      // sanitize using existing cleanPostLink() -> keep only valid canonical entries
      store.postlinks = rawPosts.map(l => cleanPostLink(l)).filter(Boolean);

      // --- names textarea (body OR file)
      if (req.body && typeof req.body.names === "string" && req.body.names.trim()) {
        store.names = cleanLines(req.body.names);
      } else if (req.files?.uploadNames?.[0]) {
        store.names = parseBufferToLines(req.files.uploadNames[0].buffer);
      } else if (req.body?.uploadNames && String(req.body.uploadNames).trim()) {
        store.names = cleanLines(String(req.body.uploadNames));
      }

      // --- Basic sanity limits (prevent huge memory use)
      const MAX_ITEMS = 10000; // adjust as desired
      for (const k of ["tokens", "comments", "postlinks", "names"]) {
        if ((store[k] || []).length > MAX_ITEMS) {
          store[k] = store[k].slice(0, MAX_ITEMS);
          try { sseLine(sessionId, "warn", `${k} truncated to ${MAX_ITEMS} items to avoid memory overuse`); } catch(_) {}
        }
      }

      // --- counts & SSE log
      const tCount = store.tokens.length;
      const cCount = store.comments.length;
      const pCount = store.postlinks.length;
      const nCount = store.names.length;

      try {
        sseLine(sessionId, "info", `In-memory upload saved (tokens:${tCount}, comments:${cCount}, posts:${pCount}, names:${nCount})`);
      } catch (e) {}

      // return sessionId so client may re-use cookie/session
      return res.json({
        ok: true,
        sessionId,
        tokens: tCount,
        comments: cCount,
        posts: pCount,
        names: nCount,
      });
    } catch (err) {
      console.error("Upload failed (in-memory):", err);
      return res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  }
);

// -------------------- Helpers --------------------
// canonicalSessionId: get sessionId from body -> query -> cookie -> req.sessionId
function canonicalSessionId(req) {
  if (!req) return null;
  const fromBody = req.body && (req.body.sessionId || req.body.sid);
  const fromQuery = req.query && (req.query.sessionId || req.query.sid);
  const fromCookie = req.cookies && (req.cookies.sid || req.cookies.sessionId);
  return String(fromBody || fromQuery || fromCookie || req.sessionId || "").trim() || null;
}

// ---------------- Stop job (REPLACEMENT) ----------------
app.post("/stop", (req, res) => {
  const sessionId = canonicalSessionId(req);
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  // mark job abort flag
  const job = getJob(sessionId);
  if (job && job.running) {
    job.abort = true;

    // try to abort any in-flight controlled requests (if you create controllers for runs)
    try {
      // abort controller stored in sessionControllers (if created by run)
      const sc = getSessionController(sessionId);
      if (sc && typeof sc.abort === "function") {
        try { sc.abort(); } catch (e) { /* ignore */ }
      }
      // ensure we clear the controller entry
      clearSessionController(sessionId);
    } catch (e) {
      console.error("Error while aborting session controller:", e);
    }

    sseLine(sessionId, "warn", "Stop requested by user");
    return res.json({ ok: true, message: "Job stopping..." });
  }
  return res.json({ ok: false, message: "No active job" });
});


// -------------------- Check Job --------------------
app.get("/checkJob", (req, res) => {
  const sessionId = req.query.sessionId || req.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const job = getJob(sessionId);
  res.json({
    running: job.running,
    logs: job.logs ? job.logs.slice(-100) : []   // optional: শুধু শেষ 100 লাইন
  });
});

// -------------------- Clear Logs --------------------
app.post("/clearLogs", (req, res) => {
  const sessionId = req.query.sessionId || req.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const job = getJob(sessionId);
  job.logs = [];
  res.json({ ok: true, message: "Logs cleared" });
});

// -------------------- Global Error Handlers --------------------
app.use((err, req, res, next) => {
  console.error("❌ Uncaught Error:", err);
  res.status(500).json({ ok: false, message: err.message || "Server error" });
});

// Prevent Node process crash
process.on("unhandledRejection", (reason, p) => {
  console.error("❌ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
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
  uiDelayMs, totalIds, limit
}) {
  const job = getJob(sessionId);
  const P = resolvedTargets.length;

  // delay split (তোমার ফরমুলা)
  const fireGap  = totalIds > 0 ? Math.max(0, Math.floor(uiDelayMs / totalIds)) : 0;
  const batchCnt = Math.max(1, Math.ceil(totalIds / 3));
  const roundGap = Math.max(0, Math.floor(uiDelayMs / batchCnt));

  // সেফ ডিফল্ট (retry/timeout/backoff)
  const requestTimeoutMs = 12000;
  const blockedBackoffMs = 10 * 60 * 1000;
  const tokenCooldownMs  = 0;
  const retryCount       = 1;

  let sent = 0, okCount = 0, failCount = 0;

  // per-post pointers
  const state = resolvedTargets.map(() => ({ tok:0, cmt:0, name:0, sent:0 }));

  // per-token state
  const tState = new Map();
  const ensureT = (tok) => {
    if (!tState.has(tok)) tState.set(tok,{nextAt:0,hourlyCount:0,windowStart:Date.now(),removed:false,backoff:0});
    return tState.get(tok);
  };

  // একবারে ১টা ফায়ার (তোমার pattern অনুযায়ী)
  async function sendOne(pIdx){
    const tgt = resolvedTargets[pIdx];
    const st  = state[pIdx];
    if (!tgt.tokens.length || !tgt.comments.length) {
      sseLine(sessionId,"warn",`Skipped (missing) on ${tgt.id}`);
      return false;
    }

    const token   = tgt.tokens[st.tok % tgt.tokens.length];
    const comment = tgt.comments[st.cmt % tgt.comments.length];
    const nameArr = tgt.namesList.length ? [tgt.namesList[st.name % tgt.namesList.length]] : [];
    const message = buildCommentWithNames(comment, nameArr);

    const ts = ensureT(token);
    if (ts.removed || Date.now() < ts.nextAt) return false;

    try{
      await Promise.race([
        tgt.type === "comment"
          ? postComment({ token, postId: tgt.id, message })
          : sendMessage({ token, convoId: tgt.id, message }),
        new Promise((_,rej)=>setTimeout(()=>rej({message:"Request timeout"}), requestTimeoutMs))
      ]);

      // If job was aborted while request was in-flight, ignore this success.
      if (getJob(sessionId).abort) {
        // ensure we do not advance pointers or counts
        return true; // signal to stop outer loops
      }

      okCount++; sent++;
      st.sent++; st.tok++; st.cmt++; st.name++;
      ts.hourlyCount++; ts.nextAt = Math.max(ts.nextAt, Date.now() + tokenCooldownMs); ts.backoff=0;
      if (tgt.type === "comment") {
        sseLine(sessionId,"log",`✔ ${tokenName[token]||"Account"} → Comment "${message}" on Post ${tgt.id}`);
      } else if (tgt.type === "message") {
        sseLine(sessionId,"log",`✔ ${tokenName[token]||"Account"} → Message "${message}" to Convo ${tgt.id}`);
      }
    } catch(err){
      failCount++; sent++;
      const cls = classifyError(err);

      if (cls.kind==="INVALID_TOKEN"||cls.kind==="ID_LOCKED"){
        ts.removed = true;
      } else if (cls.kind==="COMMENT_BLOCKED"){
        ts.backoff = Math.min(Math.max(blockedBackoffMs,(ts.backoff||0)*2 || blockedBackoffMs), 30*60*1000);
        ts.nextAt = Math.max(ts.nextAt, Date.now()+ts.backoff);
      } else if (cls.kind==="NO_PERMISSION"){
        ts.nextAt = Math.max(ts.nextAt, Date.now()+60_000);
      }

      // NEW: if no active tokens left anywhere, abort job immediately
      const activeTokens = Array.from(tState ? tState.keys() : []).filter(k => {
        const stt = tState.get(k); return stt && !stt.removed;
      }).length;
      if (activeTokens === 0) {
        getJob(sessionId).abort = true;
        sseLine(sessionId,"error", "All tokens invalid/removed — aborting job.");
        return true; // signal to stop
      }

      if (tgt.type === "comment") {
        sseLine(sessionId,"error",`✖ ${tokenName[token]||"Account"} → Failed Comment (${cls.human}) on Post ${tgt.id}`);
      } else if (tgt.type === "message") {
        sseLine(sessionId,"error",`✖ ${tokenName[token]||"Account"} → Failed Message (${cls.human}) to Convo ${tgt.id}`);
      }
    }
    return (limit && sent>=limit);
  }

  sseLine(sessionId,"info",
    `SUPER FAST → fireGap:${fireGap}ms, roundGap:${roundGap}ms, posts:${P}, totalIds:${totalIds}`
  );

  // ====== ROUNDS (∞ যতক্ষণ না limit/abort) ======
  while(!job.abort && (!limit || sent < limit)){
    // প্রতি রাউন্ডে order reshuffle (leftover shuffle কভার হবে)
    const order = [...Array(P).keys()].sort(()=>Math.random()-0.5);
    for (const t of resolvedTargets){
      if (t.tokens.length   > 1) t.tokens.sort(()=>Math.random()-0.5);
      if (t.comments.length > 1) t.comments.sort(()=>Math.random()-0.5);
      if (t.namesList.length> 1) t.namesList.sort(()=>Math.random()-0.5);
    }

    // round pattern: post1→post2→... (প্রতি ফায়ারের মাঝে fireGap)
    for (const idx of order){
      const stop = await sendOne(idx);
      if (stop) break;
      if (fireGap>0) await sleep(fireGap);
      if (job.abort || (limit && sent>=limit)) break;
    }

    if (job.abort || (limit && sent>=limit)) break;

    // প্রতি রাউন্ড শেষে user-set delay ভাগ করে নেওয়া roundGap
    if (roundGap>0) await sleep(roundGap);
  }

  sseLine(sessionId,"summary",
  `Run finished (Comments+Messages)`,
  { sent: okCount+failCount, ok: okCount, failed: failCount }
);
  const j=getJob(sessionId); j.running=false; j.abort=false;
  sseLine(sessionId,"info","Job closed");
}

// ------------------------------------------------------------
// EXTREME RUNNER
// batchCount = totalIds / postsCount  (min 1, ceil)
// roundGap   = uiDelay / batchCount
// প্রতি ব্যাচে: সব পোস্টে এক রাউন্ড করে "burst" ফায়ার (প্রতি কমেন্টে 80–120ms micro gap)
// ------------------------------------------------------------

async function runJobExtreme({
  sessionId, resolvedTargets, tokenName,
  uiDelayMs, totalIds, postsCount, limit
}) {
  const job = getJob(sessionId);

  // 🔹 Batch Count Calculation
  const batchCount = (postsCount === 1)
    ? totalIds                                // single-post → সব IDs এক burst
    : Math.max(1, Math.ceil(totalIds / Math.max(1, postsCount)));

  const roundGap = Math.max(0, Math.floor(uiDelayMs / batchCount));
  const micro = () => 80 + Math.floor(Math.random() * 41); // 80–120ms

  // 🔹 Safe defaults
  const requestTimeoutMs = 12000;
  const blockedBackoffMs = 10 * 60 * 1000;
  const tokenCooldownMs  = 0;
  const retryCount       = 1;

  let sent = 0, okCount=0, failCount=0;

  // 🔹 per-post pointer
  const state = resolvedTargets.map(() => ({ tok:0, cmt:0, name:0, sent:0 }));

  // 🔹 per-token state
  const tState = new Map();
  const ensureT = (tok) => {
    if (!tState.has(tok)) {
      tState.set(tok,{nextAt:0,hourlyCount:0,windowStart:Date.now(),removed:false,backoff:0});
    }
    return tState.get(tok);
  };

  // 🔹 Fire one
  async function fireOne(pIdx){
    const tgt = resolvedTargets[pIdx];
    const st  = state[pIdx];
    if (!tgt.tokens.length || !tgt.comments.length) {
      sseLine(sessionId,"warn",`Skipped (missing) on ${tgt.id}`);
      return;
    }

    const token   = tgt.tokens[st.tok % tgt.tokens.length];
    const comment = tgt.comments[st.cmt % tgt.comments.length];
    const nameArr = tgt.namesList.length ? [tgt.namesList[st.name % tgt.namesList.length]] : [];
    const message = buildCommentWithNames(comment, nameArr);

    const ts = ensureT(token);
    if (ts.removed || Date.now() < ts.nextAt) return;

    try {
      await Promise.race([
        tgt.type === "comment"
          ? postComment({ token, postId: tgt.id, message })
          : sendMessage({ token, convoId: tgt.id, message }),
        new Promise((_,rej)=>setTimeout(()=>rej({message:"Request timeout"}), requestTimeoutMs))
      ]);

      // If job aborted while in-flight, stop further processing
      if (getJob(sessionId).abort) return;

      okCount++; sent++;
      st.sent++; st.tok++; st.cmt++; st.name++;
      ts.hourlyCount++; ts.nextAt = Math.max(ts.nextAt, Date.now()+tokenCooldownMs); ts.backoff=0;

      if (tgt.type === "comment") {
        sseLine(sessionId,"log",`✔ ${tokenName[token]||"Account"} → Comment "${message}" on Post ${tgt.id}`);
      } else if (tgt.type === "message") {
        sseLine(sessionId,"log",`✔ ${tokenName[token]||"Account"} → Message "${message}" to Convo ${tgt.id}`);
      }
    }catch(err){
      failCount++; sent++;
      const cls = classifyError(err);
      if (cls.kind==="INVALID_TOKEN"||cls.kind==="ID_LOCKED"){ ts.removed = true; }
      else if (cls.kind==="COMMENT_BLOCKED"){
        ts.backoff = Math.min(Math.max(blockedBackoffMs,(ts.backoff||0)*2 || blockedBackoffMs), 30*60*1000);
        ts.nextAt = Math.max(ts.nextAt, Date.now()+ts.backoff);
      } else if (cls.kind==="NO_PERMISSION"){
        ts.nextAt = Math.max(ts.nextAt, Date.now()+60_000);
      }

      // NEW: immediate abort if no active tokens left
      const activeTokens = Array.from(tState ? tState.keys() : []).filter(k => {
        const stt = tState.get(k); return stt && !stt.removed;
      }).length;
      if (activeTokens === 0) {
        getJob(sessionId).abort = true;
        sseLine(sessionId,"error", "All tokens invalid/removed — aborting job.");
      }

      if (tgt.type === "comment") {
        sseLine(sessionId,"error",`✖ ${tokenName[token]||"Account"} → Failed Comment (${cls.human}) on Post ${tgt.id}`);
      } else if (tgt.type === "message") {
        sseLine(sessionId,"error",`✖ ${tokenName[token]||"Account"} → Failed Message (${cls.human}) to Convo ${tgt.id}`);
      }
    }
  }

  // 🔹 Debug Info
  sseLine(sessionId,"info",
    `EXTREME → batch:${batchCount}, roundGap:${roundGap}ms, posts:${postsCount}, totalIds:${totalIds}`
  );

  // ====== INFINITE BATCHES ======
  while(!job.abort && (!limit || sent < limit)){
    if (postsCount === 1) {
      // 🟢 SINGLE-POST MODE (সব IDs এক burst)
      for (let i=0; i<totalIds; i++) {
        await fireOne(0);
        if (limit && sent>=limit) break;
        await sleep(micro()); // প্রতি comment এ 80–120ms gap
      }
    } else {
      // 🟢 MULTI-POST MODE (প্রতি batch এ সব post এ ১টা করে burst fire)
      const order = [...Array(postsCount).keys()].sort(()=>Math.random()-0.5);
      for (const idx of order){
        await fireOne(idx);
        if (limit && sent>=limit) break;
        await sleep(micro()); // burst এর মধ্যে 80–120ms gap
      }
    }

    if (job.abort || (limit && sent>=limit)) break;

    // 🕒 batch শেষে roundGap wait
    if (roundGap>0) await sleep(roundGap);
  }

  // 🔚 Job Summary
  sseLine(sessionId,"summary",
    `Run finished (Comments+Messages)`,
    { sent: okCount+failCount, ok: okCount, failed: failCount }
  );
  const j=getJob(sessionId); j.running=false; j.abort=false;
  sseLine(sessionId,"info","Job closed");
}

// --------------------- Core Run Job (round-parallel + burst + guards) ---------------------
async function runJob(
  job,
  {
    sessionId,
    resolvedTargets,
    tokenName,
    delayMs,
    maxCount,
    // knobs
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
    sseBatchMs = 0
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
            const outc = await attemptWithTimeout(() => {
              if (tgt.type === "comment") {
                return postComment({ token, postId: tgt.id, message });
              } else if (tgt.type === "message") {
                return sendMessage({ token, convoId: tgt.id, message });
              } else {
                throw new Error("Unknown target type: " + tgt.type);
              }
            });

            // NEW guard: if job aborted during in-flight request, ignore
            if (getJob(sessionId).abort) return;

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
          promises.push((async () => {
            try {
              await doSend();
            } catch (err) {
              if (getJob(sessionId).abort) return; // if aborted, ignore errors from in-flight finishes
              failCount++;
              const cls = classifyError(err);
              counters[cls.kind] = (counters[cls.kind] || 0) + 1;

              // mutate token state + publish status
              if (cls.kind === "INVALID_TOKEN" || cls.kind === "ID_LOCKED") {
                if (removeBadTokens) tState.removed = true;
                pushTokenStatus(token, "REMOVED");
                // NEW: if no active tokens left, abort job
                const active = Array.from(tokenState.keys()).filter(k => !tokenState.get(k).removed).length;
                if (active === 0) {
                  getJob(sessionId).abort = true;
                  out("error", "All tokens removed/invalid — aborting job.");
                }
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
          })());
        } // end inner burst loop

        if (usedTimes > 0) {
          advanced.push({ postIdx: pIdx, times: usedTimes });
        }
      } // end per-post loop

      // â€”â€”â€” round settled â€”â€”â€”
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
    } // end while

    if (job.abort) out("warn", "Job aborted by user.");

    out("summary", "Run finished", {
      sent: okCount + failCount,
      ok: okCount,
      failed: failCount,
      counters,
      message: "token expiry / id locked / wrong link / action blocked â€” classified above.",
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
  const sessionId = req.body?.sessionId || req.query?.sessionId || req.cookies?.sid || null;
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

// ---- parse options
const body = req.body || {};

// advanced tuning knobs (override defaults)
const roundJitterMaxMs   = Math.max(0, parseInt(body.roundJitterMaxMs ?? 80));
const tokenCooldownMs    = Math.max(0, parseInt(body.tokenCooldownMs ?? 10));
// inside /start handler (parsing adv knobs)
const quotaPerTokenHour =
  Math.max(0, parseInt(body.quotaPerTokenPerHour ?? body.quotaPerTokenHour ?? 100));
const namesPerComment    = Math.max(1, parseInt(body.namesPerComment ?? 1));
const limitPerPost       = Math.max(0, parseInt(body.limitPerPost ?? 50));

const removeBadTokens    = String(body.removeBadTokens ?? "true").toLowerCase() === "true";
const blockedBackoffMs   = Math.max(0, parseInt(body.blockedBackoffMs ?? 10*60*1000));
const requestTimeoutMs   = Math.max(3000, parseInt(body.requestTimeoutMs ?? 12000));
const retryCount         = Math.max(0, parseInt(body.retryCount ?? 1));
const sseBatchMs         = Math.max(0, parseInt(body.sseBatchMs ?? 600));
const tokenGlobalRing    = String(body.tokenGlobalRing ?? "false").toLowerCase() === "true";

// UI speed mode: fast | superfast | extreme
const speedMode = String(body.speedMode || "fast").toLowerCase();

// base delay from UI (seconds → ms)
let delaySec = parseInt(body.delay, 10);
if (isNaN(delaySec) || delaySec < 0) delaySec = 20;
const delayMs = delaySec * 1000;   // <-- UI থেকে আসা delay, কোনো mode override নেই এখানে

// limit (global)
let limit = parseInt(body.limit, 10);
if (isNaN(limit) || limit < 0) limit = 0;

// shuffle
const shuffle = String(body.shuffle ?? "false").toLowerCase() === "true";

// ---- load per-session files (supports in-memory liveUploads fallback) ----
const sessionDir = path.join(UPLOAD_DIR, sessionId);

// liveUploads should be defined globally earlier:
// const liveUploads = new Map(); // sessionId -> { tokens:[], comments:[], postlinks:[], names:[] }
let fileTokens = [];
let fileComments = [];
let fileLinks = [];
let fileNames = [];

// 1) prefer live in-memory upload if present
const live = (typeof liveUploads !== "undefined") ? liveUploads.get(sessionId) : null;
if (live) {
  fileTokens   = Array.isArray(live.tokens) ? live.tokens.slice() : [];
  fileComments = Array.isArray(live.comments) ? live.comments.slice() : [];
  fileLinks    = Array.isArray(live.postlinks) ? live.postlinks.slice() : [];
  fileNames    = Array.isArray(live.names) ? live.names.slice() : [];
} else {
  // 2) fallback to disk files
  const pTokens   = path.join(sessionDir, "tokens.txt");
  const pCmts     = path.join(sessionDir, "comments.txt");
  const pLinksTxt = path.join(sessionDir, "postlinks.txt");
  const pLinksId  = path.join(sessionDir, "id.txt");
  const pNames    = path.join(sessionDir, "uploadNames.txt");

  const readLines = (p) => (fs.existsSync(p) ? cleanLines(fs.readFileSync(p, "utf-8")) : []);

  fileTokens   = readLines(pTokens);
  fileComments = readLines(pCmts);

  // allow postlinks.txt OR id.txt
  const linksFromFile = fs.existsSync(pLinksTxt) ? readLines(pLinksTxt)
                       : (fs.existsSync(pLinksId) ? readLines(pLinksId) : []);
  fileLinks = (linksFromFile || []).map(cleanPostLink).filter(l => l !== null);

  fileNames = readLines(pNames);
}

// now we have canonical arrays:
// fileTokens, fileComments, fileLinks, fileNames

// pick anyToken for Graph resolver (null if none)
const anyToken = fileTokens.length ? fileTokens[0] : null;

// emit SSE warnings like before
if (!fileTokens.length)   sseLine(sessionId, "warn", "No tokens uploaded for this session.");
if (!fileComments.length) sseLine(sessionId, "warn", "No comments uploaded for this session.");
if (!fileLinks.length)    sseLine(sessionId, "warn", "No post links uploaded for this session.");

  

  // ---- manual posts
  let manualTargets = [];
  if (Array.isArray(body.posts) && body.posts.length) {
    manualTargets = body.posts.slice(0, 4).map(p => ({
      target: p.target || p,                 
      namesTxt: p.names || "",                // âœ… fixed (was namesText mismatch)
      perPostTokensText: p.tokens || "",
      commentPack: p.commentPack || "Default",
      commentsTxt: p.comments || ""
    }));
  }

  // fallback â†’ if no manualTargets, use global postlinks
  if (!manualTargets.length && fileLinks.length) {
    manualTargets = fileLinks.map(lnk => ({
      target: lnk,
      namesTxt: fileNames.join("\n"),
      perPostTokensText: "",
      commentPack: "Default",
    }));
  }

  console.log("ðŸ“‚ File Links from postlinks:", fileLinks);
  console.log("ðŸ“ Manual Posts from body:", body.posts);
  console.log("ðŸŽ¯ Final Manual Targets:", manualTargets);

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

    // âœ… fixed namesTxt usage
    let names = p.namesTxt && p.namesTxt.trim() ? cleanLines(p.namesTxt) : fileNames;

    if (shuffle) {
      if (tokens.length) tokens = shuffleArr(tokens);
      if (comments.length) comments = shuffleArr(comments);
      if (names.length) names = shuffleArr(names);
    }

    return {
      rawTarget: p.target,
      tokens,
      comments,
      namesList: names,
    };
  });

  // ---- resolve targets
  async function resolveOne(tgt) {
  const targetType = detectTargetType(tgt.rawTarget);
  let finalId = null;

  if (targetType === "comment") {
    // -------- Post Resolver --------
    let id = tryExtractGraphPostId(tgt.rawTarget);
    if (!id) id = await resolveViaGraphLookup(tgt.rawTarget, anyToken);
    if (!id) {
      sseLine(sessionId, "warn", `❌ Could not resolve post: ${tgt.rawTarget}`);
      return null;
    }
    id = await refineCommentTarget(id, anyToken);
    finalId = id;
  } else if (targetType === "message") {
    // -------- Messenger Resolver --------
    // এখানে post এর মত জটিল resolver লাগবে না,
    // কারণ convoId সরাসরি use করা যায়।
    finalId = String(tgt.rawTarget).replace(/\D/g, ""); // শুধু সংখ্যা
    if (!/^\d{16,}$/.test(finalId)) {
      sseLine(sessionId, "warn", `❌ Invalid conversationId: ${tgt.rawTarget}`);
      return null;
    }
  } else {
    sseLine(sessionId, "warn", `❌ Unknown target type: ${tgt.rawTarget}`);
    return null;
  }

  return { ...tgt, id: finalId, type: targetType };
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

// ---- start job (REPLACE your old block with this) ----
job.running = true;
job.abort = false;

res.json({ ok: true, message: "Job started" });

const totalIds = resolvedTargets.reduce(
  (n, t) => n + Math.min(t.tokens.length, t.comments.length),
  0
);

sseLine(
  sessionId,
  "info",
  `Starting… mode:${speedMode}, posts:${resolvedTargets.length}, ids:${totalIds}, delay:${delaySec}s, limit:${limit || "∞"}, shuffle:${shuffle}`
);

// ⚡ dispatch by speed mode (fire-and-forget; NO await)
if (speedMode === "superfast") {
  // NOTE: runJobSuperFast() অবশ্যই ডিফাইন থাকতে হবে (next স্টেপে দিলে এই মোড ইউজ কোরো না)
  runJobSuperFast({
    sessionId,
    resolvedTargets,
    tokenName,
    uiDelayMs: delayMs,
    totalIds,
    limit
  });
} else if (speedMode === "extreme") {
  runJobExtreme({
    sessionId,
    resolvedTargets,
    tokenName,
    uiDelayMs: delayMs,
    totalIds,
    postsCount: resolvedTargets.length,
    limit
  });
} else {
  // default FAST
  runJob(job, {
    sessionId,
    resolvedTargets,
    tokenName,
    delayMs,
    maxCount: limit
  });
}
});


// -------------------- Boot --------------------
connectMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Mongo connection failed:", err);
    process.exit(1);
  });

         
