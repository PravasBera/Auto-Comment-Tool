
  }
}
app.get("/events", (req, res) => {
  
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    // /{userId}/posts/{postId}
    const idx = parts.findIndex((p) => p === "posts");
    if (idx > 0 && parts[idx + 1]) {
      const userId = parts[idx - 1];
      const postId = parts[idx + 1].replace(/[^0-9]/g, "");
      if (/^\d+$/.test(userId) && /^\d+$/.test(postId)) {
        return `${userId}_${postId}`;
      }
    }

    // /groups/{groupId}/posts/{postId}
    const g = parts.findIndex((p) => p === "groups");
    if (g >= 0 && parts[g + 1] && parts.includes("posts")) {
      const groupId = parts[g + 1];
      const pIdx = parts.findIndex((p) => p === "posts");
      const postId = parts[pIdx + 1]?.replace(/[^0-9]/g, "");
      if (/^\d+$/.test(groupId) && /^\d+$/.test(postId)) {
        return `${groupId}_${postId}`;
      }
    }

    // story_fbid / fbid fallback
    const fbid = u.searchParams.get("story_fbid") || u.searchParams.get("fbid");
    const id = u.searchParams.get("id");
    if (fbid && id && /^\d+$/.test(fbid) && /^\d+$/.test(id)) {
      return `${id}_${fbid}`;
    }
  } catch {}
  return null;
}

async function fbMe(token) {
  const url = "https://graph.facebook.com/v17.0/me?fields=name";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (!res.ok || j.error) {
    const msg = j?.error?.message || `HTTP ${res.status}`;
    const code = j?.error?.code;
    const sub = j?.error?.error_subcode;
    throw Object.assign(new Error(msg), { code, sub });
  }
  return j; // {id, name}
}

async function fbComment(postId, message, token) {
  const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(postId)}/comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ message }),
  });
  const j = await res.json();
  if (!res.ok || j.error) {
    const err = j?.error || {};
    const e = Object.assign(new Error(err.message || `HTTP ${res.status}`), {
      code: err.code,
      sub: err.error_subcode,
      type: err.type,
    });
    throw e;
  }
  return j; // {id}
}

function classifyFbError(e) {
  // returns {kind,label}
  const code = Number(e.code || 0);
  const sub = Number(e.sub || 0);

  if (code === 190) {
    if (sub === 463 || sub === 467) return { kind: "token_expired", label: "Token expired" };
    return { kind: "token_invalid", label: "Token invalid" };
  }
  if (code === 368) return { kind: "temporary_block", label: "Temporarily blocked (368)" };
  if (code === 200 || code === 10) return { kind: "permission", label: "Permission denied" };
  if (code === 100) return { kind: "bad_post", label: "Invalid post id/link" };
  return { kind: "unknown", label: "Unknown error" };
}

// ---------- Job state ----------
let currentJob = null;

