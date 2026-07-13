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
const NEWS_BASE = 'https://playvalorant.com';
const NEWS_URL = NEWS_BASE + '/en-us/news/';
const CACHE_KEY = 'valorant_news_v1';
const CACHE_TTL_MS = 45 * 60 * 1000;
const SUMMARY_MAX_CHARS = 900;
const SUMMARY_FETCH_TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; FraglyBot/1.0)';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

function htmlToPlainText(html) {
  return html
    .replace(/<\/(p|li|h[1-6])>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  const clean = lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak + 1) : cut;
  return clean.trim() + '…';
}

// Riot's article pages (patch notes, dev diaries, announcements) carry their real body
// copy as HTML inside "articleRichText" blades in the same embedded __NEXT_DATA__ blob
// the listing page uses. We pull those, strip markup down to plain text, and cap it —
// a real multi-paragraph summary sourced straight from Riot, not the full article
// (patch notes alone can run thousands of words) and not a scrape of someone else's
// rewrite of it.
async function fetchArticleSummary(url) {
  try {
    const r = await fetchWithTimeout(url, SUMMARY_FETCH_TIMEOUT_MS);
    if (!r.ok) return null;
    const html = await r.text();
    const data = extractNextData(html);
    const blades = data?.props?.pageProps?.page?.blades || [];
    const richBlocks = blades.filter((b) => b.type === 'articleRichText' && b.richText?.body);
    if (!richBlocks.length) return null;
    const combined = richBlocks.map((b) => htmlToPlainText(b.richText.body)).join('\n\n').trim();
    if (!combined) return null;
    return truncateAtBoundary(combined, SUMMARY_MAX_CHARS);
  } catch (e) {
    return null; // timeout, network hiccup, or shape change — caller falls back to the teaser
  }
}

async function fetchArticles() {
  const r = await fetch(NEWS_URL, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const html = await r.text();
  const data = extractNextData(html);
  if (!data) throw new Error('news page shape changed — no __NEXT_DATA__ found');
  const blades = data?.props?.pageProps?.page?.blades || [];
  const grid = blades.find((b) => b.type === 'articleCardGrid');
  const items = grid?.items || [];

  const articles = items
    .filter((it) => it.title && it.action?.payload?.url)
    .slice(0, 60)
    .map((it) => {
      const rawUrl = it.action.payload.url;
      const url = rawUrl.startsWith('/') ? NEWS_BASE + rawUrl : rawUrl;
      return {
        title: it.title,
        url,
        embedUrl: toEmbedUrl(url),
        image: it.media?.url || it.imageMedia?.url || '',
        category: it.category?.title || 'News',
        description: it.description?.body || '',
        summary: '',
        publishedAt: it.publishedAt || it.analytics?.publishDate || null
      };
    });

  // Only fetch full body text for articles actually hosted on playvalorant.com — that's
  // the one source we know exposes real rich-text blades. Esports bulletins (a separate
  // domain) and trailers don't get this second fetch; they keep the short teaser.
  const richCandidates = articles.filter((a) => {
    try { return new URL(a.url).hostname === 'playvalorant.com' && !a.embedUrl.includes('youtube'); }
    catch (e) { return false; }
  });
  const summaries = await Promise.allSettled(richCandidates.map((a) => fetchArticleSummary(a.url)));
  richCandidates.forEach((a, i) => {
    const res = summaries[i];
    if (res.status === 'fulfilled' && res.value) a.summary = res.value;
  });

  return articles;
}

// Riot's news feed links straight to a YouTube watch page for trailers, but YouTube
// blocks watch?v= pages from being iframed — only the /embed/ path is embeddable. Since
// we show the full story in-page (never redirecting the user out), trailer links need
// this rewrite or they'd just show a blank frame.
function toEmbedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.replace('www.', '') === 'youtube.com' && u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
      return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    }
  } catch (e) { /* not a valid URL — fall through to the original */ }
  return url;
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
