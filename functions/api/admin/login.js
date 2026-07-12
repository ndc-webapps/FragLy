// POST { password } -> sets a signed session cookie on success.
// Failed attempts are throttled per-IP via KV (falls back to no throttling if
// the KV binding isn't configured yet, so local/dev setups don't hard-fail).
import { createSessionToken, setSessionCookie, passwordMatches, json } from '../../_lib/auth.js';

const MAX_ATTEMPTS = 8;
const LOCKOUT_WINDOW_SECONDS = 15 * 60;

async function tooManyAttempts(env, ip) {
  if (!env.FRAGLY_ADS) return false;
  const raw = await env.FRAGLY_ADS.get(`loginfail:${ip}`);
  return (raw ? parseInt(raw, 10) || 0 : 0) >= MAX_ATTEMPTS;
}
async function recordFailure(env, ip) {
  if (!env.FRAGLY_ADS) return;
  const key = `loginfail:${ip}`;
  const raw = await env.FRAGLY_ADS.get(key);
  const count = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
  await env.FRAGLY_ADS.put(key, String(count), { expirationTtl: LOCKOUT_WINDOW_SECONDS });
}
async function clearFailures(env, ip) {
  if (!env.FRAGLY_ADS) return;
  await env.FRAGLY_ADS.delete(`loginfail:${ip}`);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: 'Admin panel is not configured yet (missing ADMIN_PASSWORD / SESSION_SECRET env vars).' }, 500);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await tooManyAttempts(env, ip)) {
    return json({ error: 'Too many failed attempts. Try again in a few minutes.' }, 429);
  }

  let password = '';
  try {
    const body = await request.json();
    password = body.password;
  } catch (e) { /* falls through to the mismatch response below */ }

  if (!passwordMatches(env, password)) {
    await recordFailure(env, ip);
    return json({ error: 'Incorrect password.' }, 401);
  }

  await clearFailures(env, ip);
  const token = await createSessionToken(env);
  return json({ ok: true }, 200, { 'Set-Cookie': setSessionCookie(token) });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
