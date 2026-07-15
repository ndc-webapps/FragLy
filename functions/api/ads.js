// Read-only view over the shop catalog (functions/api/shop.js) for the site-wide
// banner/square ad carousels. There is no separate ad pool anymore — every active
// product in /admin feeds both the /shop/ storefront AND this rotation, picked 5 at a
// time per slot by a deterministic time-bucketed shuffle (see _lib/rotation.js) that
// changes on its own every N hours — no cron job, nothing scheduled, just math on each
// request. One admin add form, one catalog, two places it shows up.
//
// GET /api/ads -> public: { banner: [...5 for this rotation], square: [...] }
import { json } from '../_lib/auth.js';
import { pickRotation } from '../_lib/rotation.js';
import { getRotationHours } from '../_lib/settings.js';
import { loadAll } from './shop.js';

const SLOTS = ['banner', 'square'];
const DISPLAY_COUNT = 5; // how many the site actually shows at once, picked from the pool

function publicShape(i) {
  return { id: i.id, imageUrl: i.image, link: i.link, title: i.name || '' };
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.FRAGLY_ADS) {
    return json({ error: 'Product storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);
  }
  const items = await loadAll(env);
  const pool = items.filter((i) => i.active);

  const rotationHours = await getRotationHours(env);
  const out = {};
  SLOTS.forEach((slot) => {
    out[slot] = pickRotation(pool, slot, rotationHours, DISPLAY_COUNT).map(publicShape);
  });
  // Cached briefly at the edge — a rotation boundary might be served up to a minute
  // late in the worst case, which is invisible against an hours-long rotation period.
  return json(out, 200, { 'Cache-Control': 'public, max-age=60' });
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
