// Ad storage — one JSON array in Cloudflare KV (binding: FRAGLY_ADS), two slots
// ("banner", "square"), max 5 ACTIVE ads per slot so the on-site carousel never
// grows past what the fixed-size containers were designed for.
//
// GET  /api/ads            -> public: { banner: [...active], square: [...active] }
// GET  /api/ads?all=1      -> admin-only: every ad (active + inactive), for the manager UI
// POST /api/ads            -> admin-only: create
// PUT  /api/ads?id=xxx     -> admin-only: update (partial)
// DELETE /api/ads?id=xxx   -> admin-only: delete
import { isAuthed, json } from '../_lib/auth.js';

const KV_KEY = 'ads';
const SLOTS = ['banner', 'square'];
const MAX_PER_SLOT = 5;

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
async function saveAll(env, ads) {
  await env.FRAGLY_ADS.put(KV_KEY, JSON.stringify(ads));
}
function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) {
    return false;
  }
}
function publicShape(a) {
  return { id: a.id, slot: a.slot, imageUrl: a.imageUrl, link: a.link, title: a.title || '' };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.FRAGLY_ADS) {
    return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);
  }
  const ads = await loadAll(env);
  const url = new URL(request.url);

  if (url.searchParams.get('all') === '1') {
    if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
    const sorted = ads.slice().sort((a, b) => (a.slot === b.slot ? a.order - b.order : a.slot.localeCompare(b.slot)));
    return json({ ads: sorted });
  }

  const out = {};
  SLOTS.forEach((slot) => {
    out[slot] = ads
      .filter((a) => a.slot === slot && a.active)
      .sort((a, b) => a.order - b.order)
      .map(publicShape);
  });
  return json(out, 200, { 'Cache-Control': 'public, max-age=60' });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const slot = String(body.slot || '');
  const imageUrl = String(body.imageUrl || '').trim();
  const link = String(body.link || '').trim();
  const title = String(body.title || '').slice(0, 120);
  if (!SLOTS.includes(slot)) return json({ error: 'slot must be "banner" or "square"' }, 400);
  if (!isHttpUrl(imageUrl)) return json({ error: 'imageUrl must be a valid http(s) URL' }, 400);
  if (!isHttpUrl(link)) return json({ error: 'link must be a valid http(s) URL' }, 400);

  const ads = await loadAll(env);
  const activeInSlot = ads.filter((a) => a.slot === slot && a.active).length;
  if (activeInSlot >= MAX_PER_SLOT) {
    return json({ error: `The ${slot} slot already has ${MAX_PER_SLOT} active ads — deactivate or delete one first.` }, 400);
  }

  const maxOrder = ads.filter((a) => a.slot === slot).reduce((m, a) => Math.max(m, a.order || 0), 0);
  const ad = {
    id: crypto.randomUUID(),
    slot, imageUrl, link, title,
    active: true,
    order: maxOrder + 1,
    createdAt: Date.now()
  };
  ads.push(ad);
  await saveAll(env, ads);
  return json({ ad }, 201);
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'id query param required' }, 400);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const ads = await loadAll(env);
  const idx = ads.findIndex((a) => a.id === id);
  if (idx === -1) return json({ error: 'Ad not found' }, 404);

  const current = ads[idx];
  const next = { ...current };

  if (body.imageUrl !== undefined) {
    if (!isHttpUrl(String(body.imageUrl))) return json({ error: 'imageUrl must be a valid http(s) URL' }, 400);
    next.imageUrl = String(body.imageUrl).trim();
  }
  if (body.link !== undefined) {
    if (!isHttpUrl(String(body.link))) return json({ error: 'link must be a valid http(s) URL' }, 400);
    next.link = String(body.link).trim();
  }
  if (body.title !== undefined) next.title = String(body.title).slice(0, 120);
  if (body.order !== undefined) next.order = Number(body.order) || 0;
  if (body.active !== undefined) {
    const wantActive = !!body.active;
    if (wantActive && !current.active) {
      const activeInSlot = ads.filter((a) => a.slot === current.slot && a.active).length;
      if (activeInSlot >= MAX_PER_SLOT) {
        return json({ error: `The ${current.slot} slot already has ${MAX_PER_SLOT} active ads.` }, 400);
      }
    }
    next.active = wantActive;
  }

  ads[idx] = next;
  await saveAll(env, ads);
  return json({ ad: next });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!id) return json({ error: 'id query param required' }, 400);

  const ads = await loadAll(env);
  const next = ads.filter((a) => a.id !== id);
  if (next.length === ads.length) return json({ error: 'Ad not found' }, 404);

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
