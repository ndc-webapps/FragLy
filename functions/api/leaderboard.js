// Public, cached regional leaderboard — real ranked players, real RR/wins, straight from
// the Henrik API. GET /api/leaderboard?region=na (default na).
//
// Cached per-region in the same KV namespace the ads/sample systems use (binding:
// FRAGLY_ADS, different keys) so traffic can't multiply upstream calls — the leaderboard
// itself only refreshes ~every 30min on Henrik's side anyway, so a 15min cache here is
// safely fresh without hammering it.
const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';
const REGIONS = ['na', 'eu', 'ap', 'kr', 'latam', 'br'];
const TOP_N = 50;
const CACHE_TTL_MS = 15 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const region = String(url.searchParams.get('region') || 'na').toLowerCase();
  if (!REGIONS.includes(region)) {
    return json({ error: `region must be one of: ${REGIONS.join(', ')}` }, 400);
  }

  const cacheKey = `leaderboard_${region}`;

  if (env.FRAGLY_ADS) {
    try {
      const raw = await env.FRAGLY_ADS.get(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return json(cached.payload);
        }
      }
    } catch (e) { /* corrupt/missing cache — fall through to a fresh fetch */ }
  }

  const headers = {};
  const key = env.HENRIK_API_KEY || env.HDEV_API_KEY || '';
  if (key) headers.Authorization = key;

  try {
    const r = await fetch(`${HENRIK_BASE}/v2/leaderboard/${region}`, { headers });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const data = await r.json();
    const players = (data.players || []).slice(0, TOP_N).map((p) => ({
      rank: p.leaderboardRank,
      name: p.gameName,
      tag: p.tagLine,
      rr: p.rankedRating,
      wins: p.numberOfWins,
      tier: p.competitiveTier
    }));
    const payload = { region, updatedAt: (data.last_update ? data.last_update * 1000 : Date.now()), players };
    if (env.FRAGLY_ADS) {
      await env.FRAGLY_ADS.put(cacheKey, JSON.stringify({ cachedAt: Date.now(), payload }));
    }
    return json(payload);
  } catch (e) {
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(cacheKey);
        if (raw) return json(JSON.parse(raw).payload);
      } catch (e2) { /* no usable cache either */ }
    }
    return json({ error: 'Leaderboard unavailable' }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
