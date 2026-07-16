// POST /api/shop/bulk -> admin-only bulk create from CSV import.
// Body: { items: [{ name, link, image?, category?, price?, itemId?, productUrl?, sales?, commission?, shopName? }] }
// Skips dup by itemId or link. Image optional (Shopee CSV has none).
import { isAuthed, json } from '../../_lib/auth.js';
import { loadAll, saveAll } from '../shop.js';

const CAP = 300;

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
  const rows = Array.isArray(body.items) ? body.items : [];
  if (!rows.length) return json({ error: 'No items provided' }, 400);

  const items = await loadAll(env);
  const seenLinks = new Set(items.map((i) => i.link));
  const seenItemIds = new Set(items.map((i) => i.itemId).filter(Boolean));

  let created = 0, skipped = 0, errors = 0;
  for (const row of rows) {
    const name = String(row.name || '').trim().slice(0, 120);
    const link = String(row.link || '').trim();
    const itemId = String(row.itemId || '').trim();
    if (!name || !isHttpUrl(link)) { errors++; continue; }
    if ((itemId && seenItemIds.has(itemId)) || seenLinks.has(link)) { skipped++; continue; }
    if (items.length >= CAP) { errors++; continue; }

    const item = {
      id: crypto.randomUUID(),
      name,
      image: String(row.image || '').trim(),
      link,
      category: String(row.category || 'Other').trim().slice(0, 40),
      price: String(row.price || '').trim().slice(0, 40),
      featured: false,
      active: true,
      createdAt: Date.now()
    };
    if (itemId) item.itemId = itemId;
    if (row.productUrl) item.productUrl = String(row.productUrl).trim();
    if (row.sales != null) item.sales = Number(row.sales) || 0;
    if (row.commission) item.commission = String(row.commission).trim();
    if (row.shopName) item.shopName = String(row.shopName).trim();

    items.push(item);
    seenLinks.add(link);
    if (itemId) seenItemIds.add(itemId);
    created++;
  }

  await saveAll(env, items);
  return json({ created, skipped, errors });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  return onRequestPost(context);
}
