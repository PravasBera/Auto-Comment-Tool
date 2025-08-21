// settings.json থেকে header info load
fetch("/settings")
  .then(res => res.json())
  .then(data => {
    document.getElementById("version").innerText = data.version;
    document.getElementById("author").innerText = data.author;
    document.getElementById("team").innerText = data.team;
    document.getElementById("country").innerText = data.country;
  });

// example log show function
function addLog(msg) {
  const logs = document.getElementById("logs");
  const p = document.createElement("p");
  p.innerText = msg;
  logs.appendChild(p);
}
