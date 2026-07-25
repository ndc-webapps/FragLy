// POST /api/admin/linkcheck -> admin-only. Body: { links: [{ id, link }] }
// Returns: { results: [{ id, status: 'live'|'dead'|'unknown', finalUrl, reason }] }
//
// How dead links are detected (verified against the real catalog before building this):
// an s.shopee.ph short link ALWAYS returns HTTP 200, whether it's valid or not — the
// status code tells you nothing. What differs is where it redirects to:
//   live  -> https://shopee.ph/<slug>/<shopId>/<itemId>?...   (a real product page)
//   dead  -> https://shope.ee/error_page                       (Shopee's dead-link page)
// Tested 65 real catalog links (0 false positives) and a fabricated short code
// (correctly flagged dead). So classification is by FINAL URL, not status.
//
// Known limitation, stated honestly: this catches broken/expired short links. A link
// that still resolves to a real product URL but whose product was since delisted cannot
// be verified here — Shopee bot-blocks server-side reads of the product page itself
// (confirmed earlier: direct product URLs return an empty client-rendered shell). Those
// come back 'live'. Anything we cannot positively classify is 'unknown', never 'dead',
// so the checker can't cause you to delete a good product.
import { isAuthed, json } from '../../_lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const PER_LINK_TIMEOUT_MS = 10000;
// Cloudflare caps subrequests per invocation (50 on the free plan). The client chunks to
// stay under it; this is a server-side backstop so a hand-crafted request can't blow past.
const MAX_LINKS = 40;
const CONCURRENCY = 8;

function classify(finalUrl) {
  const u = String(finalUrl || '');
  if (!u) return { status: 'unknown', reason: 'no final URL' };
  if (u.includes('error_page')) return { status: 'dead', reason: 'redirects to Shopee error page' };
  // Match on the parsed HOSTNAME, not the raw URL. Testing a pattern like
  // /(^|\.)shopee\./ against the whole URL silently never matches, because the character
  // before "shopee" in "https://shopee.ph/..." is "/" — that bug would have classified
  // every single live link as "unsure" and made the whole checker useless.
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch (e) {
    return { status: 'unknown', reason: 'unparseable destination' };
  }
  // shopee.ph, www.shopee.ph, shopee.com.my, … — any real Shopee storefront is live.
  if (/(^|\.)shopee\.[a-z.]+$/.test(host)) return { status: 'live', reason: '' };
  return { status: 'unknown', reason: 'unrecognised destination' };
}

async function checkOne(entry) {
  const id = String(entry && entry.id || '');
  const link = String(entry && entry.link || '').trim();
  if (!link) return { id, status: 'unknown', finalUrl: '', reason: 'no link' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_LINK_TIMEOUT_MS);
  try {
    // GET (not HEAD): short-link services frequently don't honour HEAD. We never read
    // the body, so the cost is just the redirect chain.
    const r = await fetch(link, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal
    });
    const finalUrl = r.url || '';
    const c = classify(finalUrl);
    return { id, status: c.status, finalUrl, reason: c.reason };
  } catch (e) {
    // Timeouts/network errors are explicitly NOT 'dead' — a transient blip must never
    // be grounds for deleting a product. Re-runnable as 'unknown'.
    return {
      id, status: 'unknown', finalUrl: '',
      reason: (e && e.name === 'AbortError') ? 'timed out' : ('fetch failed: ' + (e && e.message || 'unknown'))
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestPost(context) {
  const { request } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const links = Array.isArray(body.links) ? body.links.slice(0, MAX_LINKS) : [];
  if (!links.length) return json({ error: 'No links provided' }, 400);

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < links.length) {
      const mine = links[idx++];
      results.push(await checkOne(mine));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, worker));

  return json({ results });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
