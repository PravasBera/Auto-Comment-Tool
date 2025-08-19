const express = require("express");
const fs = require("fs");
const app = express();

app.use(express.json());

const comments = fs.readFileSync("../shared/comments.txt", "utf-8").split("\n");
const posts = fs.readFileSync("../shared/posts.txt", "utf-8").split("\n");

app.get("/comment", (req, res) => {
  const randomComment = comments[Math.floor(Math.random() * comments.length)];
  res.json({ comment: randomComment });
});

app.get("/posts", (req, res) => {
  res.json({ posts });
});

app.post("/comment", (req, res) => {
  const { postId, comment } = req.body;
  console.log(`Posting comment "${comment}" to post ${postId}`);
  res.json({ success: true, postId, comment });
});

app.listen(5000, () => console.log("✅ Backend running on port 5000"));
