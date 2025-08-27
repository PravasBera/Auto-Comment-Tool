// /public/script.js
// ===============================
// Facebook Auto Comment Tool Pro
// Frontend Script (Client-Side) — READY
// ===============================

let eventSource = null;
let isRunning = false;
window.sessionId = null;
window.__autoScroll = true; // auto-scroll toggle (checkbox থাকলে bind হবে)

// ---------------------------
// UI Helpers
// ---------------------------

// Only show first 5 words of the quoted comment in a log line
function previewQuotedComment(line) {
  if (!line) return "";
  const m = line.match(/"([^"]+)"/); // find first "comment" part
  if (!m) return line;               // no quoted comment -> return as is
  const full = m[1].trim();
  const words = full.split(/\s+/);
  const short = words.length <= 5 ? full : words.slice(0, 5).join(" ") + "…";
  return line.replace(`"${m[1]}"`, `"${short}"`);
}

function addLog(type, message) {
  const logBox = document.getElementById("logBox");
  if (!logBox) return;
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logBox.appendChild(div);
  if (window.__autoScroll) logBox.scrollTop = logBox.scrollHeight;
}

function addWarning(type, message) {
  const warnBox = document.getElementById("warnBox");
  if (!warnBox) return;
  const div = document.createElement("div");
  div.className = type;
  div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  warnBox.appendChild(div);
  if (window.__autoScroll) warnBox.scrollTop = warnBox.scrollHeight;
}

function clearLogs() {
  const logBox = document.getElementById("logBox");
  const warnBox = document.getElementById("warnBox");
  if (logBox) logBox.innerHTML = "";
  if (warnBox) warnBox.innerHTML = "";
}

// ---- Token report helpers ----
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

// ---- Token status (chips) ----
const tokenMap = new Map();
function resetTokens(){ tokenMap.clear(); renderTokens(); }
function renderTokens(){
  const box = document.getElementById("tokenList"); if(!box) return;
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

// ---- Live counters ----
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
// Welcome → Approval flow (FINAL)
// ---------------------------

let __statusTimer = null;

function welcomeThenApproval() {
  const uid = document.getElementById("userIdBox")?.textContent || window.sessionId || "User";
  addLog("success", `👋 Welcome ${uid}`);

  clearTimeout(__statusTimer);
  __statusTimer = setTimeout(async () => {
    const sid = window.sessionId || uid || "";

    // একাধিক fallback endpoint – কুকি না থাকলেও query param এ sessionId
    const endpoints = [
      `/user?ts=${Date.now()}`,
      `/user?sessionId=${encodeURIComponent(sid)}&ts=${Date.now()}`,
      `/api/user?ts=${Date.now()}`,
      `/api/user?sessionId=${encodeURIComponent(sid)}&ts=${Date.now()}`,
    ];

    let u = null;
    for (const url of endpoints) {
      try {
        addLog("info", `🔎 checking ${url}`);
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        const text = await res.text();
        addLog("info", `🌐 ${url} → status:${res.status}, body:${text || "(empty)"}`);
        if (!res.ok) continue;
        try { u = text ? JSON.parse(text) : null; } catch { u = null; }
        if (u && typeof u === "object") break; // usable object পেলে বের হয়ে যাও
      } catch (e) {
        addWarning("warn", `⚠ fetch failed: ${e.message}`);
      }
    }

    addLog("info", `👤 Raw user payload: ${JSON.stringify(u)}`);
    showApproval(u);
  }, 5000);
}

// ---- helpers: approval formatting & message ----
function formatDT(ts) {
  try {
    const d = new Date(+ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} - ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return "-"; }
}

function showApproval(u) {
  // আগের warning গুলো ক্লিয়ার (ইচ্ছেমতো রাখো)
  const wb = document.getElementById("warnBox");
  if (wb) wb.innerHTML = "";

  if (!u || typeof u !== "object") {
    addWarning("warn", "ℹ️ Waiting for approval status…");
    return;
  }

  // truthy/falsy helpers
  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "approved";
  const falsy  = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "no";

  const statusStr = String(u.status || "");
  const blocked  = truthy(u.blocked) || /blocked/i.test(statusStr);
  const approved = truthy(u.approved) || /approved/i.test(statusStr);

  if (blocked) {
    addWarning("error", "⛔ Your access is blocked.");
    return;
  }

  if (approved) {
    const expiry = u.expiry ?? u.expiresAt ?? u.expires_on ?? null;
    if (expiry) {
      addLog("success", `🔓 You are approved. Your access will expire on ${formatDT(expiry)}.`);
    } else {
      addLog("success", "🔓 You have lifetime access.");
    }
    return;
  }

  // approved=false / pending / review
  if (falsy(u.approved) || /pending|review/i.test(statusStr)) {
    addWarning("warn", "📝 New user detected. Send your UserID to admin for approval.");
  } else {
    addWarning("warn", "ℹ️ Waiting for approval status…");
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
  // reset stats for new run
  resetStats();
resetTokens();   // ✅ token chips reset

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

  // optional: bind autosroll checkbox if present
  document.getElementById("autoScroll")?.addEventListener("change", (e)=>{
    window.__autoScroll = !!e.target.checked;
  });

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
      const rawMsg = (d.text || "").toString();
      const msg = previewQuotedComment(rawMsg);

      // 🔎 যেগুলো সবসময় Warning Box-এ যাবে
      const PROBLEM_TYPES = new Set(["warn", "error"]);

      // 🔎 'info'/'log' হয়েও সমস্যা বোঝায়—এসব keyword ধরলেই Warning Box-এ
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
        !!(d.errKind || d.errMsg); // server extra payload থাকলে

// token status comes as default 'message' with type:"token"
if (typ === "token") {
  tokenMap.set(d.token, {
    pos: d.position ?? d.idx ?? null,
    status: d.status || "?",
    until: d.until || null
  });
  renderTokens();
  return;
}
      
      if (typ === "ready") {
        addLog("info", "🔗 Live log connected.");
        return;
      }

      if (typ === "summary") {
        addLog(
          "success",
          `📊 Summary: sent=${(d.sent ?? "-")}, ok=${(d.ok ?? "-")}, failed=${(d.failed ?? "-")}`
        );
        // overwrite counters from summary if provided
        if (typeof d.sent === "number")   stats.total = d.sent;
        if (typeof d.ok === "number")     stats.ok    = d.ok;
        if (typeof d.failed === "number") stats.fail  = d.failed;
        renderStats();

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

        // error হলে counters bump
        if (typ === "error") {
          stats.fail++; 
          stats.total++;
          bumpPerPost(d.postId, "fail");
          renderStats(); 
          renderPerPost();
        }
      } else {
        // success-like 'log' (server type 'log' with check mark)
        if (typ === "log" && /✔ /.test(rawMsg)) {
          addLog("success", msg);
          stats.ok++; 
          stats.total++;
          bumpPerPost(d.postId, "ok");
          renderStats(); 
          renderPerPost();
        } else if (typ === "success") {
          // in case server ever sends explicit success
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

document.getElementById("btnCopyReport")?.addEventListener("click", () => {
  copyTokenReportToClipboard();
});
  
// ---------------------------
// Page init
// ---------------------------
window.addEventListener("DOMContentLoaded", async () => {
  await loadSession();

  // bind autosroll checkbox if present in DOM
  document.getElementById("autoScroll")?.addEventListener("change", (e)=>{
    window.__autoScroll = !!e.target.checked;
  });
});
