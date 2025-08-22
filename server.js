// server.js
/**
 * Facebook Auto Comment Tool (Pro, single-file)
 * - Static: serves / from /public (your index/style/script)
 * - Upload: /upload (tokens/comments/postlinks)
 * - Resolver: /resolveLink (pfbid, story.php, posts, groups/permalink)
 * - SSE logs: /events (types: log/info/warn/error/success/summary)
 * - Start/Stop: /start /stop (delay, limit, shuffle)
 * - Graph API comment + strong error classifier:
 *   INVALID_TOKEN, ID_LOCKED, COMMENT_BLOCKED, WRONG_POST_ID, NO_PERMISSION, RATE_LIMIT, UNKNOWN
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { randomUUID } = require("crypto");

// -------------------- App setup --------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// serve your index/style/script from public
app.use(express.static(PUBLIC_DIR));

// -------------------- Cookie session --------------------
app.use((req, res, next) => {
  let sid = req.cookies?.sid;
  if (!sid) {
    sid = randomUUID();
    res.cookie("sid", sid, { httpOnly: false, maxAge: 180 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  }
  req.sessionId = sid;
  next();
});

// -------------------- Small utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (txt) => txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

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
    try { res.write(payload); } catch {}
  }
}
function sseLine(sessionId, type, text, extra = {}) {
  sseBroadcast(sessionId, { t: Date.now(), type, text, ...extra });
}

// -------------------- Upload setup --------------------
const upload = multer({ dest: UPLOAD_DIR });

app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
  ]),
  (req, res) => {
    const sessionId = req.query.sessionId || req.body.sessionId || req.sessionId || null;
    if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

    try {
      if (req.files?.tokens?.[0]) fs.renameSync(req.files.tokens[0].path, path.join(UPLOAD_DIR, "token.txt"));
      if (req.files?.comments?.[0]) fs.renameSync(req.files.comments[0].path, path.join(UPLOAD_DIR, "comment.txt"));
      if (req.files?.postlinks?.[0]) fs.renameSync(req.files.postlinks[0].path, path.join(UPLOAD_DIR, "postlink.txt"));

      const tCount = fs.existsSync(path.join(UPLOAD_DIR, "token.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "token.txt"), "utf-8")).length : 0;
      const cCount = fs.existsSync(path.join(UPLOAD_DIR, "comment.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "comment.txt"), "utf-8")).length : 0;
      const pCount = fs.existsSync(path.join(UPLOAD_DIR, "postlink.txt"))
        ? cleanLines(fs.readFileSync(path.join(UPLOAD_DIR, "postlink.txt"), "utf-8")).length : 0;

      sseLine(sessionId, "success", `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount})`);
      res.json({ ok: true, tokens: tCount, comments: cCount, postlinks: pCount });
    } catch (e) {
      sseLine(sessionId, "error", `Upload failed: ${e.message}`);
      res.status(500).json({ ok: false, message: "Upload failed", error: e.message });
    }
  }
);

// ----------------- FB Link Resolver -----------------
function base58Decode(str) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(0);
  for (let char of str) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error("Invalid base58 char");
    num = num * BigInt(58) + BigInt(idx);
  }
  return num.toString();
}
function pfbidToPostId(pfbid) {
  let clean = pfbid.replace(/^pfbid/i, "");
  clean = clean.replace(/[_-]/g, "");
  const decoded = base58Decode(clean);
  // Heuristic: last 16 digits typically contain object id
  return decoded.slice(-16);
}
function tryResolveFromUrlLike(link) {
  try {
    const url = new URL(link);
    // story.php?story_fbid=XXX&id=YYY
    if (/story\.php/i.test(url.pathname)) {
      const postId = url.searchParams.get("story_fbid");
      const userId = url.searchParams.get("id");
      if (postId) return { postId, userId: userId || null };
    }
    // /{userId}/posts/{postId}
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("posts");
    if (idx !== -1 && parts[idx + 1]) {
      const userId = parts[idx - 1] || null;
      const postId = parts[idx + 1];
      return { postId, userId };
    }
    // groups/{gid}/permalink/{pid}
    const g = url.pathname.match(/\/groups\/(\d+)\/permalink\/(\d+)/i);
    if (g) return { postId: g[2], userId: g[1] };

    // pfbid in url
    const pfb = link.match(/(pfbid[A-Za-z0-9]+)/);
    if (pfb) return { postId: pfbidToPostId(pfb[1]), userId: null };

    // fbid param
    const fbid = url.searchParams.get("fbid");
    if (fbid) return { postId: fbid, userId: null };

    return { postId: null, userId: null };
  } catch {
    // not a URL → maybe raw pfbid or raw numeric
    if (/^\d+(_\d+)?$/.test(link)) return { postId: link, userId: null };
    const p = link.match(/^(pfbid[A-Za-z0-9]+)/i);
    if (p) return { postId: pfbidToPostId(p[1]), userId: null };
    return { postId: null, userId: null };
  }
}

app.post("/resolveLink", (req, res) => {
  try {
    const { link } = req.body || {};
    if (!link) return res.json({ success: false, error: "No link provided" });
    const { postId, userId } = tryResolveFromUrlLike(link);
    if (!postId) return res.json({ success: false, error: "Could not resolve post id" });
    res.json({ success: true, postId, userId });
  } catch (err) {
    console.error("resolveLink error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- Graph helpers --------------------
async function getAccountName(token) {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me?fields=name&access_token=${encodeURIComponent(token)}`);
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
  // Token/Session
  if (code === 190 || msg.includes("access token") || msg.includes("session has expired") || msg.includes("expired")) {
    return { kind: "INVALID_TOKEN", human: "Invalid or expired token" };
  }
  // Account locked / checkpoint
  if (msg.includes("checkpoint") || msg.includes("locked") || msg.includes("suspended") || msg.includes("confirm your identity")) {
    return { kind: "ID_LOCKED", human: "Account locked/checkpoint" };
  }
  // Permission issues
  if (msg.includes("permission") || msg.includes("insufficient") || msg.includes("not authorized")) {
    return { kind: "NO_PERMISSION", human: "Missing permission to comment" };
  }
  // Wrong / inaccessible post
  if (msg.includes("not found") || msg.includes("unsupported") || msg.includes("cannot be accessed") || msg.includes("does not exist")) {
    return { kind: "WRONG_POST_ID", human: "Wrong or inaccessible post id/link" };
  }
  // Rate / Action blocked
  if (msg.includes("temporarily blocked") || msg.includes("reduced") || msg.includes("rate limit") || msg.includes("user request limit reached") || msg.includes("try again later")) {
    return { kind: "COMMENT_BLOCKED", human: "Comment blocked or rate limited" };
  }
  // Generic throttle
  if (msg.includes("rate")) {
    return { kind: "RATE_LIMIT", human: "Rate limit" };
  }
  return { kind: "UNKNOWN", human: err?.message || "Unknown error" };
}

// -------------------- SSE endpoint --------------------
app.get("/events", (req, res) => {
  const sessionId = req.query.sessionId || req.sessionId || randomUUID();
  if (!req.cookies?.sid || req.cookies.sid !== sessionId) {
    res.cookie("sid", sessionId, { httpOnly: false, maxAge: 180 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  }
  const job = getJob(sessionId);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  job.clients.add(res);
  sseLine(sessionId, "ready", "SSE connected");

  req.on("close", () => {
    job.clients.delete(res);
  });
});

// -------------------- Start/Stop job --------------------
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

  const job = getJob(sessionId);
  if (job.running) return res.status(409).json({ ok: false, message: "Another job is running. Stop it first." });

  const {
    postId = "",
    link1 = "",
    link2 = "",
    link3 = "",
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

      if (!tokens.length) { sseLine(sessionId, "error", "No tokens in token.txt"); return; }
      if (!comments.length) { sseLine(sessionId, "error", "No comments in comment.txt"); return; }
      if (!inputs.length) { sseLine(sessionId, "error", "No Post ID/Link provided (form or postlink.txt)"); return; }

      // Account names
      sseLine(sessionId, "info", `Resolving account names for ${tokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < tokens.length; i++) {
        if (job.abort) { sseLine(sessionId, "warn", "Aborted while resolving names."); return; }
        try { tokenName[tokens[i]] = await getAccountName(tokens[i]); }
        catch { tokenName[tokens[i]] = `Account#${i + 1}`; }
        await sleep(120);
      }

      // Resolve links → final comment ids
      sseLine(sessionId, "info", `Resolving ${inputs.length} post link/id(s)...`);
      const resolvedPosts = [];
      const wrongLinks = [];

      for (const raw of inputs) {
        if (job.abort) { sseLine(sessionId, "warn", "Aborted while resolving posts."); return; }
        const { postId: pid } = tryResolveFromUrlLike(raw);
        if (pid) {
          resolvedPosts.push({ raw, id: pid });
          sseLine(sessionId, "info", `Resolved: ${raw} → ${pid}`);
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

      // Shuffle comments if requested
      const doShuffle = String(useShuffle) === "true";
      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
        }
      }

      const delayMs = Math.max(0, parseInt(delay, 10) || 0) * 1000;
      const maxCount = Math.max(0, parseInt(limit, 10) || 0);

      let okCount = 0, failCount = 0;
      const counters = {
        INVALID_TOKEN: 0,
        WRONG_POST_ID: 0,
        NO_PERMISSION: 0,
        COMMENT_BLOCKED: 0,
        ID_LOCKED: 0,
        RATE_LIMIT: 0,
        UNKNOWN: 0,
      };

      sseLine(sessionId, "info", `Delay: ${delayMs / 1000}s, Limit: ${maxCount || "∞"}`);

      // mixed loop round-robin across tokens/comments/posts
      let sent = 0, i = 0;
      while (!job.abort && (!maxCount || sent < maxCount)) {
        const token = tokens[i % tokens.length];
        const comment = comments[i % comments.length];
        const post = resolvedPosts[i % resolvedPosts.length];
        const acc = tokenName[token] || `Account#${(i % tokens.length) + 1}`;

        try {
          const out = await postComment({ token, postId: post.id, message: comment });
          okCount++; sent++;
          sseLine(sessionId, "log", `✔ ${acc} → "${comment}" on ${post.id}`, {
            account: acc, comment, postId: post.id, resultId: out.id || null,
          });
        } catch (err) {
          failCount++; sent++;
          const cls = classifyError(err);
          counters[cls.kind] = (counters[cls.kind] || 0) + 1;

          // Error → warning box friendly lines
          sseLine(sessionId, "error", `✖ ${acc} → ${cls.human} (${post.id})`, {
            account: acc, postId: post.id, errKind: cls.kind, errMsg: err.message || String(err),
          });
        }

        if (delayMs > 0 && !job.abort) await sleep(delayMs);
        i++;
      }

      if (job.abort) sseLine(sessionId, "warn", "Job aborted by user.");

      sseLine(sessionId, "summary", "Run finished", {
        sent: okCount + failCount,
        ok: okCount,
        failed: failCount,
        counters,
        unresolvedLinks: wrongLinks.length,
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

// -------------------- Health --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------------------- Boot --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
