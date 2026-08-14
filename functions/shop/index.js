// Server-renders the real gear catalog straight into shop/index.html before it reaches
// the browser. The static page still fetches /api/shop client-side and rebuilds the grid
// itself (unchanged, handles search/category filtering) — this only fills in the initial
// HTML so crawlers see real curated items instead of an empty "Loading…" grid.
import { loadAll } from '../api/shop.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderCards(items) {
  const sorted = items.slice().sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  return sorted.map((i) => (
    '<a class="sh-card" href="' + esc(i.link) + '" target="_blank" rel="noopener sponsored nofollow">'
      + '<div class="sh-card-img-wrap">'
        + (i.image ? '<img src="' + esc(i.image) + '" alt="" loading="lazy">' : '<span class="sh-noimg">' + esc((i.category || '?').charAt(0)) + '</span>')
        + (i.featured ? '<span class="sh-featured-badge">Pick of the week</span>' : '')
      + '</div>'
      + '<div class="sh-card-body">'
        + '<span class="sh-cat-lbl">' + esc(i.category) + '</span>'
        + '<div class="sh-card-name">' + esc(i.name) + '</div>'
        + '<div class="sh-card-foot">'
          + (i.price ? '<span class="sh-price">' + esc(i.price) + '</span>' : '<span></span>')
          + '<span class="sh-cta">View →</span>'
        + '</div>'
      + '</div>'
    + '</a>'
  )).join('');
}

function renderTabs(items) {
  const counts = {};
  items.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + 1; });
  const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return '<button class="cat-tab on" data-cat="all">All (' + items.length + ')</button>'
    + order.map((c) => '<button class="cat-tab" data-cat="' + esc(c) + '">' + esc(c) + ' (' + counts[c] + ')</button>').join('');
}

export async function onRequestGet(context) {
  const staticRes = await context.next();
  try {
    if (!context.env.FRAGLY_ADS) return staticRes;
    const all = await loadAll(context.env);
    const items = all.filter((i) => i.active).map((i) => (
      { id: i.id, name: i.name, image: i.image, link: i.link, category: i.category, price: i.price || '', featured: !!i.featured }
    ));
    if (!items.length) return staticRes;

    const html = await staticRes.text();
    const out = html
      .replace('<div class="cat-tabs" id="catTabs">\n    <button class="cat-tab" data-cat="all">All</button>\n  </div>',
        '<div class="cat-tabs" id="catTabs">' + renderTabs(items) + '</div>')
      .replace('<div class="sh-meta" id="shMeta">Loading…</div>', '<div class="sh-meta" id="shMeta">' + esc(items.length + ' item' + (items.length === 1 ? '' : 's')) + '</div>')
      .replace('<div class="sh-grid" id="shGrid"></div>', '<div class="sh-grid" id="shGrid">' + renderCards(items) + '</div>');

    const headers = new Headers(staticRes.headers);
    headers.delete('content-length');
    return new Response(out, { status: staticRes.status, headers });
  } catch (e) {
    console.error('shop SSR: falling back to static page', { message: e && e.message });
    return staticRes;
  }
}
