<<<<<<< HEAD
const bcrypt = require("bcryptjs");

const password = "MyStrongPass123"; // 👉 এখানে তোমার পাসওয়ার্ড দাও
const hash = bcrypt.hashSync(password, 10);

console.log("Your password hash is:\n", hash);
=======
const bcrypt = require("bcrypt");

// এখানে তোমার নতুন password দাও
const hash = bcrypt.hashSync("63649104", 10);
console.log(hash);
>>>>>>> 2eab9facfba5dea4b6ec9e7ae50dbdeb08aa372d
