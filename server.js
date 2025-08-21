const express = require("express");
const fs = require("fs");
const path = require("path");

const { commentWithToken } = require("./core/logic");

const app = express();
const PORT = 3000;

// settings.json লোড
let settings = {};
try {
  const raw = fs.readFileSync("./config/settings.json", "utf8");
  settings = JSON.parse(raw);
} catch (err) {
  console.error("⚠️ settings.json error:", err.message);
  settings = { version: "1.0", author: "Unknown", team: "N/A", country: "N/A" };
}

// static serve
app.use(express.static("public"));

// view serve
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// settings API
app.get("/settings", (req, res) => {
  res.json(settings);
});

// sample comment API
app.get("/comment", (req, res) => {
  const { token, postId, message } = req.query;
  const result = commentWithToken(token, postId, message);
  res.send(result);
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
