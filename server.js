// Facebook Auto Comment Tool - v1.5.1 (Fixed)
// Server: Express + SSE (progress streaming)
// Node 18+ required (uses built-in fetch)

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// -------- SSE infra --------
const clients = new Map();     // sessionId -> res
const jobs = new Map();        // sessionId -> { stop: boolean }

function sseSend(id, type, payload) {
  const res = clients.get(id);
  if (!res) return;
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.get('/api/stream', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: hello\ndata: "ok"\n\n');

  clients.set(id, res);
  req.on('close', () => {
    clients.delete(id);
  });
});

// -------- Helpers --------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function textToList(txt) {
  return (txt || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}
function csvToList(csv) {
  return (csv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}
function looksLikeNumericId(x) {
  return /^\d+(?:_\d+)?$/.test(x);
}

// Try to extract {userId}_{postId} from common patterns
function extractFromUrlQuick(raw) {
  try {
    const url = new URL(raw);

    // story_fbid + id
    const sf = url.searchParams.get('story_fbid');
    const owner = url.searchParams.get('id');
    if (sf && owner && /^\d+$/.test(sf) && /^\d+$/.test(owner)) {
      return `${owner}_${sf}`;
    }

    // /posts/<postId>
    if (url.pathname.includes('/posts/')) {
      const pid = url.pathname.split('/posts/')[1].split('/')[0];
      if (/^\d+$/.test(pid) && owner && /^\d+$/.test(owner)) {
        return `${owner}_${pid}`;
      }
    }

    // /videos/<videoId>
    if (url.pathname.includes('/videos/')) {
      const vid = url.pathname.split('/videos/')[1].split('/')[0];
      if (/^\d+$/.test(vid) && owner && /^\d+$/.test(owner)) {
        return `${owner}_${vid}`;
      }
      // কখনো কখনো শুধু ভিডিও আইডিতেই কমেন্ট চলে, fallback
      if (/^\d+$/.test(vid)) return vid;
    }

    // pfbid... → owner id থাকলে ধরার চেষ্টা ব্যর্থ হলে null
    return null;
  } catch {
    return null;
  }
}

// Graph resolve: /?id=<url> → { id }
async function resolveWithGraph(permalink, tokens) {
  for (const tk of tokens) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/?id=${encodeURIComponent(permalink)}&access_token=${encodeURIComponent(tk)}`
      );
      const j = await r.json();
      if (j && j.id && looksLikeNumericId(j.id)) return j.id;
    } catch { /* ignore and try next token */ }
  }
  return null;
}

async function resolvePostIds(rawPosts, rawLinks, tokens, streamId) {
  const out = [];

  for (const p of rawPosts) {
    if (looksLikeNumericId(p)) out.push(p);
    else sseSend(streamId, 'warn', { msg: `Invalid ID format skipped: ${p}` });
  }

  for (const link of rawLinks) {
    if (!link) continue;
    if (looksLikeNumericId(link)) {
      out.push(link);
      continue;
    }
    // quick parse
    const quick = extractFromUrlQuick(link);
    if (quick) {
      out.push(quick);
      continue;
    }
    // Graph resolve fallback
    const resolved = await resolveWithGraph(link, tokens);
    if (resolved) {
      out.push(resolved);
    } else {
      sseSend(streamId, 'badpost', { link, msg: 'Could not resolve link to post id' });
    }
  }

  return uniq(out);
}

async function getTokenNameMap(tokens, streamId) {
  const nameMap = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    try {
      const r = await fetch(`https://graph.facebook.com/me?fields=name&access_token=${encodeURIComponent(tk)}`);
      const j = await r.json();
      if (j.error) {
        const { code, error_subcode } = j.error;
        sseSend(streamId, 'token_error', { tokenIndex: i + 1, code, subcode: error_subcode, msg: j.error.message });
        continue;
      }
      nameMap.set(tk, j.name || `Account ${i + 1}`);
    } catch (e) {
      sseSend(streamId, 'token_error', { tokenIndex: i + 1, code: 'network', msg: String(e) });
    }
    await sleep(200);
  }
  return nameMap;
}

function classifyError(err) {
  const out = { type: 'failed', label: 'Failed' };
  if (!err || !err.code) return out;
  const c = Number(err.code);
  const sub = Number(err.error_subcode || 0);

  if (c === 190) {
    if (sub === 463 || sub === 460 || sub === 459) return { type: 'expired', label: 'Token Expired' };
    return { type: 'invalid', label: 'Token Invalid' };
  }
  if (c === 200 || c === 10) return { type: 'perm', label: 'Missing Permission' };
  if (c === 368) return { type: 'blocked', label: 'Temporarily Blocked' };
  if (c === 803 || c === 100) return { type: 'badpost', label: 'Bad Post' };
  if (c === 4 || c === 2) return { type: 'ratelimit', label: 'Rate/Service Limit' };

  return out;
}

