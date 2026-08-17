// FragLy AI Coach — server-side proxy (Cloudflare Pages Function).
//
// Both providers below are free and reset on a daily cadence. Neither is unlimited —
// no free LLM API is — so the client always keeps its local stat-based coach as the
// final fallback, and this file's job is to fail FAST and honestly rather than hang.
//
// 1) Cloudflare Workers AI (primary) — no API key at all, runs on the same edge as
//    this function. Free grant is 10,000 Neurons/day, reset 00:00 UTC, on Free and
//    Paid plans alike. At ~$0.011/1000 Neurons that is ~$0.11/day of compute, which
//    on llama-3.1-8b works out to roughly 200-250 coach replies a day.
//    SETUP: Pages project → Settings → Bindings → Add → Workers AI → name it `AI`.
//    Optional: CF_AI_MODEL to override the model.
//
// 2) Google Gemini (fallback) — used only once the Workers AI grant is spent. Free
//    tier, no billing, RPD resets midnight Pacific. Defaults to Flash-Lite because
//    this tier exists to stretch the free quota, not to win benchmarks.
//    SETUP: free key from aistudio.google.com → Pages env var GEMINI_API_KEY.
//    Optional: GEMINI_MODEL to override.
//
// Pollinations was removed deliberately: gen.pollinations.ai billed per request and
// 402'd on an empty balance, the anonymous text endpoint 429'd under any real load,
// and a hung upstream there was the original cause of the bare 502s users saw.

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta/models';

// Cloudflare retires models on a rolling basis — @cf/meta/llama-3.1-8b-instruct was
// deprecated 2026-05-30 and took the coach down with a 5028. So this is a candidate
// list, not a single ID: on a "model is gone" error we advance to the next one and
// the coach keeps working until someone gets round to updating this file.
// Quality first; Gemini and the local coach backstop the daily quota.
// Set CF_AI_MODEL to pin one explicitly.
const CF_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.2-1b-instruct'
];
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// A dead/renamed model is worth retrying with a different ID. Anything else —
// especially a spent Neuron grant — applies to every model, so bail to Gemini.
function modelUnavailable(msg) {
  return /5028|deprecat|not found|no such model|unknown model|invalid model|does not exist/i.test(msg);
}

const ATTEMPT_TIMEOUT_MS = 9000;  // per provider
const TOTAL_BUDGET_MS = 20000;    // whole request — stays under the edge timeout
const MIN_ATTEMPT_MS = 2500;      // don't start an attempt we can't finish
const MAX_TOKENS = 700;
const TEMPERATURE = 0.45;

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Workers AI returns { response: "..." }; Gemini nests it under candidates/content/parts.
function extractCfText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data.response === 'string') return data.response;
  if (Array.isArray(data.choices) && data.choices[0]?.message?.content) return data.choices[0].message.content;
  return '';
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

// Gemini keeps the system prompt out of the turn list and calls the assistant "model".
function toGeminiBody(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content || '').join('\n').trim();
  const contents = messages
    .filter((m) => m.role !== 'system' && (m.content || '').trim())
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }]
    }));
  const body = {
    contents,
    generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_TOKENS }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

export async function onRequestPost(context) {
  const { request, env } = context;
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
  messages = messages
    .slice(-10)
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: m.content }));
  if (!messages.length) {
    return jsonRes({ error: 'messages array required' }, 400);
  }

  const failures = [];

  // 1) Workers AI — no key, same edge, daily free grant.
  if (env.AI) {
    const candidates = env.CF_AI_MODEL ? [env.CF_AI_MODEL] : CF_MODELS;
    for (const model of candidates) {
      if (msLeft() < MIN_ATTEMPT_MS) break;
      try {
        const data = await withTimeout(
          env.AI.run(model, { messages, max_tokens: MAX_TOKENS, temperature: TEMPERATURE }),
          Math.min(ATTEMPT_TIMEOUT_MS, msLeft())
        );
        const text = extractCfText(data).trim();
        if (text) return jsonRes({ text, provider: 'cloudflare-workers-ai', model });
        failures.push({ provider: 'workers-ai', model, error: 'empty response' });
      } catch (e) {
        // A spent Neuron grant surfaces here as a thrown error, not a status code.
        const msg = String((e && e.message) || e);
        failures.push({ provider: 'workers-ai', model, error: msg.slice(0, 200) });
        if (!modelUnavailable(msg)) break;   // quota/outage — no other model will help
      }
    }
  } else {
    failures.push({ provider: 'workers-ai', error: 'AI binding not configured' });
  }

  // 2) Gemini — only reached once Workers AI is exhausted or unconfigured.
  const geminiKey = env.GEMINI_API_KEY || '';
  if (geminiKey && msLeft() > MIN_ATTEMPT_MS) {
    const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    try {
      const r = await withTimeout(
        fetch(`${GEMINI_HOST}/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify(toGeminiBody(messages))
        }),
        Math.min(ATTEMPT_TIMEOUT_MS, msLeft())
      );
      if (r.ok) {
        const text = extractGeminiText(await r.json());
        if (text) return jsonRes({ text, provider: 'gemini' });
        failures.push({ provider: 'gemini', error: 'empty response' });
      } else {
        let detail = '';
        try { detail = ((await r.json())?.error?.message || '').slice(0, 200); } catch (e) { /* body not JSON */ }
        failures.push({ provider: 'gemini', status: r.status, error: detail });
      }
    } catch (e) {
      failures.push({ provider: 'gemini', error: String((e && e.message) || e).slice(0, 200) });
    }
  } else if (!geminiKey) {
    failures.push({ provider: 'gemini', error: 'GEMINI_API_KEY not set' });
  }

  const blob = JSON.stringify(failures).toLowerCase();
  const reason = !env.AI && !geminiKey ? 'AI not configured on this deployment'
    : /quota|limit|exhaust|neuron|429|resource_exhausted/.test(blob) ? 'Daily free AI limit reached — it resets tomorrow'
    : /timeout/.test(blob) ? 'AI timed out'
    : 'AI temporarily unavailable';

  console.error('coach: all providers failed', { failures, ms: Date.now() - startedAt });
  return jsonRes({ error: 'Upstream AI unavailable', reason, failures }, 503);
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return jsonRes({ error: 'Method not allowed' }, 405);
  }
  return onRequestPost(context);
}
