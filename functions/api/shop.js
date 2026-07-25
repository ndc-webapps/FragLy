// Single product catalog — one JSON array in Cloudflare KV (binding: FRAGLY_ADS, key
// "shop_items"). This is now the ONE place admins add an affiliate item: it feeds the
// /shop/ storefront directly (this file) AND the site-wide banner/square ad rotation
// (functions/api/ads.js, which imports loadAll() below and picks 5 at random per slot).
// One add form, one catalog, two places it shows up — no separate ad-only entries.
//
// GET  /api/shop             -> public: { items: [...active items] }
// GET  /api/shop?all=1       -> admin-only: every item (active + inactive), for the manager UI
// POST /api/shop             -> admin-only: create
// PUT  /api/shop?id=xxx      -> admin-only: update (partial)
// DELETE /api/shop?id=xxx    -> admin-only: delete
import { isAuthed, json } from '../_lib/auth.js';

const KV_KEY = 'shop_items';
const CAP = 5000; // sane ceiling on catalog size — KV values allow up to 25MB, plenty of headroom at this size

// ── Optimistic concurrency ────────────────────────────────────────────────────
// Every mutation here is a read-modify-write of ONE KV key, and KV has no
// compare-and-swap. Without a guard, two overlapping admin actions silently clobber
// each other — the realistic case being a bulk operation that runs for minutes while
// someone edits an item in another tab, with the bulk op's stale snapshot winning.
//
// So the stored value carries a version counter: readers get {version, items}, writers
// pass the version they read back to saveAll(), and saveAll() refuses the write if
// anything else bumped it in between (409 Conflict -> the admin UI reloads and retries).
//
// Honest limitation: this narrows the window to the milliseconds between the re-read
// and the put, it does not eliminate it — KV genuinely cannot do atomic CAS. It fixes
// the multi-second/multi-minute overlaps that actually occur here. A Durable Object or
// D1 is the correct fix if this ever needs to be airtight.
//
// Backward compatible on purpose: production currently stores a BARE ARRAY (pre-
// versioning). A bare array is read as version 0 and upgraded to the wrapped shape on
// the next write, so no migration step and no risk to the live catalog.
export async function loadRaw(env) {
  const raw = await env.FRAGLY_ADS.get(KV_KEY);
  if (!raw) return { version: 0, items: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { version: 0, items: parsed }; // legacy bare array
    return {
      version: Number(parsed.version) || 0,
      items: Array.isArray(parsed.items) ? parsed.items : []
    };
  } catch (e) {
    return { version: 0, items: [] };
  }
}

export async function loadAll(env) {
  return (await loadRaw(env)).items;
}

export class ConflictError extends Error {
  constructor() {
    super('Catalog changed since it was read');
    this.name = 'ConflictError';
  }
}

// expectedVersion omitted = unconditional write (kept so any caller that hasn't opted
// into the version check still works). Pass it to get conflict detection.
export async function saveAll(env, items, expectedVersion) {
  let base = expectedVersion;
  if (base === undefined) {
    base = (await loadRaw(env)).version;
  } else {
    const current = await loadRaw(env);
    if (current.version !== base) throw new ConflictError();
  }
  await env.FRAGLY_ADS.put(KV_KEY, JSON.stringify({ version: base + 1, items }));
  return base + 1;
}

// Shared by every mutating handler: same conflict -> 409 mapping, so the admin UI can
// treat it uniformly instead of each endpoint inventing its own error shape.
export function conflictResponse() {
  return json({ error: 'Someone else changed the catalog while you were editing. Reload and try again.', conflict: true }, 409);
}
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) {
    return false;
  }
}
function publicShape(i) {
  return { id: i.id, name: i.name, image: i.image, link: i.link, category: i.category, price: i.price || '', featured: !!i.featured };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.FRAGLY_ADS) {
    return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);
  }
  const items = await loadAll(env);
  const url = new URL(request.url);

  if (url.searchParams.get('all') === '1') {
    if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
    const sorted = items.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json({ items: sorted });
  }

  const active = items.filter((i) => i.active).map(publicShape);
  return json({ items: active }, 200, { 'Cache-Control': 'public, max-age=120' });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const name = String(body.name || '').trim().slice(0, 120);
  const image = String(body.image || '').trim();
  const link = String(body.link || '').trim();
  const category = String(body.category || 'Other').trim().slice(0, 40);
  const price = String(body.price || '').trim().slice(0, 40);
  const featured = !!body.featured;
  if (!name) return json({ error: 'name is required' }, 400);
  if (!isHttpUrl(image)) return json({ error: 'image must be a valid http(s) URL' }, 400);
  if (!isHttpUrl(link)) return json({ error: 'link must be a valid http(s) URL' }, 400);

  const { version, items } = await loadRaw(env);
  if (items.length >= CAP) return json({ error: `Catalog cap reached (${CAP} items) — delete something first.` }, 400);

  const item = {
    id: crypto.randomUUID(),
    name, image, link, category, price, featured,
    active: true,
    createdAt: Date.now()
  };
  items.push(item);
  try {
    await saveAll(env, items, version);
  } catch (e) {
    if (e instanceof ConflictError) return conflictResponse();
    throw e;
  }
  return json({ item }, 201);
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'id query param required' }, 400);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const { version, items } = await loadRaw(env);
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return json({ error: 'Item not found' }, 404);

  const current = items[idx];
  const next = { ...current };

  if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 120);
  if (body.image !== undefined) {
    const img = String(body.image).trim();
    // Empty string is a valid PUT value here — it's how the admin scanner clears a
    // blank/broken image back to "missing" so it re-enters the fetch pipeline. Only
    // non-empty values need to pass URL validation.
    if (img && !isHttpUrl(img)) return json({ error: 'image must be a valid http(s) URL' }, 400);
    next.image = img;
  }
  if (body.link !== undefined) {
    if (!isHttpUrl(String(body.link))) return json({ error: 'link must be a valid http(s) URL' }, 400);
    next.link = String(body.link).trim();
  }
  if (body.category !== undefined) next.category = String(body.category).trim().slice(0, 40) || 'Other';
  if (body.price !== undefined) next.price = String(body.price).trim().slice(0, 40);
  if (body.featured !== undefined) next.featured = !!body.featured;
  if (body.active !== undefined) next.active = !!body.active;

  items[idx] = next;
  try {
    await saveAll(env, items, version);
  } catch (e) {
    if (e instanceof ConflictError) return conflictResponse();
    throw e;
  }
  return json({ item: next });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'id query param required' }, 400);

  const { version, items } = await loadRaw(env);
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return json({ error: 'Item not found' }, 404);

  try {
    await saveAll(env, next, version);
  } catch (e) {
    if (e instanceof ConflictError) return conflictResponse();
    throw e;
  }
  return json({ ok: true });
}

export async function onRequest(context) {
  switch (context.request.method) {
    case 'GET': return onRequestGet(context);
    case 'POST': return onRequestPost(context);
    case 'PUT': return onRequestPut(context);
    case 'DELETE': return onRequestDelete(context);
    default: return json({ error: 'Method not allowed' }, 405);
  }
}
