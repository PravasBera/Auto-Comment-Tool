// server.js
/**
 * Facebook Auto Comment Tool (v1.6)
 * - tokens/comments/postlinks txt + manual fields (UI অপরিবর্তিত)
 * - pfbid/various links → numeric ID resolver
 * - real Graph API comments + delay/limit/shuffle + stop + SSE logs
 * - error/warning classification
 */

const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const fetch   = require("node-fetch");
const cors    = require("cors");

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

// -------------------- SSE state --------------------
let currentJob = { running: false, abort: false, clients: new Set() };

function sseBroadcast(payloadObj) {
  const payload = `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of currentJob.clients) {
    try { res.write(payload); } catch {}
  }
}

function sseLine(type, text, extra = {}) {
  sseBroadcast({ t: Date.now(), type, text, ...extra });
}

// -------------------- Helpers --------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanLines = (txt) => txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

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
async function resolveViaGraphLookup(link, token) {
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(link)}&access_token=${encodeURIComponent(token)}`;
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
    // 2) network resolve (?id=link)
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

// SSE for live logs
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();

  // client add
  currentJob.clients.add(res);
  // handshake
  sseLine("ready", "SSE connected");

  req.on("close", () => {
    currentJob.clients.delete(res);
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

      sseLine("info", `Files uploaded ✓ (tokens:${tCount}, comments:${cCount}, posts:${pCount})`);
      res.json({ ok: true, tokens: tCount, comments: cCount, postlinks: pCount });
    } catch (e) {
      sseLine("error", `Upload failed: ${e.message}`);
      res.status(500).json({ ok: false, message: "Upload failed", error: e.message });
    }
  }
);

// Stop job
app.post("/stop", (_req, res) => {
  if (currentJob.running) {
    currentJob.abort = true;
    sseLine("warn", "Stop requested by user");
    return res.json({ ok: true, message: "Stopping..." });
  }
  res.json({ ok: true, message: "No active job" });
});

// Start job
app.post("/start", async (req, res) => {
  if (currentJob.running) {
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
      currentJob.running = true;
      currentJob.abort   = false;

      sseLine("info", "Job started (v1.6)");

      // Load txt files
      const pToken = path.join("uploads", "token.txt");
      const pCmt   = path.join("uploads", "comment.txt");
      const pLinks = path.join("uploads", "postlink.txt");

      if (!fs.existsSync(pToken))  { sseLine("error", "token.txt missing. Upload first.");  return; }
      if (!fs.existsSync(pCmt))    { sseLine("error", "comment.txt missing. Upload first."); return; }

      let tokens   = cleanLines(fs.readFileSync(pToken, "utf-8"));
      let comments = cleanLines(fs.readFileSync(pCmt, "utf-8"));
      let manual   = [postId, link1, link2, link3].filter(Boolean);
      let filelnk  = fs.existsSync(pLinks) ? cleanLines(fs.readFileSync(pLinks, "utf-8")) : [];
      let inputs   = [...manual, ...filelnk];

      if (!tokens.length)   { sseLine("error", "No tokens in token.txt");   return; }
      if (!comments.length) { sseLine("error", "No comments in comment.txt"); return; }
      if (!inputs.length)   { sseLine("error", "No Post ID/Link provided (form or postlink.txt)"); return; }

      // Resolve account names
      sseLine("info", `Resolving account names for ${tokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < tokens.length; i++) {
        if (currentJob.abort) { sseLine("warn", "Aborted while resolving names."); return; }
        try { tokenName[tokens[i]] = await getAccountName(tokens[i]); }
        catch { tokenName[tokens[i]] = `Account#${i+1}`; }
        await sleep(150);
      }

      // Resolve links → final comment ids
      sseLine("info", `Resolving ${inputs.length} post link/id(s)...`);
      const resolvedPosts = [];
      const wrongLinks = [];
      const resolverToken = tokens[0]; // প্রথম token দিয়ে resolve

      for (const raw of inputs) {
        if (currentJob.abort) { sseLine("warn", "Aborted while resolving posts."); return; }

        let finalId = null;

        // quick path
        const quick = tryExtractGraphPostId(raw);
        if (quick) {
          finalId = await refineCommentTarget(quick, resolverToken);
        } else {
          // network resolve
          const via = await resolveViaGraphLookup(raw, resolverToken);
          if (via) finalId = await refineCommentTarget(via, resolverToken);
        }

        if (finalId) {
          resolvedPosts.push({ raw, id: finalId });
          sseLine("info", `Resolved: ${raw} → ${finalId}`);
        } else {
          wrongLinks.push(raw);
          sseLine("warn", `Unresolved link: ${raw}`);
        }
        await sleep(120);
      }

      if (!resolvedPosts.length) {
        sseLine("error", "Could not resolve any post IDs from inputs.");
        if (wrongLinks.length) sseLine("warn", `Unresolved: ${wrongLinks.length} link(s).`);
        return;
      }
      sseLine("success", `Final resolvable posts: ${resolvedPosts.length}`);
      if (wrongLinks.length) sseLine("warn", `Wrong/unsupported link(s): ${wrongLinks.length}`);

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

      let sent = 0, okCount = 0, failCount = 0;
      const counters = { INVALID_TOKEN:0, WRONG_POST_ID:0, NO_PERMISSION:0, COMMENT_BLOCKED:0, ID_LOCKED:0, UNKNOWN:0 };

      sseLine("info", `Delay: ${delayMs/1000}s, Limit: ${maxCount || "∞"}`);

      // Main loop
      outer:
      for (let pi = 0; pi < resolvedPosts.length; pi++) {
        for (let ti = 0; ti < tokens.length; ti++) {
          for (let ci = 0; ci < comments.length; ci++) {
            if (currentJob.abort) { sseLine("warn", "Job aborted by user."); break outer; }
            if (maxCount && sent >= maxCount) { sseLine("info", `Limit reached (${maxCount}). Stopping.`); break outer; }

            const token = tokens[ti];
            const post  = resolvedPosts[pi];
            const msg   = comments[ci];
            const acc   = tokenName[token] || `Account#${ti+1}`;

            try {
              const out = await postComment({ token, postId: post.id, message: msg });
              okCount++; sent++;
              sseLine("log", `✔ ${acc} → "${msg}" on ${post.id}`, { account: acc, comment: msg, postId: post.id, resultId: out.id || null });
            } catch (err) {
              failCount++; sent++;
              const cls = classifyError(err);
              counters[cls.kind] = (counters[cls.kind] || 0) + 1;
              sseLine("error", `✖ ${acc} → ${cls.human} (${post.id})`, { account: acc, postId: post.id, errKind: cls.kind, errMsg: err.message || String(err) });
            }

            if (delayMs > 0) await sleep(delayMs);
          }
        }
      }

      sseLine("summary", "Run finished", { sent, ok: okCount, failed: failCount, counters, unresolvedLinks: wrongLinks.length });
    } catch (e) {
      sseLine("error", `Fatal: ${e.message || e}`);
    } finally {
      currentJob.running = false;
      currentJob.abort   = false;
      sseLine("info", "Job closed");
    }
  })();
});

// -------------------- Boot --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
