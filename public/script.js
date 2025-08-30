// /public/script.js
// =====================================================
// Facebook Auto Comment Tool Pro (FINAL FULL)
// With Advanced Settings + Floating Log + SSE Support
// =====================================================

let eventSource = null;
let isRunning = false;
window.sessionId = null;
window.__autoScroll = true;

// =====================================================
// Helpers
// =====================================================
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
  // highlight
  safe = safe.replace(/#(\d{5,})/g, (_m, p) => `<span class="f-post">#${_esc(p)}</span>`);
  safe = safe.replace(/@([\w .\-]{2,40})/g, (_m, n) => `<span class="f-name">@${_esc(n)}</span>`);
  return `${_esc(ts)}${safe}`;
}

// =====================================================
// Log Writers
// =====================================================
function addLog(type, message) {
  const logBox = document.getElementById("logBox");
  if (!logBox) return;
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  div.innerHTML = buildLogHTML(message);
  logBox.appendChild(div);
  if (window.__autoScroll) logBox.scrollTop = logBox.scrollHeight;

  // Mirror into floating log
  const floatLog = document.getElementById("floatLogContent");
  if (floatLog) {
    const clone = div.cloneNode(true);
    floatLog.appendChild(clone);
    floatLog.scrollTop = floatLog.scrollHeight;
  }
}

function addWarning(type, message) {
  const warnBox = document.getElementById("warnBox");
  if (!warnBox) return;
  const div = document.createElement("div");
  div.className = `log-line ${type}`;
  div.innerHTML = buildLogHTML(message);
  warnBox.appendChild(div);
  if (window.__autoScroll) warnBox.scrollTop = warnBox.scrollHeight;
}

function clearLogs() {
  document.getElementById("logBox")?.innerHTML = "";
  document.getElementById("warnBox")?.innerHTML = "";
  document.getElementById("floatLogContent")?.innerHTML = "";
}

// =====================================================
// Token Handling
// =====================================================
const tokenMap = new Map();

function resetTokens(){ tokenMap.clear(); renderTokens(); }

function renderTokens(){
  const box = document.getElementById("tokenList");
  if(!box) return;
  box.innerHTML = "";
  [...tokenMap.entries()].forEach(([tok, info])=>{
    const chip = document.createElement("div");
    chip.className = "token-chip " + (
      info.status === "OK" ? "token-ok" :
      info.status === "BACKOFF" ? "token-backoff" :
      (info.status === "REMOVED" || info.status === "INVALID") ? "token-removed" :
      ""
    );
    chip.textContent = `#${info.pos ?? "-"} ${info.status}`;
    box.appendChild(chip);
  });
}

function tokenReport(){
  const removed = [], backoff = [];
  tokenMap.forEach((info, token)=>{
    if (["REMOVED","INVALID"].includes(info.status)) removed.push(info);
    else if (info.status==="BACKOFF") backoff.push(info);
  });
  return {removed, backoff};
}

async function copyTokenReportToClipboard(){
  const {removed, backoff} = tokenReport();
  const header = `Token Report — ${new Date().toLocaleString()}`;
  const rmLines = removed.map(r => `#${r.pos ?? "-"} ${r.status}`);
  const boLines = backoff.map(r => `#${r.pos ?? "-"} BACKOFF until:${r.until || "-"}`);
  const text = [header,"",`REMOVED (${removed.length})`,...rmLines,"",`BACKOFF (${backoff.length})`,...boLines].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    addLog("success","📋 Token report copied");
  } catch {
    addWarning("warn","⚠ Could not copy report");
  }
}

// =====================================================
// Stats
// =====================================================
const stats = { total:0, ok:0, fail:0 };
const perPost = new Map();

function resetStats(){
  stats.total=0; stats.ok=0; stats.fail=0;
  perPost.clear();
  renderStats(); renderPerPost();
}

