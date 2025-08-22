const bcrypt = require("bcryptjs");

const password = "MyStrongPass123"; // 👉 এখানে তোমার পাসওয়ার্ড দাও
const hash = bcrypt.hashSync(password, 10);

console.log("Your password hash is:\n", hash);
