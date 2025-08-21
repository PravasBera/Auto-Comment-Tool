// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --------- Middleware ---------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// View engine
app.set("views", path.join(__dirname, "views"));
app.engine("html", require("ejs").renderFile);
app.set("view engine", "html");

// File upload
const upload = multer({ dest: "uploads/" });

// --------- Global store ---------
let TOKENS = [];
let COMMENTS = [];
let POSTLINKS = [];

// --------- Utils ---------
function classifyError(err) {
  let msg = err.message || String(err);
  if (/expired|invalid token/i.test(msg)) return { kind: "token", human: "❌ Invalid/Expired Token" };
  if (/limit/i.test(msg)) return { kind: "limit", human: "⚠ Rate Limit" };
  return { kind: "other", human: msg };
}

// --------- Resolve Post Link ---------
async function resolveViaGraphLookup(link, token) {
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(link)}&access_token=${encodeURIComponent(token)}`;
  console.log("[DEBUG] Graph lookup URL:", api);

  const res = await fetch(api);
  const json = await res.json();
  console.log("[DEBUG] Graph lookup response:", json);

  if (json?.og_object?.id) return String(json.og_object.id);
  if (json?.id) return String(json.id);
  return null;
}

async function refineCommentTarget(id, token) {
  try {
    console.log("[DEBUG] refineCommentTarget input:", id);
    if (/^\d+_\d+$/.test(id)) return id;

    const ep = `https://graph.facebook.com/v19.0/${encodeURIComponent(id)}?fields=object_id,status_type,from,permalink_url&access_token=${encodeURIComponent(token)}`;
    console.log("[DEBUG] refineCommentTarget fetch:", ep);

    const res = await fetch(ep);
    const json = await res.json();
    console.log("[DEBUG] refineCommentTarget response:", json);

    if (json?.object_id && /^\d+$/.test(String(json.object_id))) {
      return String(json.object_id);
    }
    return id;
  } catch (e) {
    console.log("[DEBUG] refineCommentTarget error:", e);
    return id;
  }
}

async function postComment({ token, postId, message }) {
  const url = `https://graph.facebook.com/v19.0/${postId}/comments`;
  const body = new URLSearchParams({ message, access_token: token });
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || "Unknown error");
  return json;
}

// --------- Routes ---------
app.get("/", (req, res) => {
  res.render("index.html");
});

// File Upload Route
app.post("/upload", upload.fields([{ name: "tokens" }, { name: "comments" }, { name: "postlinks" }]), (req, res) => {
  if (req.files.tokens) {
    TOKENS = fs.readFileSync(req.files.tokens[0].path, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  }
  if (req.files.comments) {
    COMMENTS = fs.readFileSync(req.files.comments[0].path, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  }
  if (req.files.postlinks) {
    POSTLINKS = fs.readFileSync(req.files.postlinks[0].path, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  }
  res.json({ tokens: TOKENS.length, comments: COMMENTS.length, postlinks: POSTLINKS.length });
});

// SSE stream
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();

  let sent = 0;
  let okCount = 0;
  let failCount = 0;
  let counters = {};

  // keep-alive heartbeat (every 15s)
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: "💓 keep-alive"\n\n`);
  }, 15000);

  (async () => {
    try {
      for (let token of TOKENS) {
        const acc = token.slice(0, 10) + "...";
        for (let link of POSTLINKS) {
          try {
            // 1. resolve
            let rawId = await resolveViaGraphLookup(link, token);
            if (!rawId) throw new Error("Cannot resolve ID from link");

            let finalId = await refineCommentTarget(rawId, token);

            // 2. choose comment
            let msg = COMMENTS[Math.floor(Math.random() * COMMENTS.length)];

            // 3. post comment
            const out = await postComment({ token, postId: finalId, message: msg });
            okCount++; sent++;

            res.write(`event: log\ndata: ${JSON.stringify({
              account: acc,
              comment: msg,
              postId: finalId,
              resultId: out.id || null,
              status: "success"
            })}\n\n`);

          } catch (err) {
            failCount++; sent++;
            const cls = classifyError(err);
            counters[cls.kind] = (counters[cls.kind] || 0) + 1;

            res.write(`event: error\ndata: ${JSON.stringify({
              account: acc,
              errKind: cls.kind,
              errMsg: err.message || String(err),
              status: "failed"
            })}\n\n`);
          }
        }
      }
    } catch (e) {
      res.write(`event: fatal\ndata: ${JSON.stringify({ msg: e.message || String(e) })}\n\n`);
    } finally {
      clearInterval(keepAlive);
      res.write(`event: summary\ndata: ${JSON.stringify({ sent, okCount, failCount, counters })}\n\n`);
      res.end();
    }
  })();
});

// --------- Start ---------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