function renderStats(){
  document.getElementById("stTotal").textContent = `Sent: ${stats.total}`;
  document.getElementById("stOk").textContent    = `OK: ${stats.ok}`;
  document.getElementById("stFail").textContent  = `Failed: ${stats.fail}`;
}

function bumpPerPost(postId, kind){
  if(!postId) return;
  if(!perPost.has(postId)) perPost.set(postId,{sent:0,ok:0,fail:0});
  const row = perPost.get(postId);
  row.sent++; if(kind==="ok") row.ok++; if(kind==="fail") row.fail++;
}

function renderPerPost(){
  const tb=document.getElementById("perPostBody"); if(!tb) return;
  tb.innerHTML="";
  perPost.forEach((r,pid)=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`<td>${pid}</td><td>${r.sent}</td><td>${r.ok}</td><td>${r.fail}</td>`;
    tb.appendChild(tr);
  });
}

// =====================================================
// Session
// =====================================================
async function loadSession(){
  try {
    const res = await fetch("/session",{credentials:"include"});
    const data=await res.json();
    if(data && data.id){
      window.sessionId=data.id;
      document.getElementById("userIdBox").textContent=data.id;
      addLog("success","✅ Session ID loaded");
    }
  } catch(e){
    addWarning("error","❌ Session load failed");
  }
}

// =====================================================
// Start
// =====================================================
document.getElementById("startBtn")?.addEventListener("click", async ()=>{
  resetStats(); resetTokens();

  const delayEl=document.querySelector('[name="delay"]');
  const limitEl=document.querySelector('[name="limit"]');
  const shuffleEl=document.querySelector('[name="shuffle"]');
  const packEl=document.querySelector('[name="commentSet"]');
  const modeEl=document.querySelector('input[name="speedMode"]:checked');

  const delay=parseInt(delayEl?.value||"20",10);
  const limit=parseInt(limitEl?.value||"0",10);
  const shuffle=!!(shuffleEl?.checked);
  const commentPack=(packEl?.value||"").trim();
  const speedMode=modeEl?modeEl.value:"fast";

  // 🔥 Advanced settings
  const adv = {
    roundJitterMaxMs: parseInt(document.querySelector('[name="roundJitterMaxMs"]')?.value || "0", 10),
    tokenCooldownMs:  parseInt(document.querySelector('[name="tokenCooldownMs"]')?.value || "0", 10),
    quotaPerTokenHour:parseInt(document.querySelector('[name="quotaPerTokenHour"]')?.value || "0", 10),
    namesPerComment:  parseInt(document.querySelector('[name="namesPerComment"]')?.value || "1", 10),
    limitPerPost:     parseInt(document.querySelector('[name="limitPerPost"]')?.value || "0", 10),
    removeBadTokens:  !!document.querySelector('[name="removeBadTokens"]')?.checked,
    blockedBackoffMs: parseInt(document.querySelector('[name="blockedBackoffMs"]')?.value || "0", 10),
    requestTimeoutMs: parseInt(document.querySelector('[name="requestTimeoutMs"]')?.value || "0", 10),
    retryCount:       parseInt(document.querySelector('[name="retryCount"]')?.value || "0", 10),
    sseBatchMs:       parseInt(document.querySelector('[name="sseBatchMs"]')?.value || "0", 10),
    tokenGlobalRing:  !!document.querySelector('[name="tokenGlobalRing"]')?.checked
  };

  // collect posts
  const posts=[];
  for(let i=1;i<=4;i++){
    const targetEl=document.querySelector(`[name="postLinks${i}"]`);
    const namesEl=document.querySelector(`[name="names${i}"]`);
    const target=targetEl?targetEl.value.trim():"";
    const names=namesEl?namesEl.value.trim():"";
    if(target){ posts.push({target,names,tokens:"",comments:"",commentPack:commentPack||"Default"}); }
  }

  addLog("info","🚀 Sending start request…");
  addLog("info",`⚡ Speed Mode: ${speedMode}`);

  try{
    const res=await fetch("/start",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"include",
      body:JSON.stringify({delay,limit,shuffle,speedMode,sessionId:window.sessionId||"",posts,...adv})
    });
    const data=await res.json();
    if(data.ok){ addLog("success","✅ Started"); isRunning=true; startSSE(); }
    else addWarning("error","❌ Start failed: "+(data.message||data.error));
  }catch(err){ addWarning("error","❌ Start error: "+err.message); }
});

