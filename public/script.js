// =======================
// ✅ Auto load UserID
// =======================
async function loadUserId() {
  try {
    const res = await fetch("/session");
    const data = await res.json();
    document.getElementById("userIdBox").innerText = data.id;
  } catch (err) {
    document.getElementById("userIdBox").innerText = "❌ Failed to load";
  }
}

window.onload = loadUserId;

// ---- Live log helpers
const logBox = document.getElementById("logBox");
const warnBox = document.getElementById("warnBox");

function addLine(box, text, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ---- SSE connect
(function connectSSE() {
  const es = new EventSource("/events");
  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      const ts = new Date(data.t || Date.now()).toLocaleTimeString();
      const line = `[${ts}] ${data.text}`;

      switch (data.type) {
        case "log":
        case "info":
          addLine(logBox, line, "info");
          break;
        case "success":
          addLine(logBox, line, "success");
          break;
        case "warn":
          addLine(warnBox, line, "warn");
          break;
        case "error":
          addLine(warnBox, line, "error");
          break;
        case "summary":
          addLine(warnBox, `--- Summary ---`, "summary");
          addLine(warnBox, `Sent: ${data.sent}, OK: ${data.ok}, Failed: ${data.failed}`);
          if (data.counters) {
            Object.keys(data.counters).forEach(k => {
              if (data.counters[k] > 0) addLine(warnBox, `${k}: ${data.counters[k]}`);
            });
          }
          if (typeof data.unresolvedLinks === "number") {
            addLine(warnBox, `Unresolved links: ${data.unresolvedLinks}`);
          }
          break;
        default:
          addLine(logBox, line);
      }
    } catch {
      // plain text
      addLine(logBox, evt.data || "");
    }
  };
  es.onerror = () => {
    addLine(warnBox, "SSE disconnected. Retrying in 3s...", "warn");
    setTimeout(connectSSE, 3000);
  };
})();

// ---- Upload form
const uploadForm = document.getElementById("uploadForm");
uploadForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  warnBox.innerHTML = ""; // clear warnings
  const fd = new FormData(uploadForm);
  try {
    const res = await fetch("/upload", { method: "POST", body: fd });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.message || "Upload failed");
    addLine(logBox, "✔ Files uploaded successfully", "success");
  } catch (err) {
    addLine(warnBox, `Upload error: ${err.message}`, "error");
  }
});

// ---- Start form
const startForm = document.getElementById("startForm");
startForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  warnBox.innerHTML = "";
  const data = new URLSearchParams(new FormData(startForm));
  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: data.toString()
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.message || "Start failed");
    addLine(logBox, "▶ Job started", "info");
  } catch (err) {
    addLine(warnBox, `Start error: ${err.message}`, "error");
  }
});

// ---- Stop button
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  try {
    const res = await fetch("/stop", { method: "POST" });
    const json = await res.json();
    addLine(warnBox, json.message || "Stop sent", "warn");
  } catch (err) {
    addLine(warnBox, `Stop error: ${err.message}`, "error");
  }
});

// =======================
// Utility: Extract Post ID
// =======================
function extractPostId(url) {
  try {
    // case-1: /posts/{postId}
    let match = url.match(/\/posts\/(\d+)/);
    if (match) return match[1];

    // case-2: profileId_postId ফরম্যাট
    match = url.match(/(\d+)_(\d+)/);
    if (match) return match[1] + "_" + match[2];

    // case-3: fallback → বড় সংখ্যার id ধরবে
    match = url.match(/(\d{10,})/);
    if (match) return match[1];

  } catch (e) {
    console.error("Post ID extract error:", e);
  }
  return null;
}

// =======================
// Main: Post Comment
// =======================
async function postComment(token, postLink, comment) {
  try {
    const postId = extractPostId(postLink);
    if (!postId) {
      addLine(warnBox, `❌ Could not extract post ID from link: ${postLink}`, "warn");
      return false;
    }

    const url = `https://graph.facebook.com/${postId}/comments`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: token,
        message: comment
      })
    });

    const data = await res.json();
    if (data.id) {
      addLine(logBox, `✅ Commented → ${comment} (id: ${data.id})`, "success");
      return true;
    } else {
      addLine(warnBox, `❌ Comment failed on ${postLink}`, "error");
      console.error("Response:", data);
      return false;
    }

  } catch (err) {
    addLine(warnBox, `⚠️ Error while commenting: ${err.message}`, "error");
    return false;
  }
}
