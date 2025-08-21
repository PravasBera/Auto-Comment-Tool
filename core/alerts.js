function handleError(type) {
  switch (type) {
    case "invalid_token":
      return "❌ Invalid Token!";
    case "wrong_post":
      return "⚠️ Wrong Post ID!";
    case "locked_id":
      return "🔒 ID Locked!";
    case "blocked_comment":
      return "🚫 Comment Blocked!";
    default:
      return "⚠️ Unknown Error!";
  }
}

module.exports = { handleError };
