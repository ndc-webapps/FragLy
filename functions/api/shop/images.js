// POST /api/shop/images -> admin-only BULK image update in a single KV write.
// Body: { updates: [{ id, image }, ...] }
//
// Why this exists: the admin image-import used to fire one PUT /api/shop?id=X per item,
// and every PUT does a full loadAll()+saveAll() of the entire shop_items array. Cloudflare
// KV only allows ~1 write per second to the same key, so firing 186 rapid writes at the
// single "shop_items" key made almost all of them fail (0 updated, 186 errors). This does
// ONE read + ONE write for the whole batch instead — atomic, fast, no rate-limit wall.
import { isAuthed, json } from '../../_lib/auth.js';
import { loadAll, saveAll } from '../shop.js';

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return json({ error: 'No updates provided' }, 400);

  const items = await loadAll(env);
  const byId = new Map(items.map((it) => [it.id, it]));

  // Empty image is a valid value here — it's how the blank-image scanner clears a
  // bad/blank image back to "missing" so it re-enters the fetch pipeline. Non-empty
  // must be a real URL.
  let updated = 0, notFound = 0, invalid = 0;
  for (const u of updates) {
    const id = String(u && u.id || '').trim();
    const image = String(u && u.image || '').trim();
    if (!id || (image && !isHttpUrl(image))) { invalid++; continue; }
    const item = byId.get(id);
    if (!item) { notFound++; continue; }
    item.image = image;
    updated++;
  }

  // Single write for the whole batch — this is the entire point of the endpoint.
  if (updated > 0) await saveAll(env, items);
  return json({ updated, notFound, invalid });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
