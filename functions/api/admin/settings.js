// Admin-only read/write of the ad-rotation interval.
// GET  -> { rotationHours }
// PUT  { rotationHours: 1-5 } -> { rotationHours }
import { isAuthed, json } from '../../_lib/auth.js';
import { getRotationHours, setRotationHours, MIN_ROTATION_HOURS, MAX_ROTATION_HOURS } from '../../_lib/settings.js';

export async function onRequestGet(context) {
  const { env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  return json({ rotationHours: await getRotationHours(env) });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  const saved = await setRotationHours(env, body.rotationHours);
  if (saved == null) {
    return json({ error: `rotationHours must be a whole number from ${MIN_ROTATION_HOURS} to ${MAX_ROTATION_HOURS}` }, 400);
  }
  return json({ rotationHours: saved });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'PUT') return onRequestPut(context);
  return json({ error: 'Method not allowed' }, 405);
}
