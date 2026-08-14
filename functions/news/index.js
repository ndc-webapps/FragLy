// Server-renders the real article list straight into news/index.html before it reaches
// the browser. The static page still fetches /api/news client-side and rebuilds the grid
// itself (unchanged) — this only fills in the initial HTML so crawlers/link previews that
// don't run JS (or give up before the client fetch finishes) see the real Riot articles
// instead of an empty "Loading…" grid.
import { getNewsPayload } from '../_lib/news.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderCards(articles) {
  return articles.map((a) => (
    '<a class="nw-card" href="' + esc(a.url) + '" target="_blank" rel="noopener">'
      + '<div class="nw-thumb-wrap">'
        + (a.image ? '<img class="nw-thumb" src="' + esc(a.image) + '" alt="" loading="lazy">' : '')
        + '<span class="nw-cat-badge">' + esc(a.category) + '</span>'
      + '</div>'
      + '<div class="nw-body">'
        + '<div class="nw-title-txt">' + esc(a.title) + '</div>'
        + (a.description ? '<div class="nw-desc">' + esc(a.description) + '</div>' : '')
        + '<div class="nw-date">' + esc(fmtDate(a.publishedAt)) + '</div>'
      + '</div>'
    + '</a>'
  )).join('');
}

function renderTabs(articles) {
  const counts = {};
  articles.forEach((a) => { counts[a.category] = (counts[a.category] || 0) + 1; });
  const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return '<button class="cat-tab on" data-cat="all">All</button>'
    + order.map((c) => '<button class="cat-tab" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');
}

export async function onRequestGet(context) {
  const staticRes = await context.next();
  try {
    const payload = await getNewsPayload(context.env);
    if (!payload || !payload.articles || !payload.articles.length) return staticRes;

    const html = await staticRes.text();
    const updated = payload.updatedAt
      ? new Date(payload.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';
    const metaText = payload.articles.length + ' articles' + (updated ? (' · Updated ' + updated) : '');

    const out = html
      .replace('<div class="cat-tabs" id="catTabs">\n    <button class="cat-tab" data-cat="all">All</button>\n  </div>',
        '<div class="cat-tabs" id="catTabs">' + renderTabs(payload.articles) + '</div>')
      .replace('<div class="nw-meta" id="nwMeta">Loading…</div>', '<div class="nw-meta" id="nwMeta">' + esc(metaText) + '</div>')
      .replace('<div class="nw-grid" id="nwGrid"></div>', '<div class="nw-grid" id="nwGrid">' + renderCards(payload.articles) + '</div>');

    const headers = new Headers(staticRes.headers);
    headers.delete('content-length');
    return new Response(out, { status: staticRes.status, headers });
  } catch (e) {
    console.error('news SSR: falling back to static page', { message: e && e.message });
    return staticRes;
  }
}
