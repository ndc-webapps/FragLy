// Shop item storage — one JSON array in Cloudflare KV (binding: FRAGLY_ADS, key "shop_items").
// Curated gaming gear with real Shopee affiliate links, managed from /admin. Distinct from
// ads.js's rotating banner/square slots — this is a flat, always-fully-shown catalog with
// client-side search/category filtering, not a rotation.
//
// GET  /api/shop             -> public: { items: [...active items] }
// GET  /api/shop?all=1       -> admin-only: every item (active + inactive), for the manager UI
// POST /api/shop             -> admin-only: create
// PUT  /api/shop?id=xxx      -> admin-only: update (partial)
// DELETE /api/shop?id=xxx    -> admin-only: delete
import { isAuthed, json } from '../_lib/auth.js';

const KV_KEY = 'shop_items';
const CAP = 300; // sane ceiling on catalog size

async function loadAll(env) {
  const raw = await env.FRAGLY_ADS.get(KV_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
async function saveAll(env, items) {
  await env.FRAGLY_ADS.put(KV_KEY, JSON.stringify(items));
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

  const items = await loadAll(env);
  if (items.length >= CAP) return json({ error: `Catalog cap reached (${CAP} items) — delete something first.` }, 400);

  const item = {
    id: crypto.randomUUID(),
    name, image, link, category, price, featured,
    active: true,
    createdAt: Date.now()
  };
  items.push(item);
  await saveAll(env, items);
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

  const items = await loadAll(env);
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return json({ error: 'Item not found' }, 404);

  const current = items[idx];
  const next = { ...current };

  if (body.name !== undefined) next.name = String(body.name).trim().slice(0, 120);
  if (body.image !== undefined) {
    if (!isHttpUrl(String(body.image))) return json({ error: 'image must be a valid http(s) URL' }, 400);
    next.image = String(body.image).trim();
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
  await saveAll(env, items);
  return json({ item: next });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Shop storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'id query param required' }, 400);

  const items = await loadAll(env);
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return json({ error: 'Item not found' }, 404);

  await saveAll(env, next);
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
