const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(express.json());

// টেস্ট API
app.get("/", (req, res) => {
  res.send("✅ Facebook Auto Comment Tool is Running!");
});

// comment API
app.post("/comment", async (req, res) => {
  const { postId, message } = req.body;

  if (!postId || !message) {
    return res.status(400).json({ error: "Post ID এবং Message লাগবে" });
  }

  const token = process.env.FB_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/${postId}/comments`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: token }),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "কিছু ভুল হয়েছে", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
