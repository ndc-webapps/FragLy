// Admin-only read/write of ad settings: rotation interval + the master on/off switch.
// GET  -> { rotationHours, adsEnabled }
// PUT  { rotationHours?: 1-5, adsEnabled?: bool } -> { rotationHours, adsEnabled }
import { isAuthed, json } from '../../_lib/auth.js';
import { getRotationHours, setRotationHours, getAdsEnabled, setAdsEnabled, MIN_ROTATION_HOURS, MAX_ROTATION_HOURS } from '../../_lib/settings.js';

export async function onRequestGet(context) {
  const { env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  return json({ rotationHours: await getRotationHours(env), adsEnabled: await getAdsEnabled(env) });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return json({ error: 'Unauthorized' }, 401);
  if (!env.FRAGLY_ADS) return json({ error: 'Ad storage is not configured yet (missing FRAGLY_ADS KV binding).' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }

  if (body.rotationHours !== undefined) {
    const saved = await setRotationHours(env, body.rotationHours);
    if (saved == null) {
      return json({ error: `rotationHours must be a whole number from ${MIN_ROTATION_HOURS} to ${MAX_ROTATION_HOURS}` }, 400);
    }
  }
  if (body.adsEnabled !== undefined) {
    await setAdsEnabled(env, body.adsEnabled);
  }

  return json({ rotationHours: await getRotationHours(env), adsEnabled: await getAdsEnabled(env) });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'PUT') return onRequestPut(context);
  return json({ error: 'Method not allowed' }, 405);
}
