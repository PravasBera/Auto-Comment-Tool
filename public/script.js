// ==========================
// Facebook Auto Comment Tool - v1.6 (Name + Comment shown)
// ==========================

const stats = {
  success: 0,
  failed: 0,
  badPosts: 0,
  invalidTokens: 0,
  expiredTokens: 0,
  blocked: 0
};

let stopFlag = false;
let tokenUsers = {}; // cache user info

// ---------- Utility ----------
function logFeed(message, type = "info") {
  const feedBox = document.getElementById("live-feed");
  const entry = document.createElement("div");
  entry.className = `feed-item ${type}`;
  entry.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
  feedBox.prepend(entry);
}

function updateStats() {
  document.getElementById("success-count").innerText = stats.success;
  document.getElementById("failed-count").innerText = stats.failed;
  document.getElementById("badpost-count").innerText = stats.badPosts;
  document.getElementById("invalid-count").innerText = stats.invalidTokens;
  document.getElementById("expired-count").innerText = stats.expiredTokens;
  document.getElementById("blocked-count").innerText = stats.blocked;
}

// ---------- Extract Post ID ----------
function extractPostId(linkOrId) {
  if (/^\d+$/.test(linkOrId)) return linkOrId;
  try {
    let url = new URL(linkOrId);
    if (url.searchParams.get("story_fbid")) return url.searchParams.get("story_fbid");
    if (url.pathname.includes("/posts/")) return url.pathname.split("/posts/")[1].split("/")[0];
    if (url.pathname.includes("/videos/")) return url.pathname.split("/videos/")[1].split("/")[0];
  } catch (e) {}
  return null;
}

// ---------- Get User Name from Token ----------
async function getUserName(token, index) {
  if (tokenUsers[index]) return tokenUsers[index];
  try {
    let res = await fetch(`https://graph.facebook.com/me?fields=name&access_token=${token}`);
    let data = await res.json();
    if (data.name) {
      tokenUsers[index] = data.name;
      return data.name;
    }
  } catch (e) {}
  return "Unknown User";
}

// ---------- Comment Function ----------
async function commentOnPost(postId, message, token, tokenIndex, postIndex) {
  const userName = await getUserName(token, tokenIndex);
  const url = `https://graph.facebook.com/${postId}/comments`;

  try {
    let response = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ message: message, access_token: token })
    });
    let data = await response.json();

    if (data.error) {
      let code = data.error.code;
      if (code === 190) {
        stats.expiredTokens++;
        logFeed(`❌ ${userName} → Token expired (Post ${postIndex})`, "error");
      } else if (code === 200) {
        stats.invalidTokens++;
        logFeed(`⚠️ ${userName} → Missing permission (Post ${postIndex})`, "warn");
      } else if (code === 368) {
        stats.blocked++;
        logFeed(`🚫 ${userName} → Blocked (Post ${postIndex})`, "error");
      } else {
        stats.failed++;
        logFeed(`❌ ${userName} → Failed: ${data.error.message}`, "error");
      }
    } else {
      stats.success++;
      logFeed(`✅ ${userName} → "${message}" (Post ${postIndex})`, "success");
    }
  } catch (err) {
    stats.failed++;
    logFeed(`⚠️ ${userName} → Network error (Post ${postIndex})`, "error");
  }
  updateStats();
}

// ---------- Start / Stop ----------
document.getElementById("startBtn").addEventListener("click", () => {
  stopFlag = false;
  logFeed("🚀 Tool started...", "info");
});

document.getElementById("stopBtn").addEventListener("click", () => {
  stopFlag = true;
  logFeed("🛑 Tool stopped by user", "warn");
});
