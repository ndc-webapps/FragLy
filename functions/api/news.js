// Public, cached VALORANT news feed — real articles straight from Riot's own official
// news page (playvalorant.com/en-us/news/). Fetch/parse/cache logic lives in
// ../_lib/news.js, shared with the SSR /news/ page so both serve the same real content.
import { getNewsPayload } from '../_lib/news.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

export async function onRequestGet(context) {
  const payload = await getNewsPayload(context.env);
  if (!payload) return json({ error: 'News feed unavailable' }, 502);
  return json(payload);
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
