// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (Client-Side)
// ===============================

// Global variables
let eventSource = null;
let isRunning = false;

// ---------------------------
// Utility Functions
// ---------------------------

// Add log messages to Live Log
function addLog(type, message) {
  const logBox = document.getElementById("logBox");
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.appendChild(div);
  logBox.scrollTop = logBox.scrollHeight;
}

// Add warning or summary messages
function addWarning(type, message) {
  const warnBox = document.getElementById("warnBox");
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  warnBox.appendChild(div);
  warnBox.scrollTop = warnBox.scrollHeight;
}

// Clear log boxes
function clearLogs() {
  document.getElementById("logBox").innerHTML = "";
  document.getElementById("warnBox").innerHTML = "";
}

// ---------------------------
// File Upload Section
// ---------------------------
document.getElementById("uploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);

  try {
    addLog("info", "⏳ Uploading files...");
    const res = await fetch("/upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (data.ok) {
      addLog("success", "✅ Files uploaded successfully.");
    } else {
      addWarning("error", "❌ Upload failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Upload error: " + err.message);
  }
});

// ---------------------------
// Manual Form Start Section
// ---------------------------
document.getElementById("startForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isRunning) {
    addWarning("warn", "⚠ Already running. Stop first.");
    return;
  }

  clearLogs();
  addLog("info", "▶ Starting Auto Comment Tool...");

  const formData = new FormData(e.target);
  const payload = {};

  formData.forEach((val, key) => {
    payload[key] = val.trim();
  });

  payload["shuffle"] = formData.get("useShuffle") ? true : false;
  payload["commentSet"] = formData.get("commentSet") || "";

  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.success) {
      addLog("success", "🚀 Task started successfully.");
      startSSE();
      isRunning = true;
    } else {
      addWarning("error", "❌ Failed to start: " + data.message);
    }
  } catch (err) {
    addWarning("error", "❌ Start error: " + err.message);
  }
});

// ---------------------------
// Stop Button
// ---------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) {
    addWarning("warn", "⚠ Nothing is running.");
    return;
  }

  try {
    const res = await fetch("/stop", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      addLog("success", "🛑 Stopped successfully.");
      stopSSE();
      isRunning = false;
    } else {
      addWarning("error", "❌ Stop failed: " + data.message);
    }
  } catch (err) {
    addWarning("error", "❌ Stop error: " + err.message);
  }
});

// ---------------------------
// SSE (Server-Sent Events) for Live Logs
// ---------------------------
function startSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource("/events");

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "log") {
        addLog("info", data.message);
      } else if (data.type === "success") {
        addLog("success", data.message);
      } else if (data.type === "error") {
        addWarning("error", data.message);
      } else if (data.type === "warn") {
        addWarning("warn", data.message);
      }
    } catch (err) {
      addWarning("error", "⚠ SSE parse error: " + err.message);
    }
  };

  eventSource.onerror = () => {
    addWarning("error", "⚠ SSE connection lost.");
    stopSSE();
  };

  addLog("info", "🔗 Connected to Live Log stream.");
}

function stopSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    addLog("info", "🔌 Disconnected from Live Log stream.");
  }
}

// ---------------------------
// Mix Loop (Frontend Validation Only)
// ---------------------------

function validateMixLoopInputs(payload) {
  const posts = [
    { link: payload.link1, name: payload.name1, token: payload.token1 },
    { link: payload.link2, name: payload.name2, token: payload.token2 },
    { link: payload.link3, name: payload.name3, token: payload.token3 },
    { link: payload.link4, name: payload.name4, token: payload.token4 },
  ];

  const validPosts = posts.filter(
    (p) => p.link && p.name && p.token
  );

  if (validPosts.length === 0) {
    addWarning("error", "⚠ At least one valid post+name+token required.");
    return false;
  }

  addLog("info", `✅ ${validPosts.length} post(s) validated for mix loop.`);
  return true;
}

// ---------------------------
// On Page Load (Session fetch)
// ---------------------------
window.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/session");   // 🔥 "/userid" → "/session"
    const data = await res.json();
    if (data.id) {
      document.getElementById("userIdBox").textContent = data.id;
      addLog("success", "✅ Session ID loaded successfully.");
    } else {
      document.getElementById("userIdBox").textContent = "Error loading Session ID";
      addWarning("error", "❌ Failed to fetch Session ID.");
    }
  } catch (err) {
    document.getElementById("userIdBox").textContent = "Network error";
    addWarning("error", "❌ Session fetch error: " + err.message);
  }
});

// ---------------------------
// Debug Helper
// ---------------------------
function debugPayload(payload) {
  console.group("Payload Debug");
  console.log("Delay:", payload.delay);
  console.log("Limit:", payload.limit);
  console.log("Shuffle:", payload.shuffle);
  console.log("Comment Category:", payload.commentCategory);
  console.log("Post1:", payload.link1, payload.name1, payload.token1);
  console.log("Post2:", payload.link2, payload.name2, payload.token2);
  console.log("Post3:", payload.link3, payload.name3, payload.token3);
  console.log("Post4:", payload.link4, payload.name4, payload.token4);
  console.groupEnd();
}
