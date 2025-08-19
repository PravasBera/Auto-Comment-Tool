const express = require("express");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());

// Default route
app.get("/", (req, res) => {
  res.send("✅ Auto Comment Tool is running on Render!");
});

// New API route: /comment
app.post("/comment", (req, res) => {
  const { postId, comment, account } = req.body;

  if (!postId || !comment) {
    return res.status(400).json({ error: "❌ postId এবং comment লাগবে!" });
  }

  // এখন শুধু ডেমো হিসেবে কনসোলে লগ করব
  console.log(`📌 Post ID: ${postId}`);
  console.log(`💬 Comment: ${comment}`);
  console.log(`👤 Account: ${account || "Default"}`);

  // Response
  res.json({
    success: true,
    message: "✅ Comment request received!",
    data: { postId, comment, account },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
