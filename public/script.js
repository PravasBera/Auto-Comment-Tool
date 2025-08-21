const logBox = document.getElementById("log-box");
const startBtn = document.querySelector(".btn.start");
const stopBtn = document.querySelector(".btn.stop");

function log(message, type="info") {
  let prefix = "[INFO]";
  if (type === "error") prefix = "[ERROR]";
  if (type === "success") prefix = "[SUCCESS]";
  logBox.textContent += `\n${prefix} ${message}`;
  logBox.scrollTop = logBox.scrollHeight;
}

startBtn.addEventListener("click", () => {
  log("Process started...");
  // এখানে তোমার comment request logic যাবে
});

stopBtn.addEventListener("click", () => {
  log("Process stopped!", "error");
});
