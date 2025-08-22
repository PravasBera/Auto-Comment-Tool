const fs = require("fs");
const path = require("path");

const usersFile = path.join(__dirname, "users.json");

// users.json পড়া
function readUsers() {
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify({}, null, 2));
  }
  const data = fs.readFileSync(usersFile);
  try {
    return JSON.parse(data);
  } catch (err) {
    return {}; // ভুল হলে খালি object রিটার্ন করবে
  }
}

// users.json এ লেখা
function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// সব ইউজার পাওয়া
function getAllUsers() {
  const users = readUsers();
  return Object.values(users);
}

// নতুন ইউজার add/update করা
function addUser(username, { expiry = null, status = "approved" }) {
  const users = readUsers();
  users[username] = {
    username,
    approvedAt: new Date().toISOString(),
    expiry,
    status,
  };
  writeUsers(users);
  return users[username];
}

// ইউজার block করা
function blockUser(username) {
  const users = readUsers();
  if (users[username]) {
    users[username].status = "blocked";
    writeUsers(users);
    return true;
  }
  return false;
}

// ইউজার মুছে ফেলা
function removeUser(username) {
  const users = readUsers();
  if (users[username]) {
    delete users[username];
    writeUsers(users);
    return true;
  }
  return false;
}

// এক ইউজারের ডিটেইল পাওয়া
function getUser(username) {
  const users = readUsers();
  return users[username] || null;
}

module.exports = {
  getAllUsers,
  addUser,
  blockUser,
  removeUser,
  getUser,
};
