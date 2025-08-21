// server.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname fix (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Static files (public ফোল্ডার থেকে CSS/JS serve হবে)
app.use(express.static(path.join(__dirname, "public")));

// --- Multer upload setup
const upload = multer({ dest: "uploads/" });

// --- Serve index.html (views থেকে)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// ---- File Upload
app.post("/upload", upload.fields([
  { name: "tokens", maxCount: 1 },
  { name: "comments", maxCount: 1 },
  { name: "postlinks", maxCount: 1 }
]), (req, res) => {
  try {
    if (req.files.tokens) {
      fs.renameSync(req.files.tokens[0].path, "tokens.txt");
    }
    if (req.files.comments) {
      fs.renameSync(req.files.comments[0].path, "comments.txt");
    }
    if (req.files.postlinks) {
      fs.renameSync(req.files.postlinks[0].path, "postlinks.txt");
    }
    res.json({ ok: true, message: "Files uploaded successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: "Upload failed" });
  }
});

// ---- Start Job
app.post("/start", (req, res) => {
  console.log("▶ Job started with data:", req.body);
  // এখানে comment করার লজিক যাবে
  res.json({ ok: true, message: "Job started" });
});

// ---- Stop Job
app.post("/stop", (req, res) => {
  console.log("⏹ Job stopped");
  res.json({ ok: true, message: "Job stopped" });
});

// ---- Events (SSE log stream)
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ type: "log", text: "SSE Connected" })}\n\n`);

  // প্রতি 5 সেকেন্ডে 1টা ping পাঠাবে
  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "info", text: "heartbeat" })}\n\n`);
  }, 5000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// --- Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
