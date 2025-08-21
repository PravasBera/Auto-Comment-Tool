const { handleError } = require("./alerts");

function commentWithToken(token, postId, message) {
  if (!token) return handleError("invalid_token");
  if (!postId) return handleError("wrong_post");

  // এখানে comment করার আসল logic লিখবে (API call ইত্যাদি)

  return `✅ Comment sent: "${message}" by User`;
}

module.exports = { commentWithToken };
