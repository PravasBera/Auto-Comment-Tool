// /public/script.js
// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (FINAL)
// ===============================

let eventSource = null;
let isRunning = false;
window.sessionId = null;
window.__autoScroll = true; // auto-scroll toggle (both checkboxes bind)

// ---------------------------
// UI Helpers
// ---------------------------

function previewQuotedComment(line) {
  if (!line) return "";
  const m = line.match(/"([^"]+)"/); // find first quoted comment
  if (!m) return line;
  const full = m[1].trim();
  const words = full.split(/\s+/);
  const short = words.length <= 5 ? full : words.slice(0, 5).join(" ") + "…";
  return line.replace(`"${m[1]}"`, `"${short}"`);
}

// ---------------------------
// Colored Logs (NEW system)
// ---------------------------
const $log  = document.getElementById('logBox');
const $warn = document.getElementById('warnBox');

function normType(t='info'){
  t = String(t).toLowerCase();
  if (t === 'ok' || t === 'success' || /passed?/.test(t)) return 'success';
  if (t.startsWith('warn')) return 'warning';
  if (t === 'error' || /fail/.test(t)) return 'error';
  return 'info';
}
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function makeLine(type, msg, meta){
  const t = normType(type);
  const p = document.createElement('p');
  p.className = `log-line type-${t}`;
  const ts = new Date().toLocaleTimeString();
  const namePart = meta?.name   ? ` <span class="f-name">@${esc(meta.name)}</span>`   : '';
  const postPart = meta?.postId ? ` <span class="f-post">#${esc(meta.postId)}</span>` : '';
  const cmtPart  = meta?.comment? ` <span class="f-comment">“${esc(meta.comment)}”</span>` : '';
  p.innerHTML = `<span class="log-time">[${ts}]</span>${esc(msg)}${namePart}${postPart}${cmtPart}`;
  return p;
}
function pushToBoxes(type, msg, meta){
  const line = makeLine(type, msg, meta);
  const clone = line.cloneNode(true);
  if ($log){  $log.appendChild(line);  if (window.__autoScroll !== false) $log.scrollTop  = $log.scrollHeight; }
  if ($warn){ $warn.appendChild(clone); if (window.__autoScroll !== false) $warn.scrollTop = $warn.scrollHeight; }
}

// Public APIs
window.logEvent = function(type, msg, meta={}){ pushToBoxes(type, msg, meta); };
window.reportCommentEvent = function(status, name, postId, comment){
  pushToBoxes(status,
    status==='success' ? 'Comment sent' :
    status==='warning' ? 'Warning' :
    status==='error'   ? 'Error' : 'Info',
    { name, postId, comment }
  );
};
window.logSmart = function(raw, meta={}){
  const s = String(raw);
  let type = 'info';
  if (/^\s*(ok|success|ok)/i.test(s))       type='success';
  else if (/^\s*(warn|warning)/i.test(s))       type='warning';
  else if (/^\s*(error|fail|failed|oauth)/i.test(s)) type='error';
  pushToBoxes(type, s, meta);
};

// Bridge old addLog/addWarning → new renderer
window.addLog = function(type, message) {
  logEvent(type, message);
};
window.addWarning = function(type, message) {
  logEvent(type || "warning", message);
};
function clearLogs() {
  if ($log) $log.innerHTML = "";
  if ($warn) $warn.innerHTML = "";
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
      (info.status === "REMOVED" || info.status === "ID_LOCKED" || info.status === "INVALID_TOKEN") ? "token-removed" :
      info.status === "NO_PERMISSION" ? "token-noperm" : ""
    );
    chip.title = `${tok}${info.until ? ` • until: ${new Date(info.until).toLocaleTimeString()}` : ""}`;
    chip.textContent = `#${info.pos ?? "-"} ${info.status}`;
    box.appendChild(chip);
  }
}

