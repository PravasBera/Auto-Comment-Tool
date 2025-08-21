const logBox = document.getElementById("logBox");
const warnBox = document.getElementById("warnBox");

// Append helper
function addLine(el, text, cls = "") {
  const d = document.createElement("div");
  d.className = `log-line ${cls}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

// Connect SSE
function connectSSE() {
  const es = new EventSource("/events");
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const { type, text } = data;

      // classify to boxes
      if (type === "error") addLine(warnBox, text, "log-error");
      else if (type === "warn") addLine(warnBox, text, "log-warn");
      else if (type === "success") addLine(logBox, text, "log-success");
      else if (type === "summary") {
        addLine(logBox, text, "log-summary");
        // also show counters if present
        if (data.counters) {
          const c = data.counters;
          addLine(warnBox, `Invalid Token: ${c.INVALID_TOKEN || 0}`, "log-warn");
          addLine(warnBox, `Wrong Post ID/Link: ${c.WRONG_POST_ID || 0}`, "log-warn");
          addLine(warnBox, `No Permission: ${c.NO_PERMISSION || 0}`, "log-warn");
          addLine(warnBox, `Comment Blocked: ${c.COMMENT_BLOCKED || 0}`, "log-warn");
          addLine(warnBox, `ID Locked: ${c.ID_LOCKED || 0}`, "log-warn");
          addLine(warnBox, `Unknown: ${c.UNKNOWN || 0}`, "log-warn");
        }
        if (typeof data.unresolvedLinks === "number") {
          addLine(warnBox, `Unresolved links: ${data.unresolvedLinks}`, "log-warn");
        }
      }
      else addLine(logBox, text, "log-info");

      // Extra pretty line for each successful comment
      if (data.type === "log" && data.account && data.comment && data.postId) {
        addLine(logBox, `✔ ${data.account} → "${data.comment}" on ${data.postId}`, "log-success");
      }
    } catch {}
  };
  es.onerror = () => {
    // reconnect automatically (browser does this) – keep quiet
  };
}
connectSSE();

// Upload handler
document.getElementById("uploadForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  addLine(logBox, "Uploading files...", "log-info");
  const res = await fetch("/upload", { method: "POST", body: fd });
  const data = await res.json();
  if (data.ok) addLine(logBox, "Files uploaded successfully", "log-success");
  else addLine(warnBox, "Upload failed: " + (data.message || "unknown"), "log-error");
});

// Start job
document.getElementById("startForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  addLine(logBox, "Starting job...", "log-info");

  const res = await fetch("/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (data.ok) addLine(logBox, "Job started", "log-success");
  else addLine(warnBox, "Cannot start: " + (data.message || "unknown"), "log-error");
});

// Stop job
document.getElementById("stopBtn").addEventListener("click", async () => {
  const res = await fetch("/stop", { method: "POST" });
  const data = await res.json();
  addLine(warnBox, data.message || "Stop requested", "log-warn");
});
