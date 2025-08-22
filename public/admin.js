let token = null;

// ---------------- Login ----------------
async function login() {
  const username = document.getElementById("adminUser").value;
  const password = document.getElementById("adminPass").value;

  const res = await fetch("/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.ok) {
    token = data.token;
    document.getElementById("loginBox").classList.add("hidden");
    document.getElementById("panelBox").classList.remove("hidden");
    loadUsers();
  } else {
    document.getElementById("loginMsg").innerText = "Invalid credentials!";
  }
}

function logout() {
  token = null;
  document.getElementById("panelBox").classList.add("hidden");
  document.getElementById("loginBox").classList.remove("hidden");
}

// ---------------- Load Users ----------------
async function loadUsers() {
  const res = await fetch("/admin/users", {
    headers: { "Authorization": token }
  });
  const data = await res.json();

  fillUsers("approvedUsers", data.approved);
  fillUsers("pendingUsers", data.pending);
  fillUsers("blockedUsers", data.blocked);

  const select = document.getElementById("userSelect");
  select.innerHTML = "";
  data.all.forEach(u => {
    let opt = document.createElement("option");
    opt.value = u.username;
    opt.innerText = u.username;
    select.appendChild(opt);
  });
}

function fillUsers(tableId, users) {
  const tbody = document.getElementById(tableId).querySelector("tbody");
  tbody.innerHTML = "";
  users.forEach(u => {
    let tr = document.createElement("tr");
    Object.values(u).forEach(val => {
      let td = document.createElement("td");
      td.innerText = val;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ---------------- Actions ----------------
async function approveUser() {
  const username = document.getElementById("userSelect").value;
  const expiry = document.getElementById("expiryDate").value;
  await fetch("/admin/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ username, expiry })
  });
  loadUsers();
}

async function expireUser() {
  const username = document.getElementById("userSelect").value;
  const expiry = document.getElementById("expiryDate").value;
  await fetch("/admin/expire", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ username, expiry })
  });
  loadUsers();
}

async function blockUser() {
  const username = document.getElementById("userSelect").value;
  await fetch("/admin/block", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ username })
  });
  loadUsers();
}

async function unblockUser() {
  const username = document.getElementById("userSelect").value;
  await fetch("/admin/unblock", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": token },
    body: JSON.stringify({ username })
  });
  loadUsers();
}