// -------- Start job --------
app.post('/api/start', upload.fields([
  { name: 'commentsFile' }, { name: 'tokensFile' }, { name: 'postsFile' }, { name: 'linksFile' }
]), async (req, res) => {
  const sessionId = req.body.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, msg: 'sessionId required' });

  // gather inputs
  const comments = uniq([
    ...textToList(req.files?.commentsFile?.[0]?.buffer?.toString()),
  ]);

  const tokens = uniq([
    ...textToList(req.files?.tokensFile?.[0]?.buffer?.toString()),
  ]);

  const postIdsInput = uniq([
    ...csvToList(req.body.postIds || ''),
    ...textToList(req.files?.postsFile?.[0]?.buffer?.toString())
  ]);

  const postLinksInput = uniq([
    req.body.postLink1, req.body.postLink2, req.body.postLink3,
    ...textToList(req.files?.linksFile?.[0]?.buffer?.toString())
  ]);

  const delay = Math.max(0, parseInt(req.body.delay || '0', 10));
  const maxSuccess = Math.max(0, parseInt(req.body.maxSuccess || '0', 10)) || Infinity;

  if (!comments.length || !tokens.length || (!postIdsInput.length && !postLinksInput.length)) {
    return res.status(400).json({ ok: false, msg: 'Provide tokens + comments + (post IDs or links)' });
  }

  // resolve posts
  const postIds = await resolvePostIds(postIdsInput, postLinksInput, tokens, sessionId);
  if (!postIds.length) {
    return res.status(400).json({ ok: false, msg: 'No valid posts to comment on' });
  }

  // token → name
  const tokenNameMap = await getTokenNameMap(tokens, sessionId);

  // create job flag
  jobs.set(sessionId, { stop: false });
  res.json({ ok: true, posts: postIds.length, comments: comments.length, tokens: tokens.length });

  // round-robin commenting
  let successCount = 0;
  let tokenIndex = 0;

  outer:
  for (let p = 0; p < postIds.length; p++) {
    const postId = postIds[p];

    for (let cIdx = 0; cIdx < comments.length; cIdx++) {
      const comment = comments[cIdx];
      if (jobs.get(sessionId)?.stop) {
        sseSend(sessionId, 'stopped', { msg: 'Stopped by user' });
        break outer;
      }
      if (successCount >= maxSuccess) {
        sseSend(sessionId, 'done', { msg: `Reached max success: ${maxSuccess}` });
        break outer;
      }

      // pick token (skip ones already marked dead)
      let token = null;
      let tries = 0;
      while (tries < tokens.length) {
        token = tokens[tokenIndex % tokens.length];
        tokenIndex++;
        tries++;
        // if previously marked dead, skip (we mark with empty string)
        if (token) break;
      }
      if (!token) {
        sseSend(sessionId, 'done', { msg: 'No usable tokens left' });
        break outer;
      }

      // post comment
      const body = new URLSearchParams({
        message: comment,
        access_token: token
      });

      try {
        const r = await fetch(`https://graph.facebook.com/${encodeURIComponent(postId)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const j = await r.json();

        if (j.error) {
          const klass = classifyError(j.error);
          // mark token dead on certain errors
          if (['invalid', 'expired', 'blocked', 'perm'].includes(klass.type)) {
            const idx = tokens.indexOf(token);
            tokens[idx] = ''; // disable
          }
          sseSend(sessionId, klass.type, {
            postId,
            comment: comment.slice(0, 140),
            tokenName: tokenNameMap.get(token) || 'Unknown',
            code: j.error.code,
            subcode: j.error.error_subcode,
            message: j.error.message
          });
        } else {
          successCount++;
          sseSend(sessionId, 'success', {
            postId,
            comment: comment.slice(0, 140),
            tokenName: tokenNameMap.get(token) || 'Unknown',
            id: j.id || null
          });
        }
      } catch (e) {
        sseSend(sessionId, 'failed', {
          postId,
          comment: comment.slice(0, 140),
          tokenName: tokenNameMap.get(token) || 'Unknown',
          message: String(e)
        });
      }

      if (delay > 0) await sleep(delay * 1000);
    }
  }

  sseSend(sessionId, 'done', { msg: 'All tasks finished.' });
  jobs.delete(sessionId);
});

// stop
app.post('/api/stop', express.urlencoded({ extended: true }), (req, res) => {
  const { id } = req.body;
  const job = jobs.get(id);
  if (job) job.stop = true;
  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
