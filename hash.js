const bcrypt = require("bcrypt");

// এখানে তোমার নতুন password দাও
const hash = bcrypt.hashSync("63649104", 10);
console.log(hash);
