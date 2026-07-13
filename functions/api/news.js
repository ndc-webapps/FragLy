// Public, cached VALORANT news feed — real articles straight from Riot's own official
// news page (playvalorant.com/en-us/news/). That page is a Next.js app and ships its
// article list inside the embedded __NEXT_DATA__ JSON blob; there's no public JSON API
// for it, so we fetch the HTML server-side (avoids CORS a client-side fetch would hit
// anyway) and extract that blob. Real Riot content, not fabricated — just re-served in
// a normalized shape.
//
// Cached in the same KV namespace the ads/leaderboard/sample systems use (binding:
// FRAGLY_ADS, different key) so traffic can't hammer Riot's site — a 45min cache is
// plenty fresh for news that publishes at most a few times a day.
const NEWS_URL = 'https://playvalorant.com/en-us/news/';
const CACHE_KEY = 'valorant_news_v1';
const CACHE_TTL_MS = 45 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

async function fetchArticles() {
  const r = await fetch(NEWS_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FraglyBot/1.0)' } });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('news page shape changed — no __NEXT_DATA__ found');
  const data = JSON.parse(m[1]);
  const blades = data?.props?.pageProps?.page?.blades || [];
  const grid = blades.find((b) => b.type === 'articleCardGrid');
  const items = grid?.items || [];
  return items
    .filter((it) => it.title && it.action?.payload?.url)
    .slice(0, 60)
    .map((it) => ({
      title: it.title,
      url: it.action.payload.url,
      image: it.media?.url || it.imageMedia?.url || '',
      category: it.category?.title || 'News',
      description: it.description?.body || '',
      publishedAt: it.publishedAt || it.analytics?.publishDate || null
    }));
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

  try {
    const articles = await fetchArticles();
    if (!articles.length) throw new Error('no articles parsed');
    const payload = { articles, updatedAt: Date.now() };
    if (env.FRAGLY_ADS) {
      await env.FRAGLY_ADS.put(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), payload }));
    }
    return json(payload);
  } catch (e) {
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
        if (raw) return json(JSON.parse(raw).payload);
      } catch (e2) { /* no usable cache either */ }
    }
    return json({ error: 'News feed unavailable' }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
