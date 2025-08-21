// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Middleware --------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // style.css, script.js এখান থেকে লোড হবে

// -------- Serve index.html --------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// -------- File upload --------
const upload = multer({ dest: "uploads/" });

let TOKENS = [];
let COMMENTS = [];
let POSTLINKS = [];

// -------- Helper --------
function sseLine(event, data, extra = {}) {
  let payload = { event, data, ...extra };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function classifyError(err) {
  let msg = err.message || String(err);
  if (/expired|invalid token/i.test(msg)) return { kind: "token", human: "❌ Invalid/Expired Token" };
  if (/limit/i.test(msg)) return { kind: "limit", human: "⚠ Rate Limit" };
  return { kind: "other", human: msg };
}

// -------- Resolve Post Link --------
async function resolveViaGraphLookup(link, token) {
  const api = `https://graph.facebook.com/v19.0/?id=${encodeURIComponent(link)}&access_token=${encodeURIComponent(token)}`;
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
    if (json?.object_id && /^\d+$/.test(String(json.object_id))) {
      return String(json.object_id);
    }
    return id;
  } catch {
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

// -------- Upload Route --------
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

// -------- SSE events --------
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.flushHeaders();

  let sent = 0, okCount = 0, failCount = 0, counters = {};

  (async () => {
    try {
      for (let token of TOKENS) {
        const acc = token.slice(0, 10) + "...";
        for (let link of POSTLINKS) {
          try {
            let rawId = await resolveViaGraphLookup(link, token);
            if (!rawId) throw new Error("Cannot resolve ID from link");
            let finalId = await refineCommentTarget(rawId, token);

            let msg = COMMENTS[Math.floor(Math.random() * COMMENTS.length)];
            const out = await postComment({ token, postId: finalId, message: msg });

            okCount++; sent++;
            res.write(sseLine("log", `✔ ${acc} → "${msg}" on ${finalId}`, { account: acc, comment: msg, postId: finalId, resultId: out.id || null }));
          } catch (err) {
            failCount++; sent++;
            const cls = classifyError(err);
            counters[cls.kind] = (counters[cls.kind] || 0) + 1;
            res.write(sseLine("error", `✖ ${acc} → ${cls.human}`, { account: acc, errKind: cls.kind, errMsg: err.message || String(err) }));
          }
        }
      }
    } catch (e) {
      res.write(sseLine("fatal", "Server crashed: " + (e.message || e)));
    } finally {
      res.write(sseLine("summary", { sent, okCount, failCount, counters }));
      res.end();
    }
  })();
});

// -------- Start --------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
