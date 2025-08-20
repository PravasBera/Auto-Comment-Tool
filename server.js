const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// এখানে নিজের টোকেন বসান
const token = "EAAAAUaZA8jlABPNZAxU0A5PUV1o9Jw7KTH5MGDfF1lsjyxB97rnaOyZBZAH5CLkSf9hZC1960XXPKueD0CijUZCZA8rOf4UZBLd69dHZAeacCKFZBEn9X2FhnOEWLMaQZBAtBm2XzfBoS4ZBTG2QkxC9Y0V4aZClgvwHxW89JUZCJ0RivNiApeoobbOySa9uOE4vRn8AZDZD";

app.post("/comment", async (req, res) => {
  const { postId, message } = req.body;
  try {
    const response = await fetch(
      `https://graph.facebook.com/${postId}/comments?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
