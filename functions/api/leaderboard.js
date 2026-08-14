// Public, cached regional leaderboard — real ranked players, real RR/wins, straight from
// the Henrik API. GET /api/leaderboard?region=na (default na). Fetch/cache logic lives in
// ../_lib/leaderboard.js, shared with the SSR /leaderboard/ page.
import { getLeaderboardPayload, REGIONS } from '../_lib/leaderboard.js';

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

  const payload = await getLeaderboardPayload(env, region);
  if (!payload) return json({ error: 'Leaderboard unavailable' }, 502);
  return json(payload);
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
