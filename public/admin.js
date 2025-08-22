// ====== CONFIG ======
const API_BASE = ""; // same origin

// ====== STATE ======
let TOKEN = localStorage.getItem("admin_token") || "";
const els = {
  loginCard: document.getElementById("loginCard"),
  dashCard: document.getElementById("dashCard"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  btnLogin: document.getElementById("btnLogin"),
  loginMsg: document.getElementById("loginMsg"),
  loginDot: document.getElementById("loginDot"),
  authState: document.getElementById("authState"),
  btnLogout: document.getElementById("btnLogout"),
  btnRefresh: document.getElementById("btnRefresh"),
  searchBox: document.getElementById("searchBox"),
  userTbody: document.getElementById("userTbody"),
  checkAll: document.getElementById("checkAll"),
  expiryInput: document.getElementById("expiryInput"),
  bulkApprove: document.getElementById("bulkApprove"),
  bulkBlock: document.getElementById("bulkBlock"),
  bulkUnblock: document.getElementById("bulkUnblock"),
  bulkExpire: document.getElementById("bulkExpire"),
  bulkDelete: document.getElementById("bulkDelete"),
  dashMsg: document.getElementById("dashMsg"),
  dashDot: document.getElementById("dashDot"),
};

// ====== HELPERS ======
function setLoginStatus(ok, msg){
  els.loginDot.className = "dot " + (ok ? "ok" : "err");
  els.loginMsg.textContent = msg || (ok ? "Authenticated" : "Authentication failed");
}
function setDashStatus(type, msg){
  els.dashDot.className = "dot " + (type || "");
  els.dashMsg.textContent = msg || "";
}
function fmtTime(ts){
  if (!ts) return "-";
  const d = new Date(Number(ts) || ts);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString();
}
function badgeStatus(u){
  if (u.status === "approved" && !u.blocked) return '<span class="tag ok">approved</span>';
  if (u.status === "blocked" || u.blocked) return '<span class="tag block">blocked</span>';
  return '<span class="tag pending">pending</span>';
}
function withAuth(init={}){
  init.headers = Object.assign({}, init.headers || {}, {
    "Content-Type":"application/json",
    "Authorization":"Bearer " + TOKEN
  });
  return init;
}
async function api(path, opts){
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 401){
    logout(true);
    throw new Error("Unauthorized");
  }
  return res.json();
}
function show(view){
  if (view === "dash"){
    els.loginCard.classList.add("hidden");
    els.dashCard.classList.remove("hidden");
    els.authState.textContent = "Authenticated";
    els.authState.className = "tag ok";
  } else {
    els.dashCard.classList.add("hidden");
    els.loginCard.classList.remove("hidden");
  }
}
function selectedRows(){
  const checks = Array.from(document.querySelectorAll(".rowcheck:checked"));
  return checks.map(c => c.dataset.id);
}

// ====== LOGIN / LOGOUT ======
async function login(){
  const username = els.username.value.trim();
  const password = els.password.value;
  els.btnLogin.disabled = true;
  setLoginStatus(false, "Signing in...");
  try{
    const data = await fetch(API_BASE + "/admin/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({username, password})
    }).then(r=>r.json());
    if (data.ok && data.token){
      TOKEN = data.token;
      localStorage.setItem("admin_token", TOKEN);
      setLoginStatus(true, "Login success");
      show("dash"); await loadUsers();
    } else {
      setLoginStatus(false, data.message || "Login failed");
    }
  }catch(e){
    setLoginStatus(false, e.message || "Network error");
  }finally{
    els.btnLogin.disabled = false;
  }
}
function logout(silent){
  TOKEN = "";
  localStorage.removeItem("admin_token");
  if (!silent) alert("Logged out");
  show("login");
}

