// Shared Valorant news fetch + cache — pulled out of api/news.js so the SSR page
// (news/index.js) and the JSON endpoint (api/news.js) share one implementation and one
// KV cache entry instead of drifting apart.
const NEWS_BASE = 'https://playvalorant.com';
const NEWS_URL = NEWS_BASE + '/en-us/news/';
const CACHE_KEY = 'valorant_news_v1';
const CACHE_TTL_MS = 45 * 60 * 1000;
const SUMMARY_MAX_CHARS = 900;
const SUMMARY_FETCH_TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (compatible; FraglyBot/1.0)';

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
    return null;
  }
}

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

async function fetchArticlesFresh() {
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

// Cache-aware fetch shared by the JSON endpoint and the SSR page. Returns
// { articles, updatedAt } or null if nothing usable (fresh or cached) is available.
export async function getNewsPayload(env) {
  if (env.FRAGLY_ADS) {
    try {
      const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.payload;
        }
      }
    } catch (e) { /* corrupt/missing cache — fall through to a fresh fetch */ }
  }

  try {
    const articles = await fetchArticlesFresh();
    if (!articles.length) throw new Error('no articles parsed');
    const payload = { articles, updatedAt: Date.now() };
    if (env.FRAGLY_ADS) {
      await env.FRAGLY_ADS.put(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), payload }));
    }
    return payload;
  } catch (e) {
    console.error('news: fetchArticles failed', { message: e && e.message });
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
        if (raw) return JSON.parse(raw).payload;
      } catch (e2) { /* no usable cache either */ }
    }
    return null;
  }
}
