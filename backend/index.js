const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// static files serve
app.use(express.static(path.join(__dirname, "templates")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
