const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

let tokens = [];
let comments = [];
let postLinks = [];
let running = false;

function sendLog(msg) {
  console.log(msg);
}
function sendWarn(msg) {
  console.warn(msg);
}

function extractPostId(link) {
  try {
    if (link.includes("facebook.com")) {
      const match = link.match(/\/posts\/(\d+)/);
      if (match) return match[1];
    }
    return link;
  } catch {
    return link;
  }
}

async function postComment(postId, token, message) {
  const url = `https://graph.facebook.com/${postId}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: token })
  });
  const data = await res.json();
  if (!data.id) throw new Error(JSON.stringify(data));
  return data;
}

// ----------------- Routes -----------------

app.get("/", (req, res) => {
  res.render("index");
});

// Upload files
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
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (req.files["comments"]) {
      comments = fs
        .readFileSync(req.files["comments"][0].path, "utf8")
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    if (req.files["postlinks"]) {
      postLinks = fs
        .readFileSync(req.files["postlinks"][0].path, "utf8")
        .split("\n")
        .map((p) => extractPostId(p.trim()))
        .filter(Boolean);
    }
    res.send("Files uploaded successfully!");
  }
);

// Start commenting
app.post("/start", async (req, res) => {
  const { postId, link1, link2, link3, delay, limit, useShuffle } = req.body;

  let postIds = [...postLinks];
  if (postId) postIds.push(postId);
  if (link1) postIds.push(extractPostId(link1));
  if (link2) postIds.push(extractPostId(link2));
  if (link3) postIds.push(extractPostId(link3));

  if (!tokens.length || !comments.length || !postIds.length) {
    return res.status(400).send("Missing data! Upload tokens, comments, and posts.");
  }

  running = true;
  res.send("Started commenting...");

  let cmts = [...comments];
  let toks = [...tokens];
  if (useShuffle) {
    cmts = cmts.sort(() => Math.random() - 0.5);
    toks = toks.sort(() => Math.random() - 0.5);
  }

  let count = 0;
  let i = 0;
  const max = parseInt(limit) || 0;
  const wait = parseInt(delay) || 5;

  while (running && (max === 0 || count < max)) {
    const token = toks[i % toks.length];
    const comment = cmts[i % cmts.length];

    for (const pid of postIds) {
      try {
        await postComment(pid, token, comment);
        sendLog(`✅ ${token.slice(0, 10)}... → "${comment}" on ${pid}`);
      } catch (err) {
        sendWarn(`❌ Error with ${token.slice(0, 10)}... → ${err.message}`);
      }
    }

    count++;
    i++;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }

  sendLog("🚀 Commenting stopped/completed.");
});

// Stop
app.post("/stop", (req, res) => {
  running = false;
  res.send("Stopped commenting.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
