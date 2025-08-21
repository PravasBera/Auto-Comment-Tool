// server.js
/**
 * Facebook Auto Comment Tool (v2.0)
 * - Static: / -> views/index.html, /admin -> public/admin.html
 * - Cookie sid + /session + /events (named events: session, user, log/info/warn/error/success/summary)
 * - Multi-user: data/users.json (pending/approved/blocked + expiry + notes)
 * - Admin auth: /admin/login (JWT + bcrypt) + protected routes (/admin/users ... approve/block/unblock/expire)
 * - Upload tokens/comments/postlinks
 * - Start/Stop job with delay/limit/shuffle
 * - FB link→commentable id resolver (pfbid, story.php, groups, photos, numeric, actor_post)
 * - Error classifier + per-session SSE clients
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { randomUUID } = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

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
const USERS_DB = path.join(DATA_DIR, "users.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(VIEWS_DIR)) fs.mkdirSync(VIEWS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(USERS_DB)) fs.writeFileSync(USERS_DB, JSON.stringify({}), "utf-8");

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

// -------------------- User DB helpers --------------------
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_DB, "utf-8"));
  } catch {
    return {};
  }
}
function saveUsers(db) {
  fs.writeFileSync(USERS_DB, JSON.stringify(db, null, 2), "utf-8");
}
function ensureUser(sessionId) {
  const db = loadUsers();
  if (!db[sessionId]) {
    const now = Date.now();
    db[sessionId] = {
      sessionId,
      status: "pending", // pending | approved | blocked
      blocked: false,
      expiry: null,      // ms timestamp or null
      notes: "",
      createdAt: now,
      updatedAt: now
    };
    saveUsers(db);
  }
  return db[sessionId];
}
function setUser(sessionId, patch = {}) {
  const db = loadUsers();
  if (!db[sessionId]) return null;
  db[sessionId] = { ...db[sessionId], ...patch, updatedAt: Date.now() };
  saveUsers(db);
  return db[sessionId];
}
function getUser(sessionId) {
  const db = loadUsers();
  return db[sessionId] || null;
}
function isUserAllowed(u) {
  if (!u) return { ok: false, reason: "UNKNOWN_USER" };
  if (u.status === "blocked" || u.blocked) return { ok: false, reason: "BLOCKED" };
  if (u.status !== "approved") return { ok: false, reason: "PENDING" };
  if (u.expiry && Date.now() > Number(u.expiry)) return { ok: false, reason: "EXPIRED" };
  return { ok: true };
}

// -------------------- Cookie session --------------------
app.use((req, res, next) => {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie("sid", sid, { httpOnly: false, maxAge: 180 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  }
  req.sessionId = sid;
  ensureUser(sid);
  next();
});

// -------------------- Small utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

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
    let m = u.pathname.match(/^\/(\d+)\/posts\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;
    m = u.pathname.match(/^\/groups\/(\d+)\/permalink\/(\d+)/);
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
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(normalized)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(api);
  const json = await res.json();
  if (json?.og_object?.id) return String(json.og_object.id);
  if (json?.id) return String(json.id);
  return null;
}
async function refineCommentTarget(id, token) {
  try {
    if (/^\d+_\d+$/.test(id)) return id;
    const ep = `https://graph.facebook.com/v19.0/${encodeURIComponent(id)}?fields=object_id,status_type,from,permalink_url&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(ep);
    const json = await res.json();
    if (json?.object_id && /^\d+$/.test(String(json.object_id))) return String(json.object_id);
    return id;
  } catch {
    return id;
  }
}
async function resolveAnyToCommentId(raw, token) {
  let pid = tryExtractGraphPostId(raw);
  if (!pid) pid = await resolveViaGraphLookup(raw, token);
  if (!pid) return null;
  const finalId = await refineCommentTarget(pid, token);
  return finalId;
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
  if (code === 190 || msg.includes("expired")) return { kind: "INVALID_TOKEN", human: "Invalid or expired token" };
  if (msg.includes("permission") || msg.includes("insufficient"))
    return { kind: "NO_PERMISSION", human: "Missing permission to comment" };
  if (msg.includes("not found") || msg.includes("unsupported") || msg.includes("cannot be accessed"))
    return { kind: "WRONG_POST_ID", human: "Wrong or inaccessible post id/link" };
  if (msg.includes("temporarily blocked") || msg.includes("rate limit") || msg.includes("reduced"))
    return { kind: "COMMENT_BLOCKED", human: "Comment blocked or rate limited" };
  if (msg.includes("checkpoint") || msg.includes("locked"))
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

app.get("/session", (req, res) => {
  const sid = req.sessionId;
  const u = ensureUser(sid);
  res.json({ id: sid, status: u.status, expiry: u.expiry, blocked: u.blocked });
});

app.get("/whoami", (req, res) => {
  const u = ensureUser(req.sessionId);
  res.json({ ok: true, user: u });
});

// -------------------- SSE endpoint --------------------
app.get("/events", (req, res) => {
  let sessionId = req.query.sessionId || req.sessionId || randomUUID();
  if (!req.cookies?.sid || req.cookies.sid !== sessionId) {
    res.cookie("sid", sessionId, { httpOnly: false, maxAge: 180 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  }
  const job = getJob(sessionId);
  const user = ensureUser(sessionId);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();

  job.clients.add(res);

  // named events: session, user
  res.write(`event: session\n`);
  res.write(`data: ${sessionId}\n\n`);

  res.write(`event: user\n`);
  res.write(
    `data: ${JSON.stringify({ sessionId, status: user.status, blocked: user.blocked, expiry: user.expiry })}\n\n`
  );

  sseLine(sessionId, "ready", "SSE connected");

  req.on("close", () => {
    job.clients.delete(res);
  });
});

// -------------------- Admin auth (JWT + bcrypt) --------------------
const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_123"; // CHANGE in production
const ADMIN_USER = {
  username: "admin",
  passwordHash: "$2b$10$GH8GMI9motK1Njx7kFa4P.e.w/1SiMTQlfGac/7BEfNJSk8aZX5pi" // 👉 এখানে তোমার hash বসাও
};

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER.username) return res.json({ ok: false, message: "Invalid username" });
  const ok = await bcrypt.compare(password || "", ADMIN_USER.passwordHash);
  if (!ok) return res.json({ ok: false, message: "Invalid password" });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });
  res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ ok: false, message: "No token" });
  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ ok: false, message: "Invalid token" });
  }
}

// -------------------- Admin protected APIs --------------------
app.get("/admin/users", requireAdmin, (_req, res) => {
  res.json(loadUsers());
});
app.post("/admin/approve", requireAdmin, (req, res) => {
  const { sessionId, days = 30, notes = "" } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });
  ensureUser(sessionId);
  const expiry = days ? Date.now() + Number(days) * 24 * 60 * 60 * 1000 : null;
  const out = setUser(sessionId, { status: "approved", blocked: false, expiry, notes });
  res.json({ ok: true, user: out });
});
app.post("/admin/block", requireAdmin, (req, res) => {
  const { sessionId, notes = "" } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });
  ensureUser(sessionId);
  const out = setUser(sessionId, { status: "blocked", blocked: true, notes });
  res.json({ ok: true, user: out });
});
app.post("/admin/unblock", requireAdmin, (req, res) => {
  const { sessionId, notes = "" } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });
  ensureUser(sessionId);
  const out = setUser(sessionId, { status: "pending", blocked: false, notes });
  res.json({ ok: true, user: out });
});
app.post("/admin/expire", requireAdmin, (req, res) => {
  const { sessionId, at = null } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });
  ensureUser(sessionId);
  const expiry = at ? Number(at) : Date.now();
  const out = setUser(sessionId, { expiry });
  res.json({ ok: true, user: out });
});

// -------------------- Upload (protected by user access) --------------------
app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 }
  ]),
  (req, res) => {
    const sessionId = req.query.sessionId || req.body.sessionId || req.sessionId || null;
    if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

    const user = ensureUser(sessionId);
    const allowed = isUserAllowed(user);
    if (!allowed.ok) {
      sseLine(sessionId, "error", `Access denied for upload: ${allowed.reason}`);
      return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
    }

    try {
      if (req.files?.tokens?.[0]) fs.renameSync(req.files.tokens[0].path, path.join(UPLOAD_DIR, "token.txt"));
      if (req.files?.comments?.[0]) fs.renameSync(req.files.comments[0].path, path.join(UPLOAD_DIR, "comment.txt"));
      if (req.files?.postlinks?.[0]) fs.renameSync(req.files.postlinks[0].path, path.join(UPLOAD_DIR, "postlink.txt"));

      const tCount = fs.existsSync(path.join(UPLOAD_DIR, "token.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "token.txt"), "utf-8")).length
        : 0;
      const cCount = fs.existsSync(path.join(UPLOAD_DIR, "comment.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "comment.txt"), "utf-8")).length
        : 0;
      const pCount = fs.existsSync(path.join(UPLOAD_DIR, "postlink.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "postlink.txt"), "utf-8")).length
        : 0;

      sseLine(sessionId, "info", `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount})`);
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

  const user = ensureUser(sessionId);
  const allowed = isUserAllowed(user);
  if (!allowed.ok) {
    sseLine(sessionId, "error", `Access denied: ${allowed.reason}`);
    return res.status(403).json({ ok: false, message: "Not allowed", reason: allowed.reason });
  }

  const job = getJob(sessionId);
  if (job.running) {
    return res.status(409).json({ ok: false, message: "Another job is running. Stop it first." });
  }

  const { postId = "", link1 = "", link2 = "", link3 = "", delay = "5", limit = "0", useShuffle = "false" } =
    req.body;

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
        await sleep(150);
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
        await sleep(120);
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
      const counters = { INVALID_TOKEN: 0, WRONG_POST_ID: 0, NO_PERMISSION: 0, COMMENT_BLOCKED: 0, ID_LOCKED: 0, UNKNOWN: 0 };

      sseLine(sessionId, "info", `Delay: ${delayMs / 1000}s, Limit: ${maxCount || "∞"}`);

      // mixed loop
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
            resultId: out.id || null
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
            errMsg: err.message || String(err)
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
        unresolvedLinks: wrongLinks.length
      });
    } catch (e) {
      sseLine(sessionId, "error", `Fatal: ${e.message || e}`);
    } finally {
      job.running = false;
      job.abort = false;
      sseLine(sessionId, "info", "Job closed");
    }
  })();
});

// -------------------- Boot --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
