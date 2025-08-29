// /public/script.js
// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (FINAL)
// ===============================

let eventSource = null;
let isRunning = false;
window.sessionId = null;
window.__autoScroll = true;

// ---------------------------
// UI Helpers
// ---------------------------
function previewQuotedComment(line) {
  if (!line) return "";
  const m = line.match(/"([^"]+)"/);
  if (!m) return line;
  const full = m[1].trim();
  const words = full.split(/\s+/);
  const short = words.length <= 5 ? full : words.slice(0, 5).join(" ") + "…";
  return line.replace(`"${m[1]}"`, `"${short}"`);
}

function _esc(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}
function buildLogHTML(message){
  const ts = `[${new Date().toLocaleTimeString()}] `;
  const raw = String(message ?? "");
  let safe = _esc(raw);
  safe = safe.replace(/&quot;([^"]+)&quot;/g, (_m, c) => `&quot;<span class="f-comment">${_esc(c)}</span>&quot;`);
  safe = safe.replace(/#(\d{5,})/g, (_m, p) => `<span class="f-post">#${_esc(p)}</span>`);
  safe = safe.replace(/@([\w .\-]{2,40})/g, (_m, n) => `<span class="f-name">@${_esc(n)}</span>`);
  return `${_esc(ts)}${safe}`;
}

// ---------------------------
// Log writers (colors + highlight)
// ---------------------------
function addLog(type, message) {
  const logBox = document.getElementById("logBox");
  if (!logBox) return;
  const div = document.createElement("div");
  const t = String(type || "info").toLowerCase();
  div.className = `log-line type-${t} ${t}`; // support both CSS schemes
  div.innerHTML = buildLogHTML(message);
  logBox.appendChild(div);
  if (window.__autoScroll) logBox.scrollTop = logBox.scrollHeight;
}
function addWarning(type, message) {
  const warnBox = document.getElementById("warnBox");
  if (!warnBox) return;
  const div = document.createElement("div");
  const t = String(type || "warn").toLowerCase();
  div.className = `log-line type-${t} ${t}`;
  div.innerHTML = buildLogHTML(message);
  warnBox.appendChild(div);
  if (window.__autoScroll) warnBox.scrollTop = warnBox.scrollHeight;
}
function clearLogs() {
  const logBox = document.getElementById("logBox");
  const warnBox = document.getElementById("warnBox");
  if (logBox) logBox.innerHTML = "";
  if (warnBox) warnBox.innerHTML = "";
}

// ---------------------------
// Token chips (status badges)
// ---------------------------
const tokenMap = new Map();

function resetTokens(){ tokenMap.clear(); renderTokens(); }

function renderTokens(){
  const box = document.getElementById("tokenList");
  if(!box) return;
  box.innerHTML = "";
  const arr = [...tokenMap.entries()].sort((a,b)=>(a[1].pos ?? 9999)-(b[1].pos ?? 9999));
  for (const [tok, info] of arr){
    const chip = document.createElement("div");
    chip.className = "token-chip " + (
      info.status === "OK" ? "token-ok" :
      info.status === "BACKOFF" ? "token-backoff" :
      info.status === "NO_PERMISSION" ? "token-noperm" :
      (info.status === "REMOVED" || info.status === "ID_LOCKED" || info.status === "INVALID_TOKEN") ? "token-removed" :
      ""
    );
    chip.title = `${tok}${info.until ? ` • until: ${new Date(info.until).toLocaleTimeString()}` : ""}`;
    chip.textContent = `#${info.pos ?? "-"} ${info.status}`;
    box.appendChild(chip);
  }
}

function tokenReport() {
  const removed = [];
  const backoff = [];
  tokenMap.forEach((info, token) => {
    const pos = info.pos ?? null;
    const st  = info.status || "?";
    if (st === "REMOVED" || st === "INVALID_TOKEN" || st === "ID_LOCKED") {
      removed.push({ pos, token, status: st });
    } else if (st === "BACKOFF") {
      backoff.push({ pos, token, status: st, until: info.until || null });
    }
  });
  removed.sort((a,b)=>(a.pos??9999)-(b.pos??9999));
  backoff.sort((a,b)=>(a.pos??9999)-(b.pos??9999));
  return { removed, backoff };
}

async function copyTokenReportToClipboard() {
  const { removed, backoff } = tokenReport();
  const header = `Token Report — ${new Date().toLocaleString()}`;
  const rmLines = removed.map(r => `#${r.pos ?? "-"}  ${r.status}  ${r.token}`);
  const boLines = backoff.map(r => `#${r.pos ?? "-"}  BACKOFF  until:${r.until ? new Date(r.until).toLocaleTimeString() : "-"}  ${r.token}`);
  const text = [
    header, "",
    `REMOVED / INVALID / LOCKED (${removed.length})`,
    ...rmLines, "",
    `BACKOFF (${backoff.length})`,
    ...boLines, ""
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    addLog("success", "📋 Token report copied to clipboard.");
  } catch {
    addWarning("warn", "⚠️ Could not copy. Select from Warning box instead.");
    addWarning("warn", text);
  }
}

// ---------------------------
// Live counters + per-post table
// ---------------------------
const stats = { total:0, ok:0, fail:0 };
const perPost = new Map(); // postId -> {sent, ok, fail}

function resetStats(){
  stats.total=0; stats.ok=0; stats.fail=0;
  perPost.clear();
  renderStats(); renderPerPost();
}
function renderStats(){
  const t=document.getElementById("stTotal"),
        o=document.getElementById("stOk"),
        f=document.getElementById("stFail");
  if(t) t.textContent = `Sent: ${stats.total}`;
  if(o) o.textContent = `OK: ${stats.ok}`;
  if(f) f.textContent = `Failed: ${stats.fail}`;
}
function bumpPerPost(postId, kind){
  if(!postId) return;
  if(!perPost.has(postId)) perPost.set(postId, {sent:0, ok:0, fail:0});
  const row = perPost.get(postId);
  row.sent++;
  if(kind==="ok") row.ok++; else if(kind==="fail") row.fail++;
}
function renderPerPost(){
  const tb = document.getElementById("perPostBody"); if(!tb) return;
  tb.innerHTML = "";
  for (const [pid, r] of perPost.entries()){
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:6px;border-bottom:1px solid #333">${pid}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #333">${r.sent}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #333">${r.ok}</td>
      <td style="padding:6px;text-align:right;border-bottom:1px solid #333">${r.fail}</td>`;
    tb.appendChild(tr);
  }
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
      welcomeThenApproval();
    } else throw new Error("No session id in response");
  } catch (err) {
    const box = document.getElementById("userIdBox");
    if (box) box.textContent = "Session load failed";
    addWarning("error", "❌ Failed to load session: " + err.message);
  }
}

// ---------------------------
// Welcome → Approval flow
// ---------------------------
let __statusTimer = null;

function welcomeThenApproval() {
  const uid = document.getElementById("userIdBox")?.textContent || window.sessionId || "User";
  addLog("success", `👋 Welcome ${uid}`);

  clearTimeout(__statusTimer);
  __statusTimer = setTimeout(async () => {
    const sid = window.sessionId || uid || "";

    const endpoints = [
      `/user?ts=${Date.now()}`,
      `/user?sessionId=${encodeURIComponent(sid)}&ts=${Date.now()}`,
      `/api/user?ts=${Date.now()}`,
      `/api/user?sessionId=${encodeURIComponent(sid)}&ts=${Date.now()}`
    ];

    let u = null;
    for (const url of endpoints) {
      try {
        addLog("info", `🔎 checking ${url}`);
        const res  = await fetch(url, { credentials: "include", cache: "no-store" });
        const text = await res.text();

        if (!res.ok) {
          addWarning("warn", `🌐 ${url} → HTTP ${res.status} :: ${text.slice(0,120)}`);
          continue;
        } else {
          addLog("info", `🌐 ${url} → status:${res.status}`);
        }

        try { u = text ? JSON.parse(text) : null; } catch { u = null; }
        if (u && typeof u === "object") break;
      } catch (e) {
        addWarning("warn", `⚠ fetch failed: ${e.message}`);
      }
    }

    if (u) {
      addLog("info", `👤 Status: ${u.status} | Blocked: ${u.blocked ? "Yes" : "No"} | Expiry: ${u.expiry ? new Date(u.expiry).toLocaleString() : "∞"}`);
    }
    showApproval(u);
  }, 5000);
}

function formatDT(ts) {
  try {
    const d = new Date(+ts);
    const pad = (n) => String(n).padStart(2,"0");
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return "-"; }
}

function showApproval(u) {
  const wb = document.getElementById("warnBox");
  if (wb) wb.innerHTML = "";

  if (!u || typeof u !== "object") {
    addWarning("warn", "ℹ️ Waiting for approval status…");
    return;
  }

  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "approved";
  const falsy  = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "no";

  const statusStr = String(u.status || "");
  const blocked  = truthy(u.blocked) || /blocked/i.test(statusStr);
  const approved = truthy(u.approved) || /approved/i.test(statusStr);

  if (blocked) { addWarning("error","⛔ Your access is blocked."); return; }

  if (approved) {
    const expiry = u.expiry ?? u.expiresAt ?? u.expires_on ?? null;
    if (expiry) addLog("success", `🔓 You are approved. Your access will expire on ${formatDT(expiry)}.`);
    else addLog("success", "🔓 You have lifetime access.");
    return;
  }

  if (falsy(u.approved) || /pending|review/i.test(statusStr)) {
    addWarning("warn","📝 New user detected. Send your UserID to admin for approval.");
  } else {
    addWarning("warn","ℹ️ Waiting for approval status…");
  }
}

// ---------------------------
// File Upload (global)
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
      addLog("success", `✅ Uploaded (tokens:${data.tokens ?? 0}, comments:${data.comments ?? 0}, posts:${data.postLinks ?? 0}, names:${data.names ?? 0}).`);
    } else {
      addWarning("error", "❌ Upload failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "❌ Upload error: " + err.message);
  }
});

// ---------------------------
// Start
// ---------------------------
document.getElementById("startBtn")?.addEventListener("click", async () => {
  resetStats();
  resetTokens();

  const delayEl   = document.querySelector('[name="delay"]');
  const limitEl   = document.querySelector('[name="limit"]');
  const shuffleEl = document.querySelector('[name="useShuffle"]');
  const packEl    = document.querySelector('[name="commentSet"]');
  const modeEl    = document.querySelector('input[name="delayMode"]:checked');
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
  addLog("info", `⚡ Selected Speed Mode: ${delayMode}`);

  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        delay,
        limit,
        shuffle,
        delayMode,
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

// ---------------------------
// Stop
// ---------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) { addWarning("warn", "⚠️ Nothing is running."); return; }
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

  const bindScroll = (id) => {
    document.getElementById(id)?.addEventListener("change",(e)=>{
      window.__autoScroll = !!e.target.checked;
    });
  };
  bindScroll("autoScroll");
  bindScroll("autoScrollLogs");

  eventSource.addEventListener("user", (e) => {
    try {
      const u = JSON.parse(e.data || "{}");
      addLog("info", `👤 User status: ${u.status}${u.blocked ? " (blocked)" : ""}${u.expiry ? `, expiry: ${new Date(+u.expiry).toLocaleString()}` : ""}`);
    } catch {
      addWarning("warn", "⚠ User event parse error");
    }
  });

  eventSource.addEventListener("token", (e) => {
    try {
      const d = JSON.parse(e.data || "{}");
      tokenMap.set(d.token, {
        pos: d.position ?? d.idx ?? null,
        status: d.status || "?",
        until: d.until || null
      });
      renderTokens();
    } catch {
      addWarning("warn", "⚠ token event parse error");
    }
  });

  eventSource.onmessage = (e) => {
    try {
      const probe = JSON.parse(e.data || "{}");
      if (probe && probe.sessionId && !window.sessionId) {
        window.sessionId = probe.sessionId;
        const box = document.getElementById("userIdBox");
        if (box) box.textContent = probe.sessionId;
        addLog("info", "🔗 SSE session synced.");
        return;
      }
    } catch { /* ignore */ }

    try {
      const d = JSON.parse(e.data);
      const typ = d.type || "log";
      const rawMsg = (d.text || "").toString();
      const msg = previewQuotedComment(rawMsg);

      const PROBLEM_TYPES = new Set(["warn", "error"]);
      const PROBLEM_KEYWORDS = [
        /skip/i, /skipped/i, /could not resolve/i, /resolve failed/i,
        /no token/i, /no comment/i, /no post/i, /access denied/i, /not allowed/i,
        /expired/i, /blocked/i, /rate limit/i, /locked/i, /checkpoint/i,
        /permission/i, /unknown/i, /failed/i, /limit reached/i, /nothing to attempt/i,
        /sse connection lost/i,
      ];
      const looksProblem =
        PROBLEM_TYPES.has(typ) ||
        PROBLEM_KEYWORDS.some((rx) => rx.test(rawMsg)) ||
        !!(d.errKind || d.errMsg);

      if (typ === "ready") { addLog("info", "🔗 Live log connected."); return; }

      if (typ === "summary") {
        addLog("success", `📊 Summary: sent=${(d.sent ?? "-")}, ok=${(d.ok ?? "-")}, failed=${(d.failed ?? "-")}`);
        if (typeof d.sent === "number")   stats.total = d.sent;
        if (typeof d.ok === "number")     stats.ok    = d.ok;
        if (typeof d.failed === "number") stats.fail  = d.failed;
        renderStats();
        if ((d.failed || 0) > 0) addWarning("warn", `❗ Failures: ${d.failed} (details above).`);
        isRunning = false;
        return;
      }

      if (looksProblem) {
        const extra = d.errKind ? ` [${d.errKind}]` : "";
        addWarning(typ === "error" ? "error" : "warn", (msg || JSON.stringify(d)) + extra);
        if (typ === "error") {
          stats.fail++; 
          stats.total++;
          bumpPerPost(d.postId, "fail");
          renderStats();
          renderPerPost();
        }
      } else {
        if (typ === "log" && /✔ /.test(rawMsg)) {
          addLog("success", msg);
          stats.ok++; 
          stats.total++;
          bumpPerPost(d.postId, "ok");
          renderStats(); 
          renderPerPost();
        } else if (typ === "success") {
          addLog("success", msg);
          stats.ok++; 
          stats.total++;
          bumpPerPost(d.postId, "ok");
          renderStats(); 
          renderPerPost();
        } else {
          addLog("info", msg || JSON.stringify(d));
        }
      }
    } catch (err) {
      addWarning("error", "⚠ SSE parse error: " + (err?.message || err));
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

  const bindScroll = (id) => {
    document.getElementById(id)?.addEventListener("change",(e)=>{
      window.__autoScroll = !!e.target.checked;
    });
  };
  bindScroll("autoScroll");
  bindScroll("autoScrollLogs");

  document.getElementById("btnCopyReport")?.addEventListener("click", () => {
    copyTokenReportToClipboard();
  });
});
