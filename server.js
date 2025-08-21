// server.js
/**
 * Facebook Auto Comment Tool (v2.0)
 * - tokens/comments/postlinks txt + manual fields (UI অপরিবর্তিত)
 * - pfbid/various links → numeric ID resolver (Graph Lookup + pfbid canonicalizer)
 * - real Graph API comments + delay/limit/shuffle + stop + SSE logs
 * - error/warning classification
 * - Multi-user sessions via sessionId (per-SSE connection)
 */

const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const fetch   = require("node-fetch");
const cors    = require("cors");
const { randomUUID } = require("crypto");

// -------------------- App setup --------------------
const app  = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });

// Serve index.html (তোমার index views/index.html এ আছে)
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// -------------------- Multi-user SSE state --------------------
/** jobs: Map<sessionId, { running:boolean, abort:boolean, clients:Set<res> }> */
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

// -------------------- Helpers --------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanLines = (txt) => txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Detect bare pfbid string (no URL)
const PFBID_RE = /^(pfbid[a-zA-Z0-9]+)$/i;
// Detect pfbid anywhere inside a URL/path
const PFBID_IN_TEXT_RE = /(pfbid[a-zA-Z0-9]+)/i;

/**
 * If input is a bare pfbid or a URL containing pfbid, return a canonical URL
 * that Graph Lookup can resolve reliably.
 * Examples:
 *   "pfbid02ABC..."        -> "https://www.facebook.com/pfbid02ABC..."
 *   "https://fb.com/.../pfbid02ABC.../?" -> original URL returned as-is
 */
function canonicalizePfbidInput(raw) {
  if (!raw) return null;

  // If it's already a URL, just return raw; Graph lookup will handle it.
  try {
    const u = new URL(raw);
    // safety: ensure it contains pfbid → then use as-is
    if (PFBID_IN_TEXT_RE.test(raw)) return u.toString();
    // not a pfbid URL → let caller handle normally
    return raw;
  } catch {
    // Not a URL. If it's a bare pfbid, make a canonical URL.
    const m = String(raw).trim().match(PFBID_RE);
    if (m) {
      return `https://www.facebook.com/${m[1]}`;
    }
    return raw;
  }
}

// QUICK parser (no network) → id-like
function tryExtractGraphPostId(raw) {
  if (!raw) return null;

  // already numeric or actor_post
  if (/^\d+$/.test(raw) || /^\d+_\d+$/.test(raw)) return raw;

  try {
    const u = new URL(raw);

    // story.php?story_fbid=POST&id=ACTOR → ACTOR_POST
    const story = u.searchParams.get("story_fbid");
    const actor = u.searchParams.get("id");
    if (story && actor && /^\d+$/.test(story) && /^\d+$/.test(actor)) {
      return `${actor}_${story}`;
    }

    // /<actorId>/posts/<postId>
    let m = u.pathname.match(/^\/(\d+)\/posts\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;

    // groups permalink: /groups/<groupId>/permalink/<postId>
    m = u.pathname.match(/^\/groups\/(\d+)\/permalink\/(\d+)/);
    if (m) return `${m[1]}_${m[2]}`;

    // photos (object id): /photo.php?fbid=<object_id>
    const fbid = u.searchParams.get("fbid");
    if (fbid && /^\d+$/.test(fbid)) return fbid;

    // pfbid লিংক হলে এখানে numeric বের হয় না → network resolver লাগবে
    return null;
  } catch {
    return null;
  }
}

// GRAPH lookup (?id=link) → prefer og_object.id, else id
async function resolveViaGraphLookup(linkOrPfbidLike, token) {
  // pfbid হলে canonical URL তৈরি করো
  const normalized = canonicalizePfbidInput(linkOrPfbidLike);
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(normalized)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(api);
  const json = await res.json();
  if (json?.og_object?.id) return String(json.og_object.id);
  if (json?.id)             return String(json.id);
  return null;
}

// refine: id → comment target (photo হলে object_id তে comment করা ভাল)
async function refineCommentTarget(id, token) {
  try {
    // actor_post (######_######) হলে সাধারণত সরাসরি id তেই কাজ হয়
    if (/^\d+_\d+$/.test(id)) return id;

    const ep = `https://graph.facebook.com/v19.0/${encodeURIComponent(id)}?fields=object_id,status_type,from,permalink_url&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(ep);
    const json = await res.json();

    if (json?.object_id && /^\d+$/.test(String(json.object_id))) {
      // photo/video attachment হলে object_id তে comment করা reliable
      return String(json.object_id);
    }
    return id;
  } catch {
    return id;
  }
}

// master resolver: anything → final commentable id
async function resolveAnyToCommentId(raw, token) {
  // 1) quick parse first (no network)
  let pid = tryExtractGraphPostId(raw);
  if (!pid) {
    // 2) network resolve (?id=link) — pfbid হলে canonical URL use করবে
    pid = await resolveViaGraphLookup(raw, token);
  }
  if (!pid) return null;

  // 3) refine (object_id vs post id)
  const finalId = await refineCommentTarget(pid, token);
  return finalId;
}

// name for token (for UI log)
async function getAccountName(token) {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me?fields=name&access_token=${encodeURIComponent(token)}`);
    const j = await res.json();
    return j?.name || "Unknown Account";
  } catch {
    return "Unknown Account";
  }
}

