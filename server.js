const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fetch = require("node-fetch");

const app = express();
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Small helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

// --- Simple Web UI ---
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Auto Comment Tool</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Inter,sans-serif;max-width:880px;margin:24px auto;padding:0 12px}
    .card{border:1px solid #e5e7eb;border-radius:14px;padding:18px;margin:12px 0;box-shadow:0 1px 6px rgba(0,0,0,.06)}
    label{display:block;margin:.35rem 0 .2rem;font-weight:600}
    input[type="text"],input[type="number"],textarea{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:10px}
    input[type="file"]{margin:.4rem 0}
    button{padding:10px 16px;border:0;border-radius:10px;background:#111827;color:#fff;font-weight:600;cursor:pointer}
    button:disabled{opacity:.6;cursor:not-allowed}
    small{color:#6b7280}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .ok{color:#16a34a}.err{color:#dc2626}
  </style>
</head>
<body>
  <h2>✅ Auto Comment Tool (with Delay)</h2>
  <div class="card">
    <form id="form" action="/upload" method="post" enctype="multipart/form-data">
      <label>Access Token (will NOT be saved)</label>
      <input name="token" type="text" placeholder="EAAA...ZDZD" required />

      <div class="row">
        <div>
          <label>Delay between comments (seconds)</label>
          <input name="delaySec" type="number" min="0" step="1" value="5" required />
          <small>প্রতি কমেন্টের মাঝে কত সেকেন্ড অপেক্ষা করবে</small>
        </div>
        <div>
          <label>Max comments (optional)</label>
          <input name="maxCount" type="number" min="0" step="1" placeholder="0 = unlimited" />
          <small>ওভার-রেট এড়াতে লিমিট দিতে পারেন</small>
        </div>
      </div>

      <label>posts.txt (one post ID per line)</label>
      <input name="posts" type="file" accept=".txt" required />

      <label>comments.txt (one comment per line)</label>
      <input name="comments" type="file" accept=".txt" required />

      <div style="margin:.6rem 0">
        <label><input type="checkbox" name="shuffle" /> Shuffle comments</label>
        <small>র‍্যান্ডমভাবে কমেন্ট মিক্স করবে</small>
      </div>

      <button type="submit">Start</button>
    </form>
  </div>

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

      const lines = [];
      lines.push("✅ Done");
      lines.push("Summary:");
      lines.push("- Success: " + data.summary.success);
      lines.push("- Failed: " + data.summary.failed);
      if (data.summary.errors?.length){
        lines.push("\\nErrors:");
        data.summary.errors.forEach((e,i)=>lines.push((i+1)+") "+e));
      }
      if (data.items?.length){
        lines.push("\\nDetails:");
        data.items.forEach(it => {
          lines.push((it.ok ? "✔" : "✖") + " post " + it.postId + " -> " + it.message);
          if (!it.ok) lines.push("   reason: " + it.error);
        });
      }
      log.textContent = lines.join("\\n");
    } catch(err){
      log.textContent = "❌ " + err.message;
    }
  });
</script>
</body>
</html>`);
});

// --- Core worker: comment on a post via Graph API ---
async function postComment({ postId, message, token }) {
  const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(postId)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message })
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json; // { id: "POSTID_COMMENTID" }
}

// --- Upload handler ---
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

      // Clean lists
      let postIds = cleanLines(postsText);
      let comments = cleanLines(commentsText);

      if (postIds.length === 0) return res.status(400).json({ error: "posts.txt is empty" });
      if (comments.length === 0) return res.status(400).json({ error: "comments.txt is empty" });

      // Optionally shuffle comments
      if (doShuffle) {
        for (let i = comments.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [comments[i], comments[j]] = [comments[j], comments[i]];
        }
      }

      // Safety caps (avoid abuse / rate limit)
      const MAX_POSTS = 200;
      const MAX_COMMENTS = 200;
      if (postIds.length > MAX_POSTS) postIds = postIds.slice(0, MAX_POSTS);
      if (comments.length > MAX_COMMENTS) comments = comments.slice(0, MAX_COMMENTS);

      const items = [];
      let success = 0, failed = 0;
      let sent = 0;

      // Strategy: for each post, use comments in order (wrap around if needed)
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

      // Cleanup temp files
      try { fs.unlinkSync(req.files.posts[0].path); } catch {}
      try { fs.unlinkSync(req.files.comments[0].path); } catch {}

      return res.json({
        summary: { success, failed, totalTried: sent, delaySec, cappedPosts: postIds.length, cappedComments: comments.length },
        items
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
