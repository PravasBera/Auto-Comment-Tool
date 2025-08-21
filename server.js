// server.js
const express = require("express");
const multer = require("multer");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ===== PFID → POSTID Converter =====
function decodePfbid(pfbid) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(0);
  for (let char of pfbid) {
    num = num * BigInt(58) + BigInt(alphabet.indexOf(char));
  }
  const postId = (num >> BigInt(64)).toString();
  return postId;
}

function extractPostIdFromLink(url) {
  try {
    if (url.includes("pfbid")) {
      const match = url.match(/pfbid([A-Za-z0-9]+)/);
      if (match) {
        const pfbid = match[1];
        return decodePfbid(pfbid);
      }
    } else if (url.includes("/posts/")) {
      return url.split("/posts/")[1].split("/")[0];
    }
  } catch (e) {
    return null;
  }
  return null;
}

// ===== Global Vars =====
let tokens = [];
let comments = [];
let postLinks = [];
let running = false;
let delay = 5;
let limit = 0;
let useShuffle = false;
let processed = 0;

// ===== Serve UI =====
app.get("/", (req, res) => {
  res.render("index"); // তোমার views/index.ejs বা index.html
});

// ===== Upload Handler =====
app.post(
  "/upload",
  upload.fields([
    { name: "tokens", maxCount: 1 },
    { name: "comments", maxCount: 1 },
    { name: "postlinks", maxCount: 1 },
  ]),
  (req, res) => {
    if (req.files["tokens"]) {
      tokens = fs
        .readFileSync(req.files["tokens"][0].path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (req.files["comments"]) {
      comments = fs
        .readFileSync(req.files["comments"][0].path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (req.files["postlinks"]) {
      postLinks = fs
        .readFileSync(req.files["postlinks"][0].path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    }
    res.json({ success: true, tokens: tokens.length, comments: comments.length, postLinks: postLinks.length });
  }
);

// ===== Start Commenting =====
app.post("/start", async (req, res) => {
  if (running) return res.json({ success: false, msg: "Already running" });

  let { postId, link1, link2, link3, delay: d, limit: l, useShuffle: s } = req.body;

  delay = parseInt(d) || 5;
  limit = parseInt(l) || 0;
  useShuffle = !!s;

  postLinks = [...postLinks, link1, link2, link3].filter(Boolean);

  if (postId) postLinks.push(postId);

  // Convert PFID → PostID
  postLinks = postLinks.map((link) => {
    if (link.startsWith("http")) {
      const converted = extractPostIdFromLink(link);
      return converted ? converted : link;
    }
    if (link.startsWith("pfbid")) {
      const converted = decodePfbid(link.replace("pfbid", ""));
      return converted;
    }
    return link;
  });

  if (!tokens.length || !comments.length || !postLinks.length) {
    return res.json({ success: false, msg: "Upload files or provide inputs first!" });
  }

  running = true;
  processed = 0;
  runBot();

  res.json({ success: true, msg: "Bot started" });
});

// ===== Stop =====
app.post("/stop", (req, res) => {
  running = false;
  res.json({ success: true, msg: "Bot stopped" });
});

// ===== Bot Logic =====
async function runBot() {
  while (running) {
    for (let token of tokens) {
      for (let link of postLinks) {
        if (!running) return;

        let comment =
          useShuffle && Math.random() > 0.5
            ? comments[Math.floor(Math.random() * comments.length)]
            : comments[processed % comments.length];

        try {
          const url = `https://graph.facebook.com/${link}/comments`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: comment, access_token: token }),
          });
          const data = await resp.json();

          if (data.error) {
            console.log("❌ Error:", data.error.message);
          } else {
            console.log(`✅ Commented: ${comment}`);
          }
        } catch (e) {
          console.log("⚠ Exception:", e.message);
        }

        processed++;
        if (limit > 0 && processed >= limit) {
          running = false;
          console.log("⏹ Limit reached, stopped.");
          return;
        }

        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }
}

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
