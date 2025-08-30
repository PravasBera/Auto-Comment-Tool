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
  const short = words.length <= 5 ? full : words.slice(0, 5).join(" ") + "â€¦";
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
    chip.title = `${tok}${info.until ? ` â€¢ until: ${new Date(info.until).toLocaleTimeString()}` : ""}`;
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
  const header = `Token Report â€” ${new Date().toLocaleString()}`;
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
    addLog("success", "ðŸ“‹ Token report copied to clipboard.");
  } catch {
    addWarning("warn", "âš ï¸ Could not copy. Select from Warning box instead.");
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
      addLog("success", "âœ… Session ID loaded.");
      welcomeThenApproval();
    } else throw new Error("No session id in response");
  } catch (err) {
    const box = document.getElementById("userIdBox");
    if (box) box.textContent = "Session load failed";
    addWarning("error", "âŒ Failed to load session: " + err.message);
  }
}

// ---------------------------
// Welcome â†’ Approval flow
// ---------------------------
let __statusTimer = null;

function welcomeThenApproval() {
  const uid = document.getElementById("userIdBox")?.textContent || window.sessionId || "User";
  addLog("success", `ðŸ‘‹ Welcome ${uid}`);

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
        const res  = await fetch(url, { credentials: "include", cache: "no-store" });
        const text = await res.text();

        if (!res.ok) {
          continue; // âŒ HTTP error à¦¹à¦²à§‡ à¦šà§à¦ªà¦šà¦¾à¦ª à¦ªà¦°à§‡à¦°à¦Ÿà¦¾à¦¤à§‡ à¦¯à¦¾à¦¬à§‡
        }

        try { 
          u = text ? JSON.parse(text) : null; 
        } catch { 
          u = null; 
        }
        if (u && typeof u === "object") break;
      } catch (e) {
        // âŒ fetch failed à¦¹à¦²à§‡ à¦¶à§à¦§à§ à¦²à§à¦ª continue
        continue;
      }
    }

    if (u) {
      addLog("info", `ðŸ‘¤ Status: ${u.status} | Blocked: ${u.blocked ? "Yes" : "No"} | Expiry: ${u.expiry ? new Date(u.expiry).toLocaleString() : "âˆž"}`);
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
    addWarning("warn", "â„¹ï¸ Waiting for approval statusâ€¦");
    return;
  }

  const truthy = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "approved";
  const falsy  = (v) => v === false || v === 0 || v === "0" || v === "false" || v === "no";

  const statusStr = String(u.status || "");
  const blocked  = truthy(u.blocked) || /blocked/i.test(statusStr);
  const approved = truthy(u.approved) || /approved/i.test(statusStr);

  if (blocked) { addWarning("error","â›” Your access is blocked."); return; }

  if (approved) {
    const expiry = u.expiry ?? u.expiresAt ?? u.expires_on ?? null;
    if (expiry) addLog("success", `ðŸ”“ You are approved. Your access will expire on ${formatDT(expiry)}.`);
    else addLog("success", "ðŸ”“ You have lifetime access.");
    return;
  }

  if (falsy(u.approved) || /pending|review/i.test(statusStr)) {
    addWarning("warn","ðŸ“ New user detected. Send your UserID to admin for approval.");
  } else {
    addWarning("warn","â„¹ï¸ Waiting for approval statusâ€¦");
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
    addLog("info", "â³ Uploading filesâ€¦");
    const res = await fetch("/upload", {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const data = await res.json();
    if (data.ok) {
      addLog("success", `âœ… Uploaded (tokens:${data.tokens ?? 0}, comments:${data.comments ?? 0}, posts:${data.postLinks ?? 0}, names:${data.names ?? 0}).`);
    } else {
      addWarning("error", "âŒ Upload failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "âŒ Upload error: " + err.message);
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
  const shuffleEl = document.querySelector('[name="shuffle"]');
  const packEl    = document.querySelector('[name="commentSet"]');
  const modeEl    = document.querySelector('input[name="speedMode"]:checked');
  const speedMode = modeEl ? modeEl.value : "fast";

  const delay   = parseInt(delayEl?.value || "20", 10);
  const limit   = parseInt(limitEl?.value || "0", 10);
  const shuffle = !!(shuffleEl?.checked);
  const commentPack = (packEl?.value || "").trim();

   // 🔥 Advanced settings (fixed names)
  const advSettings = {
    roundJitterMaxMs:  parseInt(document.querySelector('[name="roundJitterMaxMs"]')?.value || "80", 10),
    tokenCooldownMs:   parseInt(document.querySelector('[name="tokenCooldownMs"]')?.value || "10", 10),
    quotaPerTokenHour: parseInt(document.querySelector('[name="quotaPerTokenHour"]')?.value || "100", 10),
    namesPerComment:   parseInt(document.querySelector('[name="namesPerComment"]')?.value || "1", 10),
    limitPerPost:      parseInt(document.querySelector('[name="limitPerPost"]')?.value || "50", 10),
    removeBadTokens:   !!document.querySelector('[name="removeBadTokens"]')?.checked,
    blockedBackoffMs:  parseInt(document.querySelector('[name="blockedBackoffMs"]')?.value || "600000", 10),
    requestTimeoutMs:  parseInt(document.querySelector('[name="requestTimeoutMs"]')?.value || "12000", 10),
    retryCount:        parseInt(document.querySelector('[name="retryCount"]')?.value || "1", 10),
    sseBatchMs:        parseInt(document.querySelector('[name="sseBatchMs"]')?.value || "600", 10),
    tokenGlobalRing:   !!document.querySelector('[name="tokenGlobalRing"]')?.checked
  };

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

  addLog("info", "ðŸš€ Sending start requestâ€¦");
  addLog("info", `âš¡ Selected Speed Mode: ${speedMode}`);

  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        delay,
        limit,
        shuffle,
        speedMode,
        sessionId: window.sessionId || "",
        posts,
      }),
    });
    const data = await res.json();

    if (data.ok) {
      addLog("success", "âœ… Commenting started.");
      isRunning = true;
      startSSE();
    } else {
      addWarning("error", "âŒ Start failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "âŒ Start request error: " + err.message);
  }
});

