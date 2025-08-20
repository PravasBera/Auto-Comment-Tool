const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanLines = (text) =>
  text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

// --- Core worker: comment on a post ---
async function postComment({ postId, message, token }) {
  const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(postId)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ message }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

// --- Upload handler ---
app.post(
  "/upload",
  upload.fields([
    { name: "posts", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "tokens", maxCount: 1 }, // NEW: token.txt
  ]),
  async (req, res) => {
    try {
      if (!req.files?.posts?.[0] || !req.files?.comments?.[0] || !req.files?.tokens?.[0]) {
        return res.status(400).json({ error: "posts.txt, comments.txt এবং token.txt লাগবে" });
      }

      const postsText = fs.readFileSync(req.files.posts[0].path, "utf-8");
      const commentsText = fs.readFileSync(req.files.comments[0].path, "utf-8");
      const tokensText = fs.readFileSync(req.files.tokens[0].path, "utf-8");

      let postIds = cleanLines(postsText);
      let comments = cleanLines(commentsText);
      let tokens = cleanLines(tokensText);

      if (postIds.length === 0) return res.status(400).json({ error: "posts.txt is empty" });
      if (comments.length === 0) return res.status(400).json({ error: "comments.txt is empty" });
      if (tokens.length === 0) return res.status(400).json({ error: "token.txt is empty" });

      const delaySec = 5; // fixed delay, চাইলে form থেকে নিতে পারো
      const items = [];
      let success = 0, failed = 0, sent = 0;

      let tokenIndex = 0; // Round Robin pointer

      outer:
      for (const postId of postIds) {
        for (const message of comments) {
          const token = tokens[tokenIndex];
          tokenIndex = (tokenIndex + 1) % tokens.length; // rotate

          try {
            const out = await postComment({ postId, message, token });
            items.push({ ok: true, postId, message, id: out.id, token: token.slice(0, 10) + "..." });
            success++;
          } catch (e) {
            items.push({ ok: false, postId, message, error: e.message, token: token.slice(0, 10) + "..." });
            failed++;
          }

          sent++;
          if (delaySec > 0) await sleep(delaySec * 1000);
        }
      }

      // Cleanup
      try { fs.unlinkSync(req.files.posts[0].path); } catch {}
      try { fs.unlinkSync(req.files.comments[0].path); } catch {}
      try { fs.unlinkSync(req.files.tokens[0].path); } catch {}

      return res.json({
        summary: { success, failed, totalTried: sent, delaySec, tokens: tokens.length },
        items
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