// Copyable token report
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
    logEvent("success", "📋 Token report copied to clipboard.");
  } catch {
    logEvent("warning", "⚠️ Could not copy. Select from Warning box instead.");
    logEvent("warning", text);
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
  const t=document.getElementById("stTotal"), o=document.getElementById("stOk"), f=document.getElementById("stFail");
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
      logEvent("success", "✅ Session ID loaded.");
      welcomeThenApproval();
    } else throw new Error("No session id in response");
  } catch (err) {
    const box = document.getElementById("userIdBox");
    if (box) box.textContent = "Session load failed";
    logEvent("error", "❌ Failed to load session: " + err.message);
  }
}

// ---------------------------
// Welcome → Approval flow
// ---------------------------
let __statusTimer = null;

function welcomeThenApproval() {
  const uid = document.getElementById("userIdBox")?.textContent || window.sessionId || "User";
  logEvent("success", `👋 Welcome ${uid}`);

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
        logEvent("info", `🔎 checking ${url}`);
        const res  = await fetch(url, { credentials: "include", cache: "no-store" });
        const text = await res.text();

        if (!res.ok) {
          logEvent("warning", `🌐 ${url} → HTTP ${res.status} :: ${text.slice(0,120)}`);
          continue;
        } else {
          logEvent("info", `🌐 ${url} → status:${res.status}`);
        }

        try { u = text ? JSON.parse(text) : null; } catch { u = null; }
        if (u && typeof u === "object") break;
      } catch (e) {
        logEvent("warning", `⚠ fetch failed: ${e.message}`);
      }
    }

    if (u) {
      logEvent("info", `👤 Status: ${u.status} | Blocked: ${u.blocked ? "Yes" : "No"} | Expiry: ${u.expiry ? new Date(u.expiry).toLocaleString() : "∞"}`);
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
    logEvent("warning", "ℹ️ Waiting for approval status…");
    return;
  }

  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "approved";
  const falsy  = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "no";

  const statusStr = String(u.status || "");
  const blocked  = truthy(u.blocked) || /blocked/i.test(statusStr);
  const approved = truthy(u.approved) || /approved/i.test(statusStr);

  if (blocked) { logEvent("error","⛔ Your access is blocked."); return; }

  if (approved) {
    const expiry = u.expiry ?? u.expiresAt ?? u.expires_on ?? null;
    if (expiry) logEvent("success", `🔓 You are approved. Your access will expire on ${formatDT(expiry)}.`);
    else logEvent("success", "🔓 You have lifetime access.");
    return;
  }

  if (falsy(u.approved) || /pending|review/i.test(statusStr)) {
    logEvent("warning","📝 New user detected. Send your UserID to admin for approval.");
  } else {
    logEvent("warning","ℹ️ Waiting for approval status…");
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
    logEvent("info", "⏳ Uploading files…");
    const res = await fetch("/upload", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      logEvent("success", `✅ Uploaded (tokens:${data.tokens ?? 0}, comments:${data.comments ?? 0}, posts:${data.postLinks ?? 0}, names:${data.names ?? 0}).`);
    } else {
      logEvent("error", "❌ Upload failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    logEvent("error", "❌ Upload error: " + err.message);
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

  logEvent("info", "🚀 Sending start request…");
  logEvent("info", `⚡ Selected Speed Mode: ${delayMode}`);

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
      logEvent("success", "✅ Commenting started.");
      isRunning = true;
      startSSE();
    } else {
      logEvent("error", "❌ Start failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    logEvent("error", "❌ Start request error: " + err.message);
  }
});

// ---------------------------
// Stop
// ---------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) { logEvent("warning", "⚠️ Nothing is running."); return; }
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: window.sessionId || "" }),
    });
    const data = await res.json();
    if (data.ok) {
      logEvent("success", "🛑 Stopped successfully.");
      isRunning = false;
      stopSSE();
    } else {
      logEvent("error", "❌ Stop failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    logEvent("error", "❌ Stop request error
