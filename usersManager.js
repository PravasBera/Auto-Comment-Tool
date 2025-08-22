// usersManager.js
const fs = require("fs");
const USERS_FILE = "./users.json";

// 👉 ইউজার লোড
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(USERS_FILE));
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
  if (!user) {
    user = { username, approvedAt: new Date(), expiry, blocked: false };
    users.push(user);
  } else {
    user.expiry = expiry;
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

// ====================
// 🆕 Admin Panel এর জন্য
// ====================

// 👉 সব ইউজার ফেচ করা
function getAllUsers() {
  return loadUsers();
}

// 👉 ইউজারের status আপডেট করা
function updateUserStatus(username, status, expiry = null) {
  let users = loadUsers();
  let user = users.find(u => u.username === username);
  if (!user) return null;

  if (status === "approved") {
    user.blocked = false;
    user.expiry = expiry ? new Date(expiry).toISOString() : null;
  } else if (status === "blocked") {
    user.blocked = true;
  }
  saveUsers(users);
  return user;
}

// 👉 pending/approved/blocked count
function getCounts() {
  let users = loadUsers();
  return {
    total: users.length,
    approved: users.filter(u => !u.blocked).length,
    blocked: users.filter(u => u.blocked).length,
    pending: users.filter(u => !u.expiry && !u.blocked).length
  };
}

module.exports = { 
  loadUsers, 
  saveUsers, 
  approveUser, 
  blockUser, 
  checkAccess,
  getAllUsers,
  updateUserStatus,
  getCounts
};
