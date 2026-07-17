// GET /api/admin/imgsearch?q=<query> -> { image, source } | { image: '' }
// Admin-only. Server-side Bing Images scrape (no CORS from the browser, and a datacenter
// egress IP that Bing tolerates better than Google). Returns the top PHOTO result's
// Bing-hosted thumbnail (ts*.mm.bing.net / th.bing.com — stable, hotlinkable, won't rot
// like arbitrary third-party source URLs would).
//
// Why scrape Bing instead of a CC image API (Openverse): CC corpora aren't product
// catalogs — "computer mouse" there returns photos of live animals. Bing actually
// indexes real e-commerce product shots, so a brand+model query ("Logitech G402")
// returns the real product. Niche brands with no web image footprint (e.g. RAKK KAPTAN)
// return nothing usable — this returns image:'' for those on purpose, so the caller
// leaves them blank (clean placeholder) rather than storing an irrelevant photo.
import { isAuthed, json } from '../../_lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decodeEntities(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
}

// A result sourced from one of these retail / product-catalog / manufacturer domains is
// almost always a real product photo. Restricting to these is the precision lever: it's
// far better to leave niche items blank (clean placeholder) than to fill them with the
// blog headers / Canva graphics / random junk that Bing's top result often is when it
// has no real product match for an obscure brand.
const PRODUCT_DOMAINS = [
  'media-amazon', 'ssl-images-amazon', 'amazon.', 'lazada', 'slatic', 'shopee', 'susercontent',
  'aliexpress', 'alicdn', 'ebayimg', 'walmart', 'bestbuy', 'target.com', 'newegg', 'bhphoto',
  'bhphotovideo', 'gamestop', 'rtings', 'imimg', 'made-in-china', 'banggood', 'shopify',
  'flipkart', 'digitecgalaxy', 'techinn', 'datablitz', 'pcexpress', 'dynaquestpc', 'villman',
  'logitech', 'razer', 'corsair', 'hyperx', 'steelseries', 'glorious', 'keychron', 'asus',
  'msi.com', 'gigabyte', 'akko', 'redragon', 'cdn.shopify', 'cloudfront'
];
function isProductSource(murl) {
  const u = (murl || '').toLowerCase();
  for (let i = 0; i < PRODUCT_DOMAINS.length; i++) if (u.indexOf(PRODUCT_DOMAINS[i]) !== -1) return true;
  return false;
}

// Pull result objects out of Bing's HTML. Each result is an <a class="iusc"> with an
// m="{...json...}" attribute (HTML-entity-encoded) containing murl (full media url) and
// turl (Bing's own thumbnail url — stable, hotlinkable, what we ultimately store).
function parseBing(html) {
  const out = [];
  const re = /m="(\{[^"]*?\})"/g;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 30) {
    try {
      const o = JSON.parse(decodeEntities(m[1]));
      if (o && (o.turl || o.murl)) out.push({ turl: o.turl || '', murl: o.murl || '' });
    } catch (e) { /* skip malformed */ }
  }
  return out;
}

// Pick the best result: single-image (OIP) thumbnails only (skip OIF collages), and only
// from a recognized product domain. Returns null if nothing qualifies -> caller leaves blank.
function pickBest(results) {
  const singles = results.filter((r) => r.turl && r.turl.indexOf('id=OIP') !== -1);
  const pool = singles.length ? singles : results;
  const good = pool.find((r) => isProductSource(r.murl));
  return good || null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ error: 'q required' }, 400);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    // adlt=strict = SafeSearch; filterui:photo-photo = real photos only (skips clipart/line art)
    const bingUrl = 'https://www.bing.com/images/search?q=' + encodeURIComponent(q) +
      '&adlt=strict&qft=+filterui:photo-photo&first=1';
    const r = await fetch(bingUrl, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) return json({ image: '', reason: 'bing http ' + r.status });

    const html = (await r.text()).slice(0, 900000);
    const results = parseBing(html);
    if (!results.length) return json({ image: '', reason: 'no results' });

    const best = pickBest(results);
    if (!best) return json({ image: '', reason: 'no product-domain match', count: results.length });
    // Store Bing's own thumbnail (ts*.mm.bing.net) — stable + hotlinkable; won't rot like
    // the arbitrary third-party source URL would.
    return json({ image: best.turl || best.murl, source: best.murl || '', count: results.length });
  } catch (e) {
    return json({ image: '', reason: 'fetch failed: ' + (e && e.message || 'unknown') });
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
