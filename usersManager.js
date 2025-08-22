// usersManager.js
const fs = require("fs");
const USERS_FILE = "./users.json";

// 👉 ইউজার লোড
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE));
  } catch (e) {
    console.error("❌ users.json corrupted:", e);
    return [];
  }
}

// 👉 ইউজার সেভ
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// 👉 ইউজার খুঁজে বের করা
function findUser(username) {
  let users = loadUsers();
  return users.find(u => u.username === username);
}

// 👉 approve user (expiry = null মানে লাইফটাইম)
function approveUser(username, expiry = null) {
  let users = loadUsers();
  let user = users.find(u => u.username === username);

  let isoExpiry = expiry ? new Date(expiry).toISOString() : null;

  if (!user) {
    user = { 
      username, 
      approvedAt: new Date().toISOString(), 
      expiry: isoExpiry, 
      blocked: false 
    };
    users.push(user);
  } else {
    user.expiry = isoExpiry;
    user.blocked = false;
  }
  saveUsers(users);
  return user;
}

// 👉 block/unblock
function blockUser(username, blocked = true) {
  let users = loadUsers();
  let user = users.find(u => u.username === username);
  if (user) {
    user.blocked = blocked;
    saveUsers(users);
  }
  return user;
}

// 👉 check access
function checkAccess(username) {
  let user = findUser(username);
  if (!user) return false;
  if (user.blocked) return false;
  if (!user.expiry) return true; // লাইফটাইম
  return new Date(user.expiry) > new Date();
}

module.exports = { loadUsers, saveUsers, findUser, approveUser, blockUser, checkAccess };