// real comment call
async function postComment({ token, postId, message }) {
  const url  = `https://graph.facebook.com/v19.0/${encodeURIComponent(postId)}/comments`;
  const body = new URLSearchParams({ message, access_token: token });
  const res  = await fetch(url, { method: "POST", body });
  const json = await res.json();
  if (!res.ok || json?.error) {
    const err = json?.error || { message: `HTTP ${res.status}` };
    throw err;
  }
  if (!json?.id) throw { message: "Comment id missing in response" };
  return json; // { id: "<comment_id>" }
}

// error classifier (UI friendly)
function classifyError(err) {
  const code = err?.code || err?.error_subcode || 0;
  const msg  = (err?.message || "").toLowerCase();
  if (code === 190 || msg.includes("expired")) return { kind: "INVALID_TOKEN",   human: "Invalid or expired token" };
  if (msg.includes("permission") || msg.includes("insufficient"))
    return { kind: "NO_PERMISSION",   human: "Missing permission to comment" };
  if (msg.includes("not found") || msg.includes("unsupported") || msg.includes("cannot be accessed"))
    return { kind: "WRONG_POST_ID",   human: "Wrong or inaccessible post id/link" };
  if (msg.includes("temporarily blocked") || msg.includes("rate limit") || msg.includes("reduced"))
    return { kind: "COMMENT_BLOCKED", human: "Comment blocked or rate limited" };
  if (msg.includes("checkpoint") || msg.includes("locked"))
    return { kind: "ID_LOCKED",       human: "Account locked/checkpoint" };
  return { kind: "UNKNOWN", human: err?.message || "Unknown error" };
}

// -------------------- Routes --------------------

// SSE for live logs (per session)
app.get("/events", (req, res) => {
  const sessionId = req.query.sessionId || randomUUID();
  const job = getJob(sessionId);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();

  job.clients.add(res);

  res.write(`event: session\n`);
  res.write(`data: ${sessionId}\n\n`);
  sseLine(sessionId, "ready", "SSE connected");

  req.on("close", () => {
    job.clients.delete(res);
  });
});