// ---------------------------
// Stop
// ---------------------------
document.getElementById("stopBtn")?.addEventListener("click", async () => {
  if (!isRunning) { addWarning("warn", "âš ï¸ Nothing is running."); return; }
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: window.sessionId || "" }),
    });
    const data = await res.json();
    if (data.ok) {
      addLog("success", "ðŸ›‘ Stopped successfully.");
      isRunning = false;
      stopSSE();
    } else {
      addWarning("error", "âŒ Stop failed: " + (data.message || data.error || "Unknown"));
    }
  } catch (err) {
    addWarning("error", "âŒ Stop request error: " + err.message);
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
      addLog("info", `ðŸ‘¤ User status: ${u.status}${u.blocked ? " (blocked)" : ""}${u.expiry ? `, expiry: ${new Date(+u.expiry).toLocaleString()}` : ""}`);
    } catch {
      addWarning("warn", "âš  User event parse error");
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
      addWarning("warn", "âš  token event parse error");
    }
  });

  eventSource.onmessage = (e) => {
    try {
      const probe = JSON.parse(e.data || "{}");
      if (probe && probe.sessionId && !window.sessionId) {
        window.sessionId = probe.sessionId;
        const box = document.getElementById("userIdBox");
        if (box) box.textContent = probe.sessionId;
        addLog("info", "ðŸ”— SSE session synced.");
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

      if (typ === "ready") { addLog("info", "ðŸ”— Live log connected."); return; }

      if (typ === "summary") {
        addLog("success", `ðŸ“Š Summary: sent=${(d.sent ?? "-")}, ok=${(d.ok ?? "-")}, failed=${(d.failed ?? "-")}`);
        if (typeof d.sent === "number")   stats.total = d.sent;
        if (typeof d.ok === "number")     stats.ok    = d.ok;
        if (typeof d.failed === "number") stats.fail  = d.failed;
        renderStats();
        if ((d.failed || 0) > 0) addWarning("warn", `â— Failures: ${d.failed} (details above).`);
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
        if (typ === "log" && /âœ” /.test(rawMsg)) {
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
      addWarning("error", "âš  SSE parse error: " + (err?.message || err));
    }
  };

  eventSource.onerror = () => {
    addWarning("error", "âš  SSE connection lost.");
    stopSSE();
  };
}

function stopSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    addLog("info", "ðŸ”Œ Live log disconnected.");
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