// ====== USERS TABLE ======
let USERS = [];
async function loadUsers(){
  setDashStatus("", "Loading users...");
  try{
    const data = await api("/admin/users", withAuth());
    if (!data.ok) throw new Error("Failed to fetch users");
    USERS = data.users || [];
    renderUsers();
    setDashStatus("ok", `Loaded ${USERS.length} user(s)`);
  }catch(e){
    setDashStatus("err", e.message || "Failed");
  }
}
function renderUsers(){
  const q = (els.searchBox.value || "").toLowerCase();
  const rows = USERS
    .filter(u=>{
      if (!q) return true;
      return (
        (u.sessionId||"").toLowerCase().includes(q) ||
        (u.status||"").toLowerCase().includes(q)
      );
    })
    .map(u=>{
      const exp = u.expiry ? fmtTime(u.expiry) : "—";
      const appAt = u.approvedAt ? new Date(u.approvedAt).toLocaleString() : "—";
      const upd = u.updatedAt ? fmtTime(u.updatedAt) : "—";
      return `
        <tr>
          <td><input type="checkbox" class="rowcheck" data-id="${u.sessionId}"/></td>
          <td class="mono small">${u.sessionId}</td>
          <td>${badgeStatus(u)}</td>
          <td>${u.blocked ? '<span class="danger">true</span>' : '<span class="success">false</span>'}</td>
          <td class="small">${exp}</td>
          <td class="small">${appAt}</td>
          <td class="small">${upd}</td>
          <td>
            <div class="toolbar">
              <button class="btn btn-ok" onclick="actApprove('${u.sessionId}')">Approve</button>
              <button class="btn btn-warn" onclick="actBlock('${u.sessionId}')">Block</button>
              <button class="btn" onclick="actUnblock('${u.sessionId}')">Unblock</button>
              <button class="btn" onclick="actExpire('${u.sessionId}')">Set Expiry</button>
              <button class="btn btn-err" onclick="actDelete('${u.sessionId}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  els.userTbody.innerHTML = rows || `<tr><td colspan="8" class="muted">No users</td></tr>`;
  els.checkAll.checked = false;
}

// ====== ACTIONS ======
async function actApprove(id){
  const expiry = els.expiryInput.value ? new Date(els.expiryInput.value).toISOString() : null;
  setDashStatus("", `Approving ${id}...`);
  try{
    const data = await api("/admin/approve", withAuth({
      method:"POST",
      body: JSON.stringify({username:id, expiry})
    }));
    if (!data.ok) throw new Error(data.message || "Failed");
    await loadUsers();
    setDashStatus("ok", `Approved ${id}`);
  }catch(e){ setDashStatus("err", e.message || "Failed"); }
}
async function actBlock(id){
  setDashStatus("", `Blocking ${id}...`);
  try{
    const data = await api("/admin/block", withAuth({
      method:"POST",
      body: JSON.stringify({username:id})
    }));
    if (!data.ok) throw new Error(data.message || "Failed");
    await loadUsers();
    setDashStatus("ok", `Blocked ${id}`);
  }catch(e){ setDashStatus("err", e.message || "Failed"); }
}
async function actUnblock(id){
  setDashStatus("", `Unblocking ${id}...`);
  try{
    const data = await api("/admin/unblock", withAuth({
      method:"POST",
      body: JSON.stringify({username:id})
    }));
    if (!data.ok) throw new Error(data.message || "Failed");
    await loadUsers();
    setDashStatus("ok", `Unblocked ${id}`);
  }catch(e){ setDashStatus("err", e.message || "Failed"); }
}
async function actExpire(id){
  const expiry = els.expiryInput.value ? new Date(els.expiryInput.value).toISOString() : null;
  setDashStatus("", `Setting expiry for ${id}...`);
  try{
    const data = await api("/admin/expire", withAuth({
      method:"POST",
      body: JSON.stringify({username:id, expiry})
    }));
    if (!data.ok) throw new Error(data.message || "Failed");
    await loadUsers();
    setDashStatus("ok", `Expiry set for ${id}`);
  }catch(e){ setDashStatus("err", e.message || "Failed"); }
}
async function actDelete(id){
  if (!confirm(`Delete user ${id}?`)) return;
  setDashStatus("", `Deleting ${id}...`);
  try{
    const data = await api("/admin/delete", withAuth({
      method:"POST",
      body: JSON.stringify({username:id})
    }));
    if (!data.ok) throw new Error(data.message || "Failed");
    await loadUsers();
    setDashStatus("ok", `Deleted ${id}`);
  }catch(e){ setDashStatus("err", e.message || "Failed"); }
}

// expose inline
window.actApprove = actApprove;
window.actBlock = actBlock;
window.actUnblock = actUnblock;
window.actExpire = actExpire;
window.actDelete = actDelete;

// ====== BULK ======
async function bulk(fnName){
  const ids = selectedRows();
  if (!ids.length){ alert("Select at least one row"); return; }
  if (fnName === "delete" && !confirm(`Delete ${ids.length} user(s)?`)) return;

  for (let id of ids){
    if (fnName === "approve") await actApprove(id);
    else if (fnName === "block") await actBlock(id);
    else if (fnName === "unblock") await actUnblock(id);
    else if (fnName === "expire") await actExpire(id);
    else if (fnName === "delete") await actDelete(id);
  }
}

// ====== EVENTS ======
els.btnLogin.addEventListener("click", login);
els.btnRefresh.addEventListener("click", loadUsers);
els.btnLogout.addEventListener("click", ()=>logout(false));
els.searchBox.addEventListener("input", renderUsers);
els.checkAll.addEventListener("change", (e)=>{
  const v = e.target.checked;
  document.querySelectorAll(".rowcheck").forEach(ch => ch.checked = v);
});
els.bulkApprove.addEventListener("click", ()=>bulk("approve"));
els.bulkBlock.addEventListener("click", ()=>bulk("block"));
els.bulkUnblock.addEventListener("click", ()=>bulk("unblock"));
els.bulkExpire.addEventListener("click", ()=>bulk("expire"));
els.bulkDelete.addEventListener("click", ()=>bulk("delete"));

// keyboard R = refresh
window.addEventListener("keydown",(e)=>{
  if (e.key.toLowerCase()==="r" && !e.metaKey && !e.ctrlKey){
    e.preventDefault(); loadUsers();
  }
});

// ====== BOOT ======
(async function init(){
  if (TOKEN){
    try{
      show("dash");
      await loadUsers();
      setLoginStatus(true,"Session restored");
    }catch{
      logout(true);
      setLoginStatus(false,"Session expired");
    }
  } else {
    show("login");
  }
})();
