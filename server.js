/**
 * Facebook Auto Comment Tool (v1.6-fix)
 * - tokens/comments/postlinks txt + manual fields (UI অপরিবর্তিত)
 * - pfbid/various links → numeric ID resolver (improved)
 * - real Graph API comments + delay/limit/shuffle + stop + SSE logs
 * - error/warning classification
 */

import express from "express";
import multer from "multer";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
const upload = multer({ dest: "uploads/" });

let tokens = [];
let comments = [];
let postlinks = [];
let jobRunning = false;
let jobInterval = null;

// ---------------- Helper: extract postId ----------------
function extractPostId(link) {
  try {
    // case 1: direct numeric post id in URL (.../posts/1234567890/)
    const direct = link.match(/\/posts\/(\d+)/);
    if (direct) return direct[1];

    // case 2: full story_fbid form (...story_fbid=123&id=456)
    const story = link.match(/story_fbid=(\d+)/);
    if (story) return story[1];

    // case 3: pfbid style link (.../posts/pfbid02xxxxx/)
    const pfbid = link.match(/\/posts\/(pfbid\w+)/);
    if (pfbid) {
      return pfbid[1]; // return pfbid, resolve later
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------- Helper: resolve pfbid → numeric ID ----------------
async function resolvePfbid(pfbid, token) {
  try {
    const url = `https://graph.facebook.com/${pfbid}?fields=id&access_token=${token}`;
    const res = await fetch(url);
    const json = await res.json();
    return json.id || null;
  } catch {
    return null;
  }
}

// ---------------- Upload route ----------------
app.post("/upload", upload.fields([
  { name: "tokens" },
  { name: "comments" },
  { name: "postlinks" }
]), (req, res) => {
  try {
    if (req.files["tokens"]) {
      tokens = fs.readFileSync(req.files["tokens"][0].path, "utf-8")
        .split(/\r?\n/).filter(Boolean);
    }
    if (req.files["comments"]) {
      comments = fs.readFileSync(req.files["comments"][0].path, "utf-8")
        .split(/\r?\n/).filter(Boolean);
    }
    if (req.files["postlinks"]) {
      postlinks = fs.readFileSync(req.files["postlinks"][0].path, "utf-8")
        .split(/\r?\n/).filter(Boolean);
    }

    res.json({ ok: true, message: "Files uploaded successfully" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ---------------- Start route ----------------
app.post("/start", express.urlencoded({ extended: true }), async (req, res) => {
  if (jobRunning) {
    return res.json({ ok: false, message: "Job already running" });
  }

  const delay = parseInt(req.body.delay || "5", 10) * 1000;
  const limit = parseInt(req.body.limit || "0", 10);

  let links = [...postlinks];
  if (req.body.link1) links.push(req.body.link1);
  if (req.body.link2) links.push(req.body.link2);
  if (req.body.link3) links.push(req.body.link3);

  if (req.body.postId) links.push(req.body.postId);

  if (links.length === 0) {
    return res.json({ ok: false, message: "No links provided" });
  }

  let counter = 0;
  jobRunning = true;

  jobInterval = setInterval(async () => {
    if (!jobRunning) return;
    if (limit > 0 && counter >= limit) {
      clearInterval(jobInterval);
      jobRunning = false;
      return;
    }

    const token = tokens[counter % tokens.length];
    const comment = comments[counter % comments.length];
    const link = links[counter % links.length];

    let postId = extractPostId(link);
    if (postId && postId.startsWith("pfbid")) {
      const resolved = await resolvePfbid(postId, token);
      if (resolved) postId = resolved;
    }

    if (!postId) {
      console.log("❌ Could not parse post link:", link);
      counter++;
      return;
    }

    try {
      const url = `https://graph.facebook.com/${postId}/comments`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: comment, access_token: token })
      });

      const data = await response.json();
      if (data.id) {
        console.log(`✅ Commented: ${comment}`);
      } else {
        console.log(`⚠️ Failed: ${JSON.stringify(data)}`);
      }
    } catch (e) {
      console.log("❌ Error:", e.message);
    }

    counter++;
  }, delay);

  res.json({ ok: true, message: "Job started" });
});

// ---------------- Stop route ----------------
app.post("/stop", (req, res) => {
  jobRunning = false;
  if (jobInterval) clearInterval(jobInterval);
  res.json({ ok: true, message: "Job stopped" });
});

// ---------------- Serve static frontend ----------------
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
