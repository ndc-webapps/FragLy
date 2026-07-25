const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';

// Only the endpoints FragLy actually calls. The old version forwarded ANY path (just
// blocked "../"), so anyone could point this proxy at arbitrary HenrikDev routes using
// our shared API key/quota. Update this list if a new endpoint is wired up client-side.
const ALLOWED_PREFIXES = [
  'v1/account/', 'v1/mmr-history/', 'v1/stored-matches/',
  'v2/leaderboard/', 'v2/mmr/', 'v3/matches/', 'v4/match/'
];

export async function onRequestGet(context) {
  const { request, env } = context;
  const HENRIK_API_KEY = env.HENRIK_API_KEY || env.HDEV_API_KEY || '';

  const incoming = new URL(request.url);
  const path = String(incoming.searchParams.get('path') || '').replace(/^\/+/, '');
  if (!path || path.includes('..') || !ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return new Response(JSON.stringify({ error: 'Invalid HenrikDev path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Edge cache (Cloudflare's Cache API, not KV — no write-quota risk) dedupes repeat
  // lookups of the same player/leaderboard within a short window. Same origin request
  // hitting the same upstream URL within the TTL is served from cache, no upstream call.
  const cache = caches.default;
  const cacheKey = new Request(incoming.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = new URL(`${HENRIK_BASE}/${path}`);
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'path') upstream.searchParams.append(key, value);
  });

  const headers = {};
  if (HENRIK_API_KEY) headers.Authorization = HENRIK_API_KEY;

  try {
    const r = await fetch(upstream, { headers });
    const body = await r.text();
    // Leaderboard is the same response for every visitor of a region, worth caching
    // longer; account/mmr/matches are per-player, short TTL just to absorb bursts
    // (double-clicks, the same player searched by multiple people at once).
    const ttl = path.startsWith('v2/leaderboard/') ? 60 : 20;
    const res = new Response(body, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/json',
        'Cache-Control': r.ok ? `public, max-age=${ttl}` : 'no-store'
      }
    });
    if (r.ok) context.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    console.error('henrik proxy upstream error', { path, message: e && e.message });
    return new Response(JSON.stringify({ error: 'HenrikDev upstream unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return onRequestGet(context);
}