// =====================================================
// Stop
// =====================================================
document.getElementById("stopBtn")?.addEventListener("click", async ()=>{
  if(!isRunning){ addWarning("warn","⚠ Nothing running"); return; }
  try{
    const res=await fetch("/stop",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({sessionId:window.sessionId||""})});
    const data=await res.json();
    if(data.ok){ addLog("success","🛑 Stopped"); isRunning=false; stopSSE(); }
  }catch(err){ addWarning("error","❌ Stop error: "+err.message); }
});

// =====================================================
// SSE
// =====================================================
function startSSE(){
  if(eventSource) eventSource.close();
  eventSource=new EventSource(`/events?sessionId=${encodeURIComponent(window.sessionId||"")}`);

  eventSource.onmessage=(e)=>{
    try{
      const d=JSON.parse(e.data);
      if(d.type==="summary"){ addLog("success",`📊 Summary sent=${d.sent} ok=${d.ok} fail=${d.failed}`); isRunning=false; return; }
      if(d.type==="error"){ addWarning("error",d.text||"Error"); stats.fail++; stats.total++; }
      else { addLog("info",d.text||JSON.stringify(d)); stats.ok++; stats.total++; }
      renderStats();
    }catch(err){ addWarning("error","❌ SSE parse fail: "+err.message); }
  };
  eventSource.onerror=()=>{ addWarning("error","⚠ SSE disconnected"); stopSSE(); };
}
function stopSSE(){ if(eventSource){eventSource.close();eventSource=null;} }

// =====================================================
// Floating Log UI
// =====================================================
(()=>{
  const btn=document.getElementById("btnOpenFloatLog");
  const panel=document.getElementById("floatLog");
  const header=document.getElementById("floatLogHeader");
  const btnMin=document.getElementById("minLog");
  const btnMax=document.getElementById("maxLog");
  const btnClose=document.getElementById("closeLog");

  if(!btn||!panel) return;

  btn.addEventListener("click",()=>{panel.style.display="block";});
  btnClose.addEventListener("click",()=>{panel.style.display="none";});
  btnMin.addEventListener("click",()=>{panel.style.height="200px";panel.style.width="400px";});
  let maximized=false;
  btnMax.addEventListener("click",()=>{
    maximized=!maximized;
    if(maximized){panel.style.top="5%";panel.style.left="2%";panel.style.width="96vw";panel.style.height="90vh";panel.style.transform="none";}
    else{panel.style.width="90vw";panel.style.height="70vh";panel.style.left="50%";panel.style.top="50%";panel.style.transform="translate(-50%,-50%)";}
  });

  // drag
  let drag=false,sx=0,sy=0,sl=0,st=0;
  header.addEventListener("mousedown",(e)=>{drag=true;sx=e.clientX;sy=e.clientY;const r=panel.getBoundingClientRect();sl=r.left;st=r.top;panel.style.transform="none";});
  window.addEventListener("mousemove",(e)=>{if(!drag)return;panel.style.left=(sl+(e.clientX-sx))+"px";panel.style.top=(st+(e.clientY-sy))+"px";});
  window.addEventListener("mouseup",()=>drag=false);
})();

// =====================================================
// Init
// =====================================================
window.addEventListener("DOMContentLoaded",()=>{
  loadSession();
  document.getElementById("btnCopyReport")?.addEventListener("click", copyTokenReportToClipboard);
});
