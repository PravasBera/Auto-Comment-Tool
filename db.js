const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGO_URI;
let client, db;

async function connectDB() {
  if (!db) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db("auto_comment_tool"); // database name
  }
  return db;
}

module.exports = connectDB;
