// /public/script.js
// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (Client-Side) — FIXED for your index.html
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
    } else throw new Error("No session id in response");
  } catch (err) {
    const box = document.getElementById("userIdBox");
    if (box) box.textContent = "Session load failed";
    addWarning("error", "❌ Failed to load session: " + err.message);
  }
}

// ---------------------------
// File Upload  (matches your form field names)
// ---------------------------
document.getElementById("uploadForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);

  if (window.sessionId) formData.append("sessionId", window.sessionId);

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
        `✅ Uploaded (tokens:${data.tokens ?? 0}, comments:${data.comments ?? 0}, posts:${data.postLinks ?? 0}, names:${data.names ?? 0}).`
      );
    } else {
      addWarning("error", "❌ Upload failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Upload error: " + err.message);
  }
});

// -------------------------
// Start
// -------------------------
document.getElementById("startBtn")?.addEventListener("click", async () => {
  const delayEl   = document.querySelector('[name="delay"]');
  const limitEl   = document.querySelector('[name="limit"]');
  const shuffleEl = document.querySelector('[name="useShuffle"]');
  const packEl    = document.querySelector('[name="commentSet"]');
  // inside startBtn click handler
const modeEl = document.querySelector('input[name="delayMode"]:checked');
const delayMode = modeEl ? modeEl.value : "fast";

  const delay   = parseInt(delayEl?.value || "20", 10);
  const limit   = parseInt(limitEl?.value || "0", 10);
  const shuffle = !!(shuffleEl?.checked);
  const commentPack = (packEl?.value || "").trim();

  const posts = [];
  for (let i = 1; i <= 4; i++) {
    const targetEl = document.querySelector(`[name="postLinks${i}"]`);
    const namesEl  = document.querySelector(`[name="names${i}"]`);
    const target   = targetEl ? targetEl.value.trim() : "";
    const names    = namesEl ? namesEl.value.trim() : "";
    if (target) {
      posts.push({
        target,
        names: names || "",
        tokens: "",
        comments: "",
        commentPack: commentPack || "Default",
      });
    }
  }

  addLog("info", "🚀 Sending start request…");

  try {
    const res = await fetch("/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    delay,
    limit,
    shuffle,
    delayMode,  // ✅ নতুন field
    sessionId: window.sessionId || "",
    posts,
  }),
});
    const data = await res.json();

    if (data.ok) {
      addLog("success", "✅ Commenting started.");
      isRunning = true;
      startSSE();
    } else {
      addWarning("error", "❌ Start failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Start request error: " + err.message);
  }
});

// -------------------------
// Stop
// -------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) {
    addWarning("warn", "⚠️ Nothing is running.");
    return;
  }
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: window.sessionId || "" }),
    });
    const data = await res.json();
    if (data.ok) {
      addLog("success", "🛑 Stopped successfully.");
      isRunning = false;
      stopSSE();
    } else {
      addWarning("error", "❌ Stop failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Stop request error: " + err.message);
  }
});

// ---------------------------
// SSE (Server-Sent Events)
// ---------------------------
function startSSE() {
  if (eventSource) eventSource.close();
  const url = window.sessionId ? `/events?sessionId=${encodeURIComponent(window.sessionId)}` : `/events`;
  eventSource = new EventSource(url);

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
    } catch {
      addWarning("warn", "⚠ User event parse error");
    }
  });

  eventSource.onmessage = (e) => {
  try {
    const d = JSON.parse(e.data);
    const typ = d.type || "log";
    const msg = (d.text || "").toString();

    // 🔎 যেগুলো সবসময় Warning Box-এ যাবে
    const PROBLEM_TYPES = new Set(["warn", "error"]);

    // 🔎 'info'/'log' হয়েও সমস্যা বোঝায়—এসব keyword ধরলেই Warning Box-এ
    const PROBLEM_KEYWORDS = [
      /skip/i,
      /skipped/i,
      /could not resolve/i,
      /resolve failed/i,
      /no token/i,
      /no comment/i,
      /no post/i,
      /access denied/i,
      /not allowed/i,
      /expired/i,
      /blocked/i,
      /rate limit/i,
      /locked/i,
      /checkpoint/i,
      /permission/i,
      /unknown/i,
      /failed/i,
      /limit reached/i,
      /nothing to attempt/i,
      /sse connection lost/i,
    ];

    const looksProblem =
      PROBLEM_TYPES.has(typ) ||
      PROBLEM_KEYWORDS.some((rx) => rx.test(msg)) ||
      // server extra payload থাকলে
      !!(d.errKind || d.errMsg);

    if (typ === "ready") {
      addLog("info", "🔗 Live log connected.");
      return;
    }

    if (typ === "summary") {
      addLog("success", `📊 Summary: sent=${(d.sent ?? "-")}, ok=${(d.ok ?? "-")}, failed=${(d.failed ?? "-")}`);
      // ❗ summary-তে fail > 0 হলে warning box-এও দেখাও
      if ((d.failed || 0) > 0) {
        addWarning("warn", `❗ Failures: ${d.failed} (details above).`);
      }
      isRunning = false;
      return;
    }

    // ✅ সমস্যা হলে Warning Box-এ, নাহলে Log Box-এ
if (looksProblem) {
  const extra = d.errKind ? ` [${d.errKind}]` : "";
  addWarning(typ === "error" ? "error" : "warn", (msg || JSON.stringify(d)) + extra);
} else if (typ === "success") {
  addLog("success", msg);
} else {
  addLog("info", msg || JSON.stringify(d));
}
    }
  } catch (err) {
    addWarning("error", "⚠ SSE parse error: " + err.message + " (raw: " + e.data + ")");
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
// Page init
// ---------------------------
window.addEventListener("DOMContentLoaded", async () => {
  await loadSession();
});
