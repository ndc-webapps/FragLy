// GET /api/health -> { ok, checks: { henrik, valorantApi } }
// Point a free uptime monitor (UptimeRobot, Cronitor, etc.) at this — the site has no
// error alerting otherwise, so an upstream outage (HenrikDev key expired, etc.) would
// only surface as a user screenshot. Checks the two real upstreams the site depends on.
async function ping(url, opts) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { ...opts, signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  const key = env.HENRIK_API_KEY || env.HDEV_API_KEY || '';
  const [henrik, valorantApi] = await Promise.all([
    ping('https://api.henrikdev.xyz/valorant/v1/status/na', key ? { headers: { Authorization: key } } : undefined),
    ping('https://valorant-api.com/v1/weapons')
  ]);
  const ok = henrik && valorantApi;
  return new Response(JSON.stringify({ ok, checks: { henrik, valorantApi }, ts: Date.now() }), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  return onRequestGet(context);
}
