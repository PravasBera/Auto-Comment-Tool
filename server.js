/**
 * Facebook Auto Comment Tool (v1.6-final)
 * - tokens/comments/post links from txt files + manual inputs
 * - real Graph API comments
 * - delay & limit
 * - stop control
 * - live logs via SSE
 * - error/warning classification
 */

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cors = require("cors");

// --- Setup
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });

// --- In-memory job state (single-process/simple)
let currentJob = {
  running: false,
  abort: false,
  clients: new Set(), // SSE clients
};

// --- SSE helpers
function sseBroadcast(line) {
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of currentJob.clients) {
    try { res.write(payload); } catch {}
  }
}
function sseLine(type, text, extra = {}) {
  sseBroadcast({ t: Date.now(), type, text, ...extra });
}

// --- Utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// Try to build graph post id from common link formats
function tryExtractGraphPostId(urlStr) {
  try {
    const u = new URL(urlStr);
    // story_fbid & id → id_storyfbid
    const story = u.searchParams.get("story_fbid");
    const actor = u.searchParams.get("id");
    if (story && actor) return `${actor}_${story}`;

    // /posts/<postid> with numeric actor id in path (rare)
    const m1 = u.pathname.match(/\/(\d+)\/posts\/(\d+)/);
    if (m1) return `${m1[1]}_${m1[2]}`;

    // If it's already like 111_222 keep as-is
    if (/^\d+_\d+$/.test(urlStr)) return urlStr;

    // If plain numeric id
    if (/^\d+$/.test(urlStr)) return urlStr;

    return null; // fall back to Graph lookup with ?id=
  } catch {
    return null;
  }
}

// Lookup by URL using Graph API (requires any valid token)
async function resolveUrlToObjectId(url, token) {
  try {
    const ep = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(url)}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(ep);
    const json = await res.json();
    // Sometimes returns { id: "<object_id>" } or OG object. Use 'id'
    if (json && json.id) return String(json.id);
    return null;
  } catch {
    return null;
  }
}

// Fetch account name for a token (for logs)
async function getAccountName(token) {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me?fields=name&access_token=${encodeURIComponent(token)}`);
    const json = await res.json();
    if (json && json.name) return json.name;
    return "Unknown Account";
  } catch {
    return "Unknown Account";
  }
}

// Real comment call
async function postComment({ token, postId, message }) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(postId)}/comments`;
  const body = new URLSearchParams({ message, access_token: token });
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = json.error || { message: `HTTP ${res.status}` };
    throw err;
  }
  return json; // { id: "POSTID_COMMENTID" }
}

// Error classification for better UI
function classifyError(err) {
  const code = err.code || err.error_subcode || 0;
  const msg = (err.message || "").toLowerCase();

  if (msg.includes("expired") || msg.includes("session has expired") || code === 190) {
    return { kind: "INVALID_TOKEN", human: "Invalid or expired token" };
  }
  if (msg.includes("permission") || msg.includes("insufficient") || msg.includes("not have permission")) {
    return { kind: "NO_PERMISSION", human: "Missing permission to comment" };
  }
  if (msg.includes("not found") || msg.includes("unsupported") || msg.includes("cannot be accessed")) {
    return { kind: "WRONG_POST_ID", human: "Wrong or inaccessible post id/link" };
  }
  if (msg.includes("temporarily blocked") || msg.includes("rate limit") || msg.includes("reduced")) {
    return { kind: "COMMENT_BLOCKED", human: "Comment blocked or rate limited" };
  }
  if (msg.includes("checkpoint") || msg.includes("locked")) {
    return { kind: "ID_LOCKED", human: "Account locked/checkpoint" };
  }
  return { kind: "UNKNOWN", human: err.message || "Unknown error" };
}

// --- Routes

// UI
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// SSE stream for live logs
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("event: ready\ndata: ok\n\n");

  currentJob.clients.add(res);
  req.on("close", () => {
    currentJob.clients.delete(res);
  });
});

// Upload tokens/comments/post links
app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      if (req.files?.tokens?.[0]) {
        fs.renameSync(req.files.tokens[0].path, path.join("uploads", "token.txt"));
      }
      if (req.files?.comments?.[0]) {
        fs.renameSync(req.files.comments[0].path, path.join("uploads", "comment.txt"));
      }
      if (req.files?.postlinks?.[0]) {
        fs.renameSync(req.files.postlinks[0].path, path.join("uploads", "postlink.txt"));
      }
      return res.json({ ok: true, message: "Files uploaded successfully" });
    } catch (e) {
      return res.status(500).json({ ok: false, message: "Upload failed", error: e.message });
    }
  }
);

// Stop current job
app.post("/stop", (_req, res) => {
  if (currentJob.running) {
    currentJob.abort = true;
    return res.json({ ok: true, message: "Stopping..." });
  }
  return res.json({ ok: true, message: "No active job" });
});

