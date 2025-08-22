// ---------------- Admin Panel Script ----------------

// API base URL (server এর root ধরেছি, দরকার হলে /api যোগ করবেন)
const API_BASE = "/admin";

// Token localStorage এ রাখা হবে
function saveToken(token) {
  localStorage.setItem("admin_token", token);
}
function getToken() {
  return localStorage.getItem("admin_token");
}
function logout() {
  localStorage.removeItem("admin_token");
  location.reload();
}

// ---------------- Login ----------------
async function adminLogin(e) {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();

  const res = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.ok) {
    saveToken(data.token);
    document.getElementById("loginForm").style.display = "none";
    document.getElementById("panel").style.display = "block";
    loadUsers();
  } else {
    alert("Login failed: " + data.message);
  }
}

// ---------------- Load Users ----------------
async function loadUsers() {
  const token = getToken();
  if (!token) return logout();

  const res = await fetch(`${API_BASE}/users`, {
    headers: { Authorization: "Bearer " + token }
  });

  const data = await res.json();
  const usersDiv = document.getElementById("users");
  usersDiv.innerHTML = "";

  if (!data.ok) {
    usersDiv.innerHTML = "Error loading users";
    return;
  }

  data.users.forEach(u => {
    const el = document.createElement("div");
    el.innerText = JSON.stringify(u);
    usersDiv.appendChild(el);
  });
}

// ---------------- Init ----------------
window.addEventListener("DOMContentLoaded", () => {
  const token = getToken();
  if (token) {
    document.getElementById("loginForm").style.display = "none";
    document.getElementById("panel").style.display = "block";
    loadUsers();
  } else {
    document.getElementById("loginForm").style.display = "block";
    document.getElementById("panel").style.display = "none";
  }
});
