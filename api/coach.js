// FragLy AI Coach — server-side proxy (Vercel serverless function).
//
// Why this exists:
//   Calling text.pollinations.ai directly from the browser failed in prod
//   (CORS preflight + per-IP "Queue full" rate limit on the anonymous tier).
//   Running the call server-side fixes all of it: same-origin for the browser
//   (no CORS), a clean datacenter IP (not the user's throttled/shared IP), and
//   the token stays off the client. Still keyless for end users.
//
// Token: set POLLINATIONS_TOKEN in Vercel env (Project → Settings → Environment
//   Variables). Falls back to the baked constant so it works without config.

const POLLINATIONS_TOKEN = process.env.POLLINATIONS_TOKEN || 'sk_B20Nen9oQEmtYvH1EOPsOqGCbwI70H4t';
const REFERRER = 'fragly.vercel.app';
const BASE = 'https://text.pollinations.ai';

function extractText(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data.choices) && data.choices[0]) {
    const c = data.choices[0];
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  if (data.message && typeof data.message.content === 'string') return data.message.content;
  return '';
}

async function readJsonBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return req.body;
  }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let messages;
  try {
    const body = await readJsonBody(req);
    messages = Array.isArray(body.messages) ? body.messages : null;
  } catch (e) {
    messages = null;
  }
  if (!messages || !messages.length) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'messages array required' }));
  }

  const headers = { 'Content-Type': 'application/json' };
  if (POLLINATIONS_TOKEN) headers['Authorization'] = 'Bearer ' + POLLINATIONS_TOKEN;

  const payload = {
    model: 'openai',
    messages: messages.slice(-10),
    temperature: 0.45,
    max_tokens: 700,
    stream: false
  };

  // 1) OpenAI-compatible POST (with one retry on transient 429)
  let upstreamStatus = 0;
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      const r = await fetch(`${BASE}/openai?referrer=${encodeURIComponent(REFERRER)}`, {
        method: 'POST', headers, body: JSON.stringify(payload)
      });
      upstreamStatus = r.status;
      if (r.ok) {
        const data = await r.json();
        const text = extractText(data);
        if (text && text.trim()) {
          res.statusCode = 200;
          return res.end(JSON.stringify({ text: text.trim(), provider: 'pollinations-openai' }));
        }
      }
      if (r.status !== 429) break;
    } catch (e) {
      upstreamStatus = upstreamStatus || 599;
    }
  }

  // 2) Simple GET fallback (prompt-in-URL)
  try {
    const prompt = messages.map((m) => `${String(m.role || 'user').toUpperCase()}: ${m.content || ''}`).join('\n\n') + '\n\nASSISTANT:';
    const url = `${BASE}/${encodeURIComponent(prompt.slice(0, 1800))}?model=openai&temperature=0.45&referrer=${encodeURIComponent(REFERRER)}`;
    const r = await fetch(url, { headers: POLLINATIONS_TOKEN ? { Authorization: 'Bearer ' + POLLINATIONS_TOKEN } : {} });
    upstreamStatus = r.status;
    if (r.ok) {
      const text = (await r.text()).trim();
      if (text) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ text, provider: 'pollinations-text' }));
      }
    }
  } catch (e) {
    upstreamStatus = upstreamStatus || 599;
  }

  res.statusCode = 502;
  return res.end(JSON.stringify({ error: 'Upstream AI unavailable', upstreamStatus }));
};
