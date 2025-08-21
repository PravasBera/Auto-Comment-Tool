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
