// Shared regional leaderboard fetch + cache — pulled out of api/leaderboard.js so the
// SSR page (leaderboard/index.js) and the JSON endpoint share one implementation and one
// KV cache entry instead of drifting apart.
const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';
export const REGIONS = ['na', 'eu', 'ap', 'kr', 'latam', 'br'];
const TOP_N = 50;
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function getLeaderboardPayload(env, region) {
  const cacheKey = `leaderboard_${region}`;

  if (env.FRAGLY_ADS) {
    try {
      const raw = await env.FRAGLY_ADS.get(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.payload;
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
    return payload;
  } catch (e) {
    console.error('leaderboard: fetch failed', { region, message: e && e.message });
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(cacheKey);
        if (raw) return JSON.parse(raw).payload;
      } catch (e2) { /* no usable cache either */ }
    }
    return null;
  }
}
