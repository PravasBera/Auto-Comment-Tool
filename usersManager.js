const fs = require("fs");
const path = require("path");

const USERS_FILE = path.join(__dirname, "users.json");

// Ensure file exists
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
    }
    const data = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    console.error("Error loading users:", err);
    return { users: [] };
  }
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// Approve user
function approveUser(username, expiry) {
  const db = loadUsers();
  let user = db.users.find((u) => u.username === username);

  if (!user) {
    user = { username, approvedAt: new Date().toISOString(), expiry, status: "approved" };
    db.users.push(user);
  } else {
    user.approvedAt = new Date().toISOString();
    user.expiry = expiry;
    user.status = "approved";
  }

  saveUsers(db);
  return user;
}

// Block user
function blockUser(username) {
  const db = loadUsers();
  const user = db.users.find((u) => u.username === username);
  if (user) {
    user.status = "blocked";
    saveUsers(db);
  }
  return user;
}

// Unblock user
function unblockUser(username) {
  const db = loadUsers();
  const user = db.users.find((u) => u.username === username);
  if (user) {
    user.status = "approved";
    saveUsers(db);
  }
  return user;
}

// Delete user
function deleteUser(username) {
  const db = loadUsers();
  db.users = db.users.filter((u) => u.username !== username);
  saveUsers(db);
  return true;
}

// Get all users
function getAllUsers() {
  const db = loadUsers();
  return db.users;
}

module.exports = {
  approveUser,
  blockUser,
  unblockUser,
  deleteUser,
  getAllUsers,
};
