// Server-renders the real NA leaderboard rows straight into leaderboard/index.html
// before it reaches the browser. The static page still fetches /api/leaderboard
// client-side and rebuilds the table itself (unchanged, and switches region on tab
// click) — this only fills in the initial HTML so crawlers see real ranked players
// instead of an empty "Loading…" table.
import { getLeaderboardPayload } from '../_lib/leaderboard.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const TIER_UUID = '03621f52-342b-cf4e-4f86-9350a49c6d04';
function tierIcon(t) { return t ? 'https://media.valorant-api.com/competitivetiers/' + TIER_UUID + '/' + t + '/smallicon.png' : ''; }
function rankClass(rank) { if (rank === 1) return 'top1'; if (rank === 2) return 'top2'; if (rank === 3) return 'top3'; return ''; }

function renderRows(players, region) {
  return players.map((p) => {
    const riotId = encodeURIComponent(p.name + '#' + p.tag);
    return '<a class="lb-row" href="/?player=' + riotId + '&region=' + region + '">'
      + '<span class="lb-rank ' + rankClass(p.rank) + '">' + esc(p.rank) + '</span>'
      + '<img class="lb-tier-icon" src="' + tierIcon(p.tier) + '" alt="" loading="lazy">'
      + '<span class="lb-name">' + esc(p.name) + '<span class="lb-tag">#' + esc(p.tag) + '</span></span>'
      + '<span class="lb-rr">' + esc(p.rr) + '</span>'
      + '<span class="lb-wins">' + esc(p.wins) + 'W</span>'
      + '<span class="lb-arrow">→</span>'
    + '</a>';
  }).join('');
}

export async function onRequestGet(context) {
  const staticRes = await context.next();
  try {
    const payload = await getLeaderboardPayload(context.env, 'na');
    if (!payload || !payload.players || !payload.players.length) return staticRes;

    const html = await staticRes.text();
    const updated = payload.updatedAt
      ? new Date(payload.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '';
    const metaText = 'Top ' + payload.players.length + ' · NA' + (updated ? (' · Updated ' + updated) : '');

    const out = html
      .replace('<div class="lb-meta" id="lbMeta">Loading…</div>', '<div class="lb-meta" id="lbMeta">' + esc(metaText) + '</div>')
      .replace('<div id="lbBody"></div>', '<div id="lbBody">' + renderRows(payload.players, 'na') + '</div>');

    const headers = new Headers(staticRes.headers);
    headers.delete('content-length');
    return new Response(out, { status: staticRes.status, headers });
  } catch (e) {
    console.error('leaderboard SSR: falling back to static page', { message: e && e.message });
    return staticRes;
  }
}
