// FragLy AI Coach — server-side proxy (Cloudflare Pages Function).
//
// Why this exists:
//   Calling Pollinations directly from the browser failed in prod (CORS preflight +
//   per-IP rate limits). Running it server-side fixes both, and keeps the token off
//   the client. Still keyless for end users.
//
// Token: set POLLINATIONS_TOKEN in Cloudflare Pages env (Settings → Environment
//   variables). Optional — without it we use the free anonymous tier.
//
// Upstream quirks this file works around (all verified against the live API):
//   - gen.pollinations.ai bills per request. With an empty balance it returns 402
//     ("Insufficient balance"), so it can't be the only path.
//   - text.pollinations.ai is free ANONYMOUSLY, but sending `temperature`, `token`,
//     or POSTing a JSON body all flip the request onto the (empty) paid key and it
//     402s — a plain GET with just `model` stays on the free tier and returns 200.
//   - A billed/hung upstream call can sit for ~30s. Two of those in series blew past
//     Cloudflare's edge timeout, which is what produced the bare "error code: 502"
//     users saw instead of a real response. Hence the hard budget below: we always
//     return our own JSON, fast, so the client can fall back to the local coach.

const GEN = 'https://gen.pollinations.ai/v1/chat/completions';
const LEGACY = 'https://text.pollinations.ai';
const ATTEMPT_TIMEOUT_MS = 8000;  // per upstream call
const TOTAL_BUDGET_MS = 18000;    // whole request — comfortably under the edge timeout
const MIN_ATTEMPT_MS = 2500;      // don't start an attempt we can't finish
const LEGACY_PROMPT_MAX = 1100;   // free-tier cost scales with prompt size

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

// The legacy endpoint takes the whole conversation as one URL path segment, so keep it
// compact: system context first (that's the real stats the answer must be based on),
// then the most recent turns, trimmed to what the free tier will accept.
function buildLegacyPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content || '').join('\n');
  const turns = messages.filter((m) => m.role !== 'system').slice(-4);
  let out = system ? system.trim() + '\n\n' : '';
  out += turns.map((m) => `${String(m.role || 'user').toUpperCase()}: ${m.content || ''}`).join('\n\n');
  out += '\n\nASSISTANT:';
  return out.length > LEGACY_PROMPT_MAX ? out.slice(0, LEGACY_PROMPT_MAX) + '\n\nASSISTANT:' : out;
}

// A 402/401 means the key is out of balance or invalid — retrying burns budget for
// nothing. Only a 429 or a 5xx is worth a second go.
function worthRetry(status) {
  return status === 429 || status >= 500;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const token = env.POLLINATIONS_TOKEN || '';
  const startedAt = Date.now();
  const msLeft = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);

  let messages;
  try {
    const body = await request.json();
    messages = Array.isArray(body.messages) ? body.messages : null;
  } catch (e) {
    messages = null;
  }
  if (!messages || !messages.length) {
    return jsonRes({ error: 'messages array required' }, 400);
  }
  messages = messages.slice(-10);

  let upstreamStatus = 0;

  // 1) Authenticated endpoint. Best quality and the officially supported path, but it
  //    is billed — skip entirely when no token is configured.
  if (token && msLeft() > MIN_ATTEMPT_MS) {
    try {
      const r = await fetchWithTimeout(GEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          model: 'openai',
          messages,
          temperature: 0.45,
          max_tokens: 700,
          stream: false
        })
      }, Math.min(ATTEMPT_TIMEOUT_MS, msLeft()));
      upstreamStatus = r.status;
      if (r.ok) {
        const text = extractText(await r.json());
        if (text && text.trim()) {
          return jsonRes({ text: text.trim(), provider: 'pollinations-gen' });
        }
      }
    } catch (e) {
      upstreamStatus = e && e.name === 'AbortError' ? 598 : 599;
    }
  }

  // 2) Free anonymous tier. Deliberately a bare GET: no temperature, no token, no
  //    referrer — any of those bills it to the paid key and it 402s (see header note).
  const legacyUrl = `${LEGACY}/${encodeURIComponent(buildLegacyPrompt(messages))}?model=openai`;
  for (let attempt = 0; attempt < 2 && msLeft() > MIN_ATTEMPT_MS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetchWithTimeout(legacyUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FraglyBot/1.0)' }
      }, Math.min(ATTEMPT_TIMEOUT_MS, msLeft()));
      upstreamStatus = r.status;
      if (r.ok) {
        const text = (await r.text()).trim();
        // The free tier hands back a JSON error body with a 200 in some cases.
        if (text && !text.startsWith('{"error"')) {
          return jsonRes({ text, provider: 'pollinations-free' });
        }
      }
      if (!worthRetry(r.status)) break;
    } catch (e) {
      upstreamStatus = e && e.name === 'AbortError' ? 598 : 599;
    }
  }

  const reason = upstreamStatus === 402 ? 'AI credits exhausted'
    : upstreamStatus === 429 ? 'AI is busy right now'
    : upstreamStatus === 598 ? 'AI timed out'
    : 'AI temporarily unavailable';
  console.error('coach: all providers failed', { upstreamStatus, ms: Date.now() - startedAt });
  return jsonRes({ error: 'Upstream AI unavailable', reason, upstreamStatus }, 503);
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return jsonRes({ error: 'Method not allowed' }, 405);
  }
  return onRequestPost(context);
}
