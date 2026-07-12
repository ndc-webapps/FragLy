// POST { url } -> { title, image } scraped server-side from that page's OG/Twitter
// meta tags. Best-effort prefill for the admin form (Shopee product pages are
// server-rendered enough to carry these tags) — never required, admin can always
// type the title/image in by hand if a site blocks this or has no tags.
import { isAuthed, json } from '../../_lib/auth.js';

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return '';
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

export async function onRequestPost(context) {
  const { request } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);

  let targetUrl = '';
  try {
    const body = await request.json();
    targetUrl = String(body.url || '').trim();
  } catch (e) { /* handled by the empty-string checks below */ }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return json({ error: 'Invalid URL' }, 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ error: 'Invalid URL' }, 400);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(parsed.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FragLyAdsBot/1.0; +https://fragly.pages.dev)' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) return json({ error: `That page returned HTTP ${r.status} — enter details manually.` }, 200);

    const html = (await r.text()).slice(0, 400000);
    const title = decodeEntities(extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title'));
    const image = decodeEntities(extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image'));
    if (!title && !image) {
      return json({ error: 'No preview data found on that page — enter details manually.' }, 200);
    }
    return json({ title, image });
  } catch (e) {
    return json({ error: 'Could not fetch that page — enter details manually.' }, 200);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