// Upload tokens/comments/postlinks
app.post(
  "/upload",
  upload.fields([
    { name: "tokens",    maxCount: 1 },
    { name: "comments",  maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
  ]),
  (req, res) => {
    const sessionId = req.query.sessionId || req.body.sessionId || null;

    try {
      if (req.files?.tokens?.[0])
        fs.renameSync(req.files.tokens[0].path,   path.join("uploads", "token.txt"));
      if (req.files?.comments?.[0])
        fs.renameSync(req.files.comments[0].path, path.join("uploads", "comment.txt"));
      if (req.files?.postlinks?.[0])
        fs.renameSync(req.files.postlinks[0].path, path.join("uploads", "postlink.txt"));

      const tCount = fs.existsSync("uploads/token.txt")
        ? cleanLines(fs.readFileSync("uploads/token.txt", "utf-8")).length : 0;
      const cCount = fs.existsSync("uploads/comment.txt")
        ? cleanLines(fs.readFileSync("uploads/comment.txt", "utf-8")).length : 0;
      const pCount = fs.existsSync("uploads/postlink.txt")
        ? cleanLines(fs.readFileSync("uploads/postlink.txt", "utf-8")).length : 0;

      if (sessionId) sseLine(sessionId, "info", `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount})`);
      res.json({ ok: true, tokens: tCount, comments: cCount, postlinks: pCount });
    } catch (e) {
      if (sessionId) sseLine(sessionId, "error", `Upload failed: ${e.message}`);
      res.status(500).json({ ok: false, message: "Upload failed", error: e.message });
    }
  }
);

// Stop job
app.post("/stop", (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

  const job = getJob(sessionId);
  if (job.running) {
    job.abort = true;
    sseLine(sessionId, "warn", "Stop requested by user");
    return res.json({ ok: true, message: "Stopping..." });
  }
  res.json({ ok: true, message: "No active job" });
});

// Start job
app.post("/start", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, message: "sessionId required" });

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
    useShuffle = "false"
  } = req.body;

  // ACK immediately
  res.json({ ok: true, message: "Started" });

  (async () => {
    try {
      job.running = true;
      job.abort   = false;

      sseLine(sessionId, "info", "Job started (v2.0)");

      // Load txt files
      const pToken = path.join("uploads", "token.txt");
      const pCmt   = path.join("uploads", "comment.txt");
      const pLinks = path.join("uploads", "postlink.txt");

      if (!fs.existsSync(pToken))  { sseLine(sessionId, "error", "token.txt missing. Upload first.");  return; }
      if (!fs.existsSync(pCmt))    { sseLine(sessionId, "error", "comment.txt missing. Upload first."); return; }

      let tokens   = cleanLines(fs.readFileSync(pToken, "utf-8"));
      let comments = cleanLines(fs.readFileSync(pCmt, "utf-8"));
      let manual   = [postId, link1, link2, link3].filter(Boolean);
      let filelnk  = fs.existsSync(pLinks) ? cleanLines(fs.readFileSync(pLinks, "utf-8")) : [];
      let inputs   = [...manual, ...filelnk];

      if (!tokens.length)   { sseLine(sessionId, "error", "No tokens in token.txt");   return; }
      if (!comments.length) { sseLine(sessionId, "error", "No comments in comment.txt"); return; }
      if (!inputs.length)   { sseLine(sessionId, "error", "No Post ID/Link provided (form or postlink.txt)"); return; }

      // Resolve account names
      sseLine(sessionId, "info", `Resolving account names for ${tokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < tokens.length; i++) {
        if (job.abort) { sseLine(sessionId, "warn", "Aborted while resolving names."); return; }
        try { tokenName[tokens[i]] = await getAccountName(tokens[i]); }
        catch { tokenName[tokens[i]] = `Account#${i+1}`; }
        await sleep(150);
      }

      // Resolve links → final comment ids
      sseLine(sessionId, "info", `Resolving ${inputs.length} post link/id(s)...`);
      const resolvedPosts = [];
      const wrongLinks = [];
      const resolverToken = tokens[0]; // প্রথম token দিয়ে resolve

      for (const raw of inputs) {
        if (job.abort) { sseLine(sessionId, "warn", "Aborted while resolving posts."); return; }

        let finalId = null;

        // quick path (numeric / actor_post / classic URLs)
        const quick = tryExtractGraphPostId(raw);
        if (quick) {
          finalId = await refineCommentTarget(quick, resolverToken);
        } else {
          // network resolve (works for pfbid too via canonicalizePfbidInput)
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

      // shuffle comments?
      const doShuffle = String(useShuffle) === "true";
      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
        }
      }

      const delayMs  = Math.max(0, parseInt(delay, 10) || 0) * 1000;
      const maxCount = Math.max(0, parseInt(limit, 10) || 0);

      let okCount = 0, failCount = 0;
      const counters = { INVALID_TOKEN:0, WRONG_POST_ID:0, NO_PERMISSION:0, COMMENT_BLOCKED:0, ID_LOCKED:0, UNKNOWN:0 };

      sseLine(sessionId, "info", `Delay: ${delayMs/1000}s, Limit: ${maxCount || "∞"}`);

      // === Mixed loop ===
      let count = 0;
      let i = 0;

      while (!job.abort && (!maxCount || count < maxCount)) {
        const token   = tokens[i % tokens.length];
        const comment = comments[i % comments.length];
        const post    = resolvedPosts[i % resolvedPosts.length];
        const acc     = tokenName[token] || `Account#${(i % tokens.length) + 1}`;

        try {
          const out = await postComment({ token, postId: post.id, message: comment });
          okCount++; count++;
          sseLine(sessionId, "log", `✔ ${acc} → "${comment}" on ${post.id}`, {
            account: acc,
            comment,
            postId: post.id,
            resultId: out.id || null
          });
        } catch (err) {
          failCount++; count++;
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
        sent, ok: okCount, failed: failCount, counters,
        unresolvedLinks: wrongLinks.length
      });
    } catch (e) {
      sseLine(sessionId, "error", `Fatal: ${e.message || e}`);
    } finally {
      job.running = false;
      job.abort   = false;
      sseLine(sessionId, "info", "Job closed");
    }
  })();
});

// -------------------- Boot --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
