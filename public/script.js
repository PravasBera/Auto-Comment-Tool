// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (Client-Side) — FIXED
// ===============================

let eventSource = null;
let isRunning = false;
window.sessionId = null;

// ---------------------------
// UI Helpers
// ---------------------------
function addLog(type, message) {
  const logBox = document.getElementById("logBox");
  if (!logBox) return;
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function addWarning(type, message) {
  const warnBox = document.getElementById("warnBox");
  if (!warnBox) return;
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  warnBox.appendChild(div);
  warnBox.scrollTop = warnBox.scrollHeight;
}

function clearLogs() {
  const logBox = document.getElementById("logBox");
  const warnBox = document.getElementById("warnBox");
  if (logBox) logBox.innerHTML = "";
  if (warnBox) warnBox.innerHTML = "";
}

// ---------------------------
// Session bootstrap
// ---------------------------
async function loadSession() {
  try {
    const res = await fetch("/session", { credentials: "include" });
    const data = await res.json();
    if (data && data.id) {
      window.sessionId = data.id;
      const box = document.getElementById("userIdBox");
      if (box) box.textContent = data.id;
      addLog("success", "✅ Session ID loaded.");
    } else {
      throw new Error("No session id in response");
    }
  } catch (err) {
    const box = document.getElementById("userIdBox");
    if (box) box.textContent = "Session load failed";
    addWarning("error", "❌ Failed to load session: " + err.message);
  }
}

// ---------------------------
//
// File Upload
//
// ---------------------------
document.getElementById("uploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);

  // sessionId থাকলে সেটাও পাঠানো হবে
  if (window.sessionId) formData.append("sessionId", window.sessionId);

  // NameBox ভ্যালু collect
  const nameBox = document.getElementById("nameBox")?.value.trim();
  if (nameBox) {
    formData.append("name", nameBox);
  }

  try {
    addLog("info", "⏳ Uploading files…");
    const res = await fetch("/upload", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const data = await res.json();

    if (data.ok) {
      addLog(
        "success",
        `✅ Uploaded (tokens:${data.tokens || 0}, comments:${data.comments || 0}, posts:${data.postlinks || 0}, name:${data.name || "N/A"}).`
      );
    } else {
      addWarning(
        "error",
        "❌ Upload failed: " +
          (data.message || data.error || "Unknown")
      );
    }
  } catch (err) {
    addWarning("error", "❌ Upload error: " + err.message);
  }
});

// -------------------------
// Start
// -------------------------
document.getElementById("startBtn")?.addEventListener("click", async () => {
  const delay = parseInt(document.getElementById("delay")?.value || "20", 10);
  const limit = parseInt(document.getElementById("limit")?.value || "0", 10);
  const shuffle = document.getElementById("shuffle")?.checked || false;

  addLog("info", "🚀 Sending start request…");

  try {
    // Collect manual posts
    const posts = [];
    document.querySelectorAll(".manual-post").forEach((row) => {
      const target = row.querySelector(".target")?.value.trim();
      const namesText = row.querySelector(".names")?.value.trim();
      const tokensText = parseInt(row.querySelector(".tokens")?.value.trim() || "0", 10);
      const commentsText = row.querySelector(".comments")?.value.trim();

      if (target && commentsText) {
        posts.push({
          target: target,
          names: namesText || "",
          tokens: tokensText,
          comments: commentsText || ""
        });
      }
    });

    // Server request
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        delay,
        limit,
        shuffle,
        sessionId: window.sessionId || "",
        posts // manual posts server এ যাবে
      }),
    });

    const data = await res.json();

    if (data.success) {
      addLog("success", "✅ Commenting started.");
      isRunning = true;
      startSSE(); // Live logs চালু
    } else {
      addWarning("error", "❌ Start failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Start request error: " + err.message);
  }
});

// ---------------------------
//
// Stop
//
// ---------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) {
    addWarning("warn", "⚠ Nothing is running.");
    return;
  }
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: window.sessionId || null }),
    });
    const data = await res.json();
    if (data.ok || data.success) {
      addLog("success", "🛑 Stopped successfully.");
      isRunning = false;
      stopSSE();
    } else {
      addWarning("error", "❌ Stop failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Stop error: " + err.message);
  }
});

// ---------------------------
//
// SSE (Server-Sent Events)
//
// ---------------------------
function startSSE() {
  if (eventSource) eventSource.close();

  // sessionId query দিলে সার্ভার সেট করেও দেয় (cookie না থাকলেও)
  const url = window.sessionId ? `/events?sessionId=${encodeURIComponent(window.sessionId)}` : `/events`;
  eventSource = new EventSource(url);

  // Named events from server: "session" + "user"
  eventSource.addEventListener("session", (e) => {
    const sid = e.data;
    if (sid) {
      window.sessionId = sid;
      const box = document.getElementById("userIdBox");
      if (box) box.textContent = sid;
      addLog("info", "🔗 SSE session synced.");
    }
  });

  eventSource.addEventListener("user", (e) => {
    try {
      const u = JSON.parse(e.data || "{}");
      addLog("info", `👤 User status: ${u.status}${u.blocked ? " (blocked)" : ""}${u.expiry ? `, expiry: ${new Date(+u.expiry).toLocaleString()}` : ""}`);
    } catch { /* ignore */ }
  });

  // Default event (our sseLine payloads)
  eventSource.onmessage = (e) => {
    try {
      // Server sends: { t, type, text, ...extra }
      const d = JSON.parse(e.data);
      const typ = d.type || "log";
      const msg = (d.text || "").toString();

      // route by type
      if (typ === "ready") {
        addLog("info", "🔗 Live log connected.");
      } else if (typ === "log" || typ === "info") {
        addLog("info", msg);
      } else if (typ === "success") {
        addLog("success", msg);
      } else if (typ === "warn") {
        addWarning("warn", msg);
      } else if (typ === "error") {
        addWarning("error", msg);
      } else if (typ === "summary") {
        addLog("success", `📊 Summary: sent=${(d.sent ?? "-")}, ok=${(d.ok ?? "-")}, failed=${(d.failed ?? "-")}`);
        isRunning = false; // job finished
      } else {
        addLog("info", msg || JSON.stringify(d));
      }
    } catch (err) {
      addWarning("error", "⚠ SSE parse error: " + err.message);
    }
  };

  eventSource.onerror = () => {
    addWarning("error", "⚠ SSE connection lost.");
    stopSSE();
  };
}

function stopSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    addLog("info", "🔌 Live log disconnected.");
  }
}

// ---------------------------
//
// Validation helper (optional)
//
// ---------------------------
function validateMixLoopInputs(payload) {
  const posts = [
    { link: payload.link1, name: payload.name1, token: payload.token1 },
    { link: payload.link2, name: payload.name2, token: payload.token2 },
    { link: payload.link3, name: payload.name3, token: payload.token3 },
    { link: payload.link4, name: payload.name4, token: payload.token4 },
  ];
  const valid = posts.filter(p => p.link && p.name && p.token);
  if (!valid.length) {
    addWarning("error", "⚠ At least one valid post+name+token required.");
    return false;
  }
  addLog("info", `✅ ${valid.length} post(s) validated for mix loop.`);
  return true;
}

// ---------------------------
//
// Page init
//
// ---------------------------
window.addEventListener("DOMContentLoaded", async () => {
  await loadSession();     // loads + shows session id
  // SSE will be started on Start button click
});
