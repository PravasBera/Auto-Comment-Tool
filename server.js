const express = require("express");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// File Upload (TXT)
const upload = multer({ dest: "uploads/" });

// Handle form submit
app.post("/start", upload.single("commentFile"), async (req, res) => {
    const { token, postIds, delay } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!token || !postIds || !filePath) {
        return res.status(400).send("Missing required fields!");
    }

    // Read comments from file
    const comments = fs.readFileSync(filePath, "utf-8").split("\n").filter(c => c.trim() !== "");
    const posts = postIds.split(",").map(id => id.trim());

    // Async comment posting
    (async function autoComment() {
        for (let post of posts) {
            for (let comment of comments) {
                try {
                    await axios.post(
                        `https://graph.facebook.com/${post}/comments`,
                        { message: comment, access_token: token }
                    );
                    console.log(`✅ Commented: ${comment} on ${post}`);
                } catch (err) {
                    console.error(`❌ Failed on ${post}: ${err.response?.data?.error?.message}`);
                }
                await new Promise(r => setTimeout(r, delay * 1000)); // delay
            }
        }
    })();

    res.send("🚀 Auto comment started!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