// ---------- Start ----------
app.post(
  "/start",
  upload.fields([
    { name: "postFile", maxCount: 1 },
    { name: "linksFile", maxCount: 1 },
    { name: "commentsFile", maxCount: 1 },
    { name: "tokensFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (currentJob && !currentJob.done) {
        return res.status(409).json({ error: "Job already running. Stop first." });
      }

      // form values
      const delaySec = Math.max(0, parseInt(req.body.delaySec || "0", 10));
      const maxCount = Math.max(0, parseInt(req.body.maxCount || "0", 10));

      // ----- collect post IDs -----
      let postIds = [];

      // from text box
      postIds.push(...parseIdsFromCsv(req.body.postIds));

      // from post file
      if (req.files?.postFile?.[0]) {
        const txt = fs.readFileSync(req.files.postFile[0].path, "utf-8");
        postIds.push(...cleanLines(txt));
      }

      // from 3 link inputs
      ["link1", "link2", "link3"].forEach((k) => {
        const link = (req.body[k] || "").trim();
        if (link) {
          const id = extractPostIdFromUrl(link);
          if (id) postIds.push(id);
        }
      });

      // from links file
      if (req.files?.linksFile?.[0]) {
        const txt = fs.readFileSync(req.files.linksFile[0].path, "utf-8");
        cleanLines(txt).forEach((ln) => {
          const id = extractPostIdFromUrl(ln);
          if (id) postIds.push(id);
        });
      }

      postIds = [...new Set(postIds.filter(Boolean))]; // unique

      // comments
      if (!req.files?.commentsFile?.[0])
        return res.status(400).json({ error: "comments.txt required" });
      const comments = cleanLines(fs.readFileSync(req.files.commentsFile[0].path, "utf-8"));
      if (comments.length === 0) return res.status(400).json({ error: "comments.txt is empty" });

      // tokens
      if (!req.files?.tokensFile?.[0])
        return res.status(400).json({ error: "tokens.txt required" });
      let tokens = cleanLines(fs.readFileSync(req.files.tokensFile[0].path, "utf-8"));
      if (tokens.length === 0) return res.status(400).json({ error: "tokens.txt is empty" });

      // safety caps
      const MAX_POSTS = 300, MAX_COMMENTS = 300, MAX_TOKENS = 50;
      if (postIds.length > MAX_POSTS) postIds = postIds.slice(0, MAX_POSTS);
      if (comments.length > MAX_COMMENTS) comments = comments.slice(0, MAX_COMMENTS);
      if (tokens.length > MAX_TOKENS) tokens = tokens.slice(0, MAX_TOKENS);

      // clean temp files
      [req.files?.postFile?.[0], req.files?.linksFile?.[0], req.files?.commentsFile?.[0], req.files?.tokensFile?.[0]]
        .filter(Bo
        .forEach((f) => { try { fs.unlinkSync(f.path); } catch {} }
     // prepare job
     const job = {
       abort: false,
       done: fals,
        stats: {
         success: 0, failed: 0,
          token_invalid: 0, token_expired: 0, permission: 0, temporary_block: 0,
         bad_pos: 0, unknown: 0,
          invalid_token_list: new Set(),
          bad_post_list: new Set(),
       
      };
      currentJob = job;
      // resolv account names
      cont accounts = [];
      for let i = 0; i < tokens.length; i++) {
        cont tk = tokens[i];
        try 
          const me = await fbMe(tk)
          accounts.push({ token: tk, name: me.name, id: me.id, alive: true })
          sseSend("alert", { level: "success", message: `Token #${i + 1}: ${me.name} ✅` });        } catch (e) {
         constcat = classifyFbError(e);
         if (cat.kind === "token_expired" || cat.kind === "token_invalid") {
           job.stats[cat.kind]++; job.stats.invalid_token_list.add(i + 1);
           sseSend("alert", { level: "error", message: `Token #${i + 1} invalid: ${cat.label}` });
          } else {
           job.stats.unknown++;
           ssSend("alert", { level: "warning", message: `Token #${i + 1} check failed: ${e.message}` });
          }
        }
     
      const aliveccounts = accounts.filter(a => a.alive !== false);
      if (aliveAccounts.length === 0) {
        job.done = true;
        return res.status(400).json({ error: "No valid tokens." });
     }

      // fire-and-orget worker
     (async () => 
       sseSend("start", { posts: postIds.length, comments: comments.length, tokens: aliveAccounts.length, delaySec, maxCount });
        let tokenIdx = 0
       for (const postId of postIds {
          for (const message of commets) {
            if (job.abort) break outer
            if (maxCount && job.stats.success >= maxCount) break outer;
          // pick next usable token
            let tries = 0, acc = null;
            while (tries < aliveAccounts.length) {
            acc = aliveAccounts[tokenIdx % aliveAccounts.length];              tokenIdx++;
             if (acc && acc.alive !== false) bre
            if (!acc || acc.alive === false) { // all dead
             sseSend("alert", { level: "error", message: "All tokens unusable. Stopping." });
             break outer;
            }
            try{
              const out = await fbComment(postId, message, acc.token);
              jo.stats.success++;
              sseend("success", {
           postId,message, commentId: out.id,
        account: { ame: acc.name, id: acc.id }
              }
           } catch (
              job.stats.failed
              const cat = classifyFbError(e)
             if (["ton_invalid, "token_expired", "permission", "temporary_block"].includes(cat.kind)) {                job.statcat.kind]++; // count category
                // mark ton dea for this run
                acc.alive = alse
                const tIndex ccounts.indexOf(acc) +1;
                job.stats.invalitoken_list.add(tInde
                sseSend("alert", {                  level: "error"                message: `${acc.name}: ${cat.label} — token disabled for this run`
             })
            } else if (cat.kind === "bad_post") {
              job.stats.bad_post++; job.stats.bad_post_list.add(postId);
              sseSend("alert", { level: "warning", message: `Invalid Post: ${postId}` });
             } lse {
               ob.stats.unknown++;
              sseSend("alert", { level: "warning", message: `Error: ${e.message}` });
            }
        
           sseend("status", job.sta           if (delaySec > 0) await sleep(del
000)
     }
  
    job.done = true;
     sseSend("summary", {         ...job.tats,
         invalid_tokensount: job.stats.inv
