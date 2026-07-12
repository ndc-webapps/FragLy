// Public, cached "sample report" — real stats for whoever is CURRENTLY #1 on the NA
// leaderboard, so a visitor (or a search crawler) sees an actual populated dashboard
// without needing to search first. Real Valorant API data, not fabricated — just not
// the visitor's own account.
//
// Deliberately not a hardcoded player: a fixed Riot ID (we first tried TenZ#NA1) can go
// stale the moment that person changes their tag, silently breaking the sample. Pulling
// the live #1 leaderboard spot self-heals — it's always someone real and currently active.
//
// Cached in the same KV namespace the ads system uses (binding: FRAGLY_ADS, different
// key) so a traffic spike can't multiply calls against the real Henrik API — this is
// read-through with a 20-minute TTL, at most a few upstream calls per cache window
// regardless of how many people load the page.
const HENRIK_BASE = 'https://api.henrikdev.xyz/valorant';
const SAMPLE_REGION = 'na';
const CACHE_KEY = 'sample_report_v1';
const CACHE_TTL_MS = 20 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}

export async function onRequestGet(context) {
  const { env } = context;

  if (env.FRAGLY_ADS) {
    try {
      const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
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
  const enc = encodeURIComponent;

  try {
    // Pick whoever is CURRENTLY #1 on the NA leaderboard — always a real, active account.
    const board = await fetchJson(`${HENRIK_BASE}/v2/leaderboard/${SAMPLE_REGION}`, headers);
    const top = (board.players || [])[0];
    if (!top || !top.gameName || !top.tagLine) throw new Error('leaderboard empty');
    const name = top.gameName, tag = top.tagLine;

    const [acc, mmr, mData] = await Promise.all([
      fetchJson(`${HENRIK_BASE}/v1/account/${enc(name)}/${enc(tag)}`, headers),
      fetchJson(`${HENRIK_BASE}/v2/mmr/${SAMPLE_REGION}/${enc(name)}/${enc(tag)}`, headers),
      fetchJson(`${HENRIK_BASE}/v3/matches/${SAMPLE_REGION}/${enc(name)}/${enc(tag)}?size=10`, headers)
    ]);
    const matches = mData.data || [];
    if (!matches.length) throw new Error('no match history for current #1 — will retry next request');

    const payload = { acc: acc.data, mmr: mmr.data, matches, name, tag, region: SAMPLE_REGION };
    if (env.FRAGLY_ADS) {
      await env.FRAGLY_ADS.put(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), payload }));
    }
    return json(payload);
  } catch (e) {
    // Upstream hiccup — serve stale cache if there is one rather than nothing at all.
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
        if (raw) return json(JSON.parse(raw).payload);
      } catch (e2) { /* no usable cache either */ }
    }
    return json({ error: 'Sample report unavailable' }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
