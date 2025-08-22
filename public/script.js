// ---- Live log helpers
const logBox = document.getElementById("logBox");
const warnBox = document.getElementById("warnBox");

// ✅ sessionId here
let SESSION_ID = null;
const userIdBox = document.getElementById("userIdBox");
function setUserIdUI(text) {
  if (userIdBox) userIdBox.textContent = text;
}

function addLine(box, text, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ---- SSE connect (uses server's /events that emits `session` & `user`)
(function connectSSE() {
  const es = new EventSource("/events");

  // 🔹 catch named event: session → this is your UserID
  es.addEventListener("session", (evt) => {
    SESSION_ID = evt.data;
    setUserIdUI(SESSION_ID || "—");
    addLine(logBox, `Session ready: ${SESSION_ID}`, "info");
  });

  // optional: show user status (pending/approved/blocked)
  es.addEventListener("user", (evt) => {
    try {
      const info = JSON.parse(evt.data);
      if (info?.status && info.status !== "approved") {
        addLine(warnBox, `Status: ${info.status}. Ask admin for approval.`, "warn");
      }
    } catch {}
  });

  // fallback for generic messages (log/info/success/warn/error/summary)
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
  warnBox.innerHTML = "";

  if (!SESSION_ID) {
    addLine(warnBox, "UserID not ready yet. Wait for connection…", "warn");
    return;
  }

  const fd = new FormData(uploadForm);
  // send in body too (server reads body or query)
  fd.append("sessionId", SESSION_ID);

  try {
    const res = await fetch(`/upload?sessionId=${encodeURIComponent(SESSION_ID)}`, {
      method: "POST",
      body: fd
    });
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

  if (!SESSION_ID) {
    addLine(warnBox, "UserID not ready yet. Wait for connection…", "warn");
    return;
  }

  const data = new URLSearchParams(new FormData(startForm));
  data.append("sessionId", SESSION_ID);

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
  if (!SESSION_ID) {
    addLine(warnBox, "UserID not ready yet. Wait for connection…", "warn");
    return;
  }
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ sessionId: SESSION_ID }).toString()
    });
    const json = await res.json();
    addLine(warnBox, json.message || "Stop sent", "warn");
  } catch (err) {
    addLine(warnBox, `Stop error: ${err.message}`, "error");
  }
});

// =======================
// Utility: Extract Post ID (unchanged)
// =======================
function extractPostId(url) {
  try {
    let match = url.match(/\/posts\/(\d+)/);
    if (match) return match[1];
    match = url.match(/(\d+)_(\d+)/);
    if (match) return match[1] + "_" + match[2];
    match = url.match(/(\d{10,})/);
    if (match) return match[1];
  } catch (e) {
    console.error("Post ID extract error:", e);
  }
  return null;
}

// =======================
// Main: Post Comment (old helper; kept unchanged)
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
      body: new URLSearchParams({ access_token: token, message: comment })
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
