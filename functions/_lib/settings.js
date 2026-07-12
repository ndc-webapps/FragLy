// Shared ad-rotation settings, stored as one small JSON blob in the same KV namespace
// as the ads themselves. Not routed (leading underscore) — imported by ads.js (to read
// the interval when picking which ads to show) and api/admin/settings.js (to let the
// admin panel read/write it).

const KV_KEY = 'ads_settings';
const DEFAULT_ROTATION_HOURS = 3;
export const MIN_ROTATION_HOURS = 1;
export const MAX_ROTATION_HOURS = 5;

export async function getRotationHours(env) {
  if (!env.FRAGLY_ADS) return DEFAULT_ROTATION_HOURS;
  const raw = await env.FRAGLY_ADS.get(KV_KEY);
  if (!raw) return DEFAULT_ROTATION_HOURS;
  try {
    const n = Number(JSON.parse(raw).rotationHours);
    return clamp(n) || DEFAULT_ROTATION_HOURS;
  } catch (e) {
    return DEFAULT_ROTATION_HOURS;
  }
}

export async function setRotationHours(env, hours) {
  const n = clamp(Number(hours));
  if (!n) return null;
  await env.FRAGLY_ADS.put(KV_KEY, JSON.stringify({ rotationHours: n }));
  return n;
}

function clamp(n) {
  if (!Number.isInteger(n)) return 0;
  if (n < MIN_ROTATION_HOURS || n > MAX_ROTATION_HOURS) return 0;
  return n;
}
