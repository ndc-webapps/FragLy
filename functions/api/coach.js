// FragLy AI Coach — server-side proxy (Cloudflare Pages Function).
//
// Why this exists:
//   Calling text.pollinations.ai directly from the browser failed in prod
//   (CORS preflight + per-IP "Queue full" rate limit on the anonymous tier).
//   Running the call server-side fixes all of it: same-origin for the browser
//   (no CORS), a clean datacenter IP (not the user's throttled/shared IP), and
//   the token stays off the client. Still keyless for end users.
//
// Token: set POLLINATIONS_TOKEN in Cloudflare Pages env (Settings →
//   Environment variables). No token is shipped to the browser.

const REFERRER = 'fragly.pages.dev';
// Authenticated generation host (OpenAI-compatible). The token bypasses the
// per-IP "Queue full" limit here — verified returning 200 from a queue-blocked
// IP. The legacy text.pollinations.ai ignored the token; gen.* honors it.
const GEN = 'https://gen.pollinations.ai/v1/chat/completions';
const LEGACY = 'https://text.pollinations.ai';
const FETCH_TIMEOUT_MS = 6000; // per-attempt cap — an upstream that hangs (rather than erroring
                                // fast) used to stall every retry in turn with no bound, which is
                                // what actually produced the user-visible "502" hang, not a clean fail

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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

export async function onRequestPost(context) {
  const { request, env } = context;
  const POLLINATIONS_TOKEN = env.POLLINATIONS_TOKEN || '';

  let messages;
  try {
    const body = await request.json();
    messages = Array.isArray(body.messages) ? body.messages : null;
  } catch (e) {
    messages = null;
  }
  if (!messages || !messages.length) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (POLLINATIONS_TOKEN) headers['Authorization'] = 'Bearer ' + POLLINATIONS_TOKEN;
  const tokenQ = POLLINATIONS_TOKEN ? `&token=${encodeURIComponent(POLLINATIONS_TOKEN)}` : '';

  const payload = {
    model: 'openai',
    messages: messages.slice(-10),
    temperature: 0.45,
    max_tokens: 700,
    stream: false
  };

  // 1) Authenticated OpenAI-compatible endpoint. The token bypasses the per-IP
  //    queue here, so this is normally the reliable path. Bounded retry: each
  //    attempt can fail fast (timeout) instead of hanging, so a bad upstream
  //    can't stall the whole request past a predictable ceiling.
  let upstreamStatus = 0;
  const backoff = [0, 600];
  for (let i = 0; i < backoff.length; i++) {
    if (backoff[i]) await new Promise((r) => setTimeout(r, backoff[i]));
    try {
      const r = await fetchWithTimeout(GEN, { method: 'POST', headers, body: JSON.stringify(payload) });
      upstreamStatus = r.status;
      if (r.ok) {
        const data = await r.json();
        const text = extractText(data);
        if (text && text.trim()) {
          return new Response(JSON.stringify({ text: text.trim(), provider: 'pollinations-gen' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      // 4xx (other than 429) won't improve on retry
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      upstreamStatus = upstreamStatus || (e && e.name === 'AbortError' ? 598 : 599);
    }
  }

  // 2) Legacy fallback (anonymous tier) — best-effort if gen.* is unavailable
  try {
    const prompt = messages.map((m) => `${String(m.role || 'user').toUpperCase()}: ${m.content || ''}`).join('\n\n') + '\n\nASSISTANT:';
    const url = `${LEGACY}/${encodeURIComponent(prompt.slice(0, 1800))}?model=openai&temperature=0.45&referrer=${encodeURIComponent(REFERRER)}${tokenQ}`;
    let r;
    for (let i = 0; i < 2; i++) {
      if (i > 0) await new Promise((rs) => setTimeout(rs, 600));
      r = await fetchWithTimeout(url, { headers: POLLINATIONS_TOKEN ? { Authorization: 'Bearer ' + POLLINATIONS_TOKEN } : {} });
      if (r.status !== 429) break;
    }
    upstreamStatus = r.status;
    if (r.ok) {
      const text = (await r.text()).trim();
      if (text) {
        return new Response(JSON.stringify({ text, provider: 'pollinations-legacy' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
  } catch (e) {
    upstreamStatus = upstreamStatus || (e && e.name === 'AbortError' ? 598 : 599);
  }

  return new Response(JSON.stringify({ error: 'Upstream AI unavailable', upstreamStatus }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return onRequestPost(context);
}
