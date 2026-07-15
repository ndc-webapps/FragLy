// POST { url } -> { title, image, price? } scraped server-side from that page's
// OG/Twitter meta tags and, when present, schema.org Product/Offer JSON-LD (a lot of
// storefronts embed price there for SEO even when it's not in a plain meta tag).
// Best-effort prefill for the admin form — never required, admin can always type the
// title/image/price in by hand if a site blocks this or has no tags.
//
// Note: Shopee product pages are a pure client-rendered React shell server-side (no
// title, no OG tags, no JSON-LD — confirmed by hand), so price/title/image can't be
// scraped for shopee.ph / s.shopee.ph links no matter what this file does. That's a
// platform limitation, not a bug — the admin form always accepts manual entry.
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

// Formats a bare number + currency code into what the admin form expects
// ("e.g. ₱4,290") — only PHP gets the peso sign since that's the only market FragLy's
// shop targets; anything else falls back to "<code> <amount>" so it's still readable.
function formatPrice(amount, currency) {
  const n = parseFloat(amount);
  if (!isFinite(n) || n <= 0) return '';
  const formatted = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const cur = String(currency || '').toUpperCase();
  if (cur === 'PHP' || cur === '') return '₱' + formatted;
  return cur + ' ' + formatted;
}

// Best-effort schema.org Product/Offer price, since plenty of storefronts only expose
// price there (not in a plain OG meta tag). Scans every <script type="application/ld+json">
// block, tries each as JSON (some embed multiple @graph entries or arrays), and returns
// the first Product/Offer price found.
function extractJsonLdPrice(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const inner = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>[\s\S]*$/i, '');
    let data;
    try { data = JSON.parse(inner); } catch (e) { continue; }
    const found = findOfferPrice(data);
    if (found) return found;
  }
  return null;
}
function findOfferPrice(node, depth) {
  depth = depth || 0;
  if (!node || depth > 4) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOfferPrice(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const offers = node.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    if (offer && (offer.price || offer.lowPrice)) {
      return { amount: offer.price || offer.lowPrice, currency: offer.priceCurrency };
    }
  }
  if (node.price) return { amount: node.price, currency: node.priceCurrency };

  for (const key in node) {
    if (key === 'offers') continue; // already checked above
    const found = findOfferPrice(node[key], depth + 1);
    if (found) return found;
  }
  return null;
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

    const metaAmount = extractMeta(html, 'product:price:amount') || extractMeta(html, 'og:price:amount');
    const metaCurrency = extractMeta(html, 'product:price:currency') || extractMeta(html, 'og:price:currency');
    const jsonLd = metaAmount ? null : extractJsonLdPrice(html);
    const price = metaAmount
      ? formatPrice(metaAmount, metaCurrency)
      : (jsonLd ? formatPrice(jsonLd.amount, jsonLd.currency) : '');

    if (!title && !image) {
      return json({ error: 'No preview data found on that page — enter details manually.' }, 200);
    }
    return json({ title, image, price });
  } catch (e) {
    return json({ error: 'Could not fetch that page — enter details manually.' }, 200);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
