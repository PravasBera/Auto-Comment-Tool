const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

// Static serve public folder (if needed)
app.use(express.static(path.join(__dirname, "public")));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// --- Helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

// --- UI Page with Custom Banner Header ---
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Facebook Auto Comment Tool</title>
  <style>
    body{font-family:monospace;background:#000;color:#fff;max-width:880px;margin:24px auto;padding:0 12px}
    .header{text-align:center;padding:20px}
    pre{color:lime;font-size:18px;line-height:1.2em}
    h2{color:purple}
    .info{color:yellow}
    .team{color:red;margin-top:8px}
    .card{border:1px solid #333;border-radius:14px;padding:18px;margin:12px 0;background:#111}
    label{display:block;margin:.35rem 0 .2rem;font-weight:600}
    input[type="text"],input[type="number"],textarea{width:100%;padding:10px;border:1px solid #444;border-radius:10px;background:#222;color:#fff}
    input[type="file"]{margin:.4rem 0;color:#fff}
    button{padding:10px 16px;border:0;border-radius:10px;background:lime;color:#000;font-weight:600;cursor:pointer}
    button:hover{background:yellow}
    small{color:#aaa}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  </style>
</head>
<body>
  <!-- Custom Banner Header -->
  <div class="header">
    <pre>
██████╗ ██╗   ██╗██╗     ██╗     ███████╗████████╗
██╔══██╗██║   ██║██║     ██║     ██╔════╝╚══██╔══╝
██████╔╝██║   ██║██║     ██║     █████╗     ██║   
██╔══██╗██║   ██║██║     ██║     ██╔══╝     ██║   
██████║  ██████╔╝███████╗███████╗███████╗   ██║   
╚═════╝  ╚═════╝ ╚══════╝╚══════╝╚══════╝   ╚═╝  
    </pre>
    <h2>🚀 Facebook Auto Comment Tool 🚀</h2>
    <p class="info">Author  : PRAVAS BERA</p>
    <p class="info">Version : 1.0</p>
    <p class="info">Country : INDIA</p>
    <p class="team">⚡ INDIAN DANGER OF BULLET TEAM ⚡</p>
  </div>

  <!-- Form Section -->
  <div class="card">
    <form id="form" action="/upload" method="post" enctype="multipart/form-data">
      <label>Access Token:</label>
      <input name="token" type="text" placeholder="EAAA...ZDZD" required />

      <div class="row">
        <div>
          <label>Delay (seconds)</label>
          <input name="delaySec" type="number" min="0" step="1" value="5" required />
        </div>
        <div>
          <label>Max Comments (0 = unlimited)</label>
          <input name="maxCount" type="number" min="0" step="1" value="0" />
        </div>
      </div>

      <label>posts.txt (one post ID per line)</label>
      <input name="posts" type="file" accept=".txt" required />

      <label>comments.txt (one comment per line)</label>
      <input name="comments" type="file" accept=".txt" required />

      <div style="margin:.6rem 0">
        <label><input type="checkbox" name="shuffle" /> Shuffle comments</label>
      </div>

      <button type="submit">Start Auto Comment</button>
    </form>
  </div>

  <!-- Log Section -->
  <div class="card">
    <h3>Run Log</h3>
    <pre id="log" style="white-space:pre-wrap"></pre>
  </div>

<script>
  const form = document.getElementById('form');
  const log = document.getElementById('log');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    log.textContent = "⏳ Uploading & processing...";
    const fd = new FormData(form);
    try {
      const res = await fetch('/upload', { method:'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      log.textContent = JSON.stringify(data, null, 2);
    } catch(err){
      log.textContent = "❌ " + err.message;
    }
  });
</script>
</body>
</html>`);
});

// --- Core worker: post comment to Graph API ---
async function postComment({ postId, message, token }) {
  const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(postId)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message })
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  return json;
}

// --- Upload Handler ---
app.post(
  "/upload",
  upload.fields([{ name: "posts", maxCount: 1 }, { name: "comments", maxCount: 1 }]),
  async (req, res) => {
    try {
      const token = (req.body.token || "").trim();
      const delaySec = Math.max(0, parseInt(req.body.delaySec || "0", 10));
      const maxCount = Math.max(0, parseInt(req.body.maxCount || "0", 10));
      const doShuffle = !!req.body.shuffle;

      if (!token) return res.status(400).json({ error: "Access token is required" });
      if (!req.files?.posts?.[0] || !req.files?.comments?.[0])
        return res.status(400).json({ error: "posts.txt and comments.txt required" });

      const postsText = fs.readFileSync(req.files.posts[0].path, "utf-8");
      const commentsText = fs.readFileSync(req.files.comments[0].path, "utf-8");

      let postIds = cleanLines(postsText);
      let comments = cleanLines(commentsText);

      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
        }
      }

      const items = [];
      let success = 0, failed = 0, sent = 0;

      outer:
      for (const postId of postIds) {
        for (const message of comments) {
          if (maxCount && sent >= maxCount) break outer;
          try {
            const out = await postComment({ postId, message, token });
            items.push({ ok: true, postId, message, id: out.id });
            success++;
          } catch (e) {
            items.push({ ok: false, postId, message, error: e.message });
            failed++;
          }
          sent++;
          if (delaySec > 0) await sleep(delaySec * 1000);
        }
      }

      fs.unlinkSync(req.files.posts[0].path);
      fs.unlinkSync(req.files.comments[0].path);

      return res.json({ summary: { success, failed, sent }, items });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