// Start commenting job (REAL)
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
    useShuffle = "false",
  } = req.body;

  // Immediate ACK
  res.json({ ok: true, message: "Started" });

  // ---- Async worker
  (async () => {
    try {
      currentJob.running = true;
      currentJob.abort = false;

      sseLine("info", "Job started (v1.6)");

      // Load files
      const tokensPath = path.join("uploads", "token.txt");
      const commentsPath = path.join("uploads", "comment.txt");
      const postLinksPath = path.join("uploads", "postlink.txt");

      if (!fs.existsSync(tokensPath)) {
        sseLine("error", "token.txt missing. Upload first.");
        return;
      }
      if (!fs.existsSync(commentsPath)) {
        sseLine("error", "comment.txt missing. Upload first.");
        return;
      }

      let tokens = cleanLines(fs.readFileSync(tokensPath, "utf-8"));
      let comments = cleanLines(fs.readFileSync(commentsPath, "utf-8"));
      let manualLinks = [link1, link2, link3].filter(Boolean);
      let fileLinks = fs.existsSync(postLinksPath)
        ? cleanLines(fs.readFileSync(postLinksPath, "utf-8"))
        : [];

      // Post IDs set
      let postInputs = [];
      if (postId.trim()) postInputs.push(postId.trim());
      postInputs.push(...manualLinks);
      postInputs.push(...fileLinks);

      if (postInputs.length === 0) {
        sseLine("error", "No Post ID or Post Link provided.");
        return;
      }
      if (comments.length === 0) {
        sseLine("error", "No comments found in comment.txt");
        return;
      }
      if (tokens.length === 0) {
        sseLine("error", "No tokens found in token.txt");
        return;
      }

      // Resolve account names for each token (optional, but you wanted names)
      sseLine("info", `Resolving account names for ${tokens.length} token(s)...`);
      const tokenName = {};
      for (let i = 0; i < tokens.length; i++) {
        if (currentJob.abort) return sseLine("warn", "Aborted while resolving names.");
        try {
          tokenName[tokens[i]] = await getAccountName(tokens[i]);
        } catch {
          tokenName[tokens[i]] = `Account#${i + 1}`;
        }
        await sleep(200);
      }

      // Build final list of Graph post IDs
      sseLine("info", `Resolving ${postInputs.length} post id/link(s)...`);
      const resolvedPosts = [];
      const wrongLinks = [];

      // Use the first valid token to resolve URLs when needed
      const resolverToken = tokens[0];

      for (const raw of postInputs) {
        // If already id-like
        let pid = tryExtractGraphPostId(raw);
        if (!pid) {
          // Try Graph URL resolver (?id=<url>)
          pid = await resolveUrlToObjectId(raw, resolverToken);
        }
        if (pid) {
          resolvedPosts.push({ raw, id: pid });
        } else {
          wrongLinks.push(raw);
        }
        await sleep(100);
      }

      if (resolvedPosts.length === 0) {
        sseLine("error", "Could not resolve any post IDs from inputs.");
        if (wrongLinks.length) sseLine("warn", `Unresolved: ${wrongLinks.length} link(s).`);
        return;
      }

      sseLine("success", `Resolved ${resolvedPosts.length} post(s).`);
      if (wrongLinks.length) sseLine("warn", `Wrong/unsupported link(s): ${wrongLinks.length}`);

      // Shuffle comments (optional)
      const doShuffle = String(useShuffle) === "true";
      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
        }
      }

      const delayMs = Math.max(0, parseInt(delay, 10) || 0) * 1000;
      const maxCount = Math.max(0, parseInt(limit, 10) || 0);

      // Stats & counters
      let sent = 0,
        okCount = 0,
        failCount = 0;
      const counters = {
        INVALID_TOKEN: 0,
        WRONG_POST_ID: 0,
        NO_PERMISSION: 0,
        COMMENT_BLOCKED: 0,
        ID_LOCKED: 0,
        UNKNOWN: 0,
      };

      sseLine("info", `Delay: ${delayMs / 1000}s, Limit: ${maxCount || "∞"}`);

      // Main loop: rotate (token x post x comment)
      outer: for (let pi = 0; pi < resolvedPosts.length; pi++) {
        for (let ti = 0; ti < tokens.length; ti++) {
          for (let ci = 0; ci < comments.length; ci++) {
            if (currentJob.abort) {
              sseLine("warn", "Job aborted by user.");
              break outer;
            }
            if (maxCount && sent >= maxCount) {
              sseLine("info", `Limit reached (${maxCount}). Stopping.`);
              break outer;
            }

            const token = tokens[ti];
            const post = resolvedPosts[pi];
            const message = comments[ci];
            const accName = tokenName[token] || `Account#${ti + 1}`;

            // Try to comment
            try {
              const out = await postComment({ token, postId: post.id, message });
              okCount++;
              sent++;
              sseLine("log", `✔ ${accName} → "${message}" on ${post.id}`, {
                account: accName,
                comment: message,
                postId: post.id,
                resultId: out.id || null,
              });
            } catch (err) {
              failCount++;
              sent++;
              const cls = classifyError(err);
              counters[cls.kind] = (counters[cls.kind] || 0) + 1;
              sseLine("error", `✖ ${accName} → ${cls.human} (${post.id})`, {
                account: accName,
                postId: post.id,
                errKind: cls.kind,
                errMsg: err.message || String(err),
              });
            }

            if (delayMs > 0) await sleep(delayMs);
          }
        }
      }

      // Summary
      sseLine("summary", "Run finished", {
        sent,
        ok: okCount,
        failed: failCount,
        counters,
        unresolvedLinks: wrongLinks.length,
      });
    } catch (e) {
      sseLine("error", `Fatal: ${e.message || e}`);
    } finally {
      currentJob.running = false;
      currentJob.abort = false;
      sseLine("info", "Job closed");
    }
  })();
});

// Boot
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
