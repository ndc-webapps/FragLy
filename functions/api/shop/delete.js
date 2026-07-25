// POST /api/shop/delete -> admin-only BULK delete in a single KV write.
// Body: { ids: ["uuid", ...] }
//
// Why this exists: the admin used to delete one item per request, paced ~1.1s apart to
// respect KV's per-key write limit. A 1,000-item selection therefore ran for ~18
// minutes, and during that whole window (a) any other admin edit was silently clobbered
// by the loop's stale snapshot, and (b) a closed tab or dropped connection left the
// catalog half-deleted with no resume and no record of which IDs were done.
// One read + one versioned write removes all three problems.
import { isAuthed, json } from '../../_lib/auth.js';
import { loadRaw, saveAll, ConflictError, conflictResponse } from '../shop.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!ids.length) return json({ error: 'No ids provided' }, 400);

  const { version, items } = await loadRaw(env);
  const wanted = new Set(ids);
  const kept = items.filter((i) => !wanted.has(i.id));
  const deleted = items.length - kept.length;
  // Reported separately so the operator can tell "already gone" from "nothing matched",
  // instead of a blind success count.
  const notFound = ids.length - deleted;

  if (deleted > 0) {
    try {
      await saveAll(env, kept, version);
    } catch (e) {
      if (e instanceof ConflictError) return conflictResponse();
      return json({ error: 'KV write failed: ' + (e && e.message) }, 500);
    }
  }
  return json({ deleted, notFound });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
