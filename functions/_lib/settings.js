// Shared ad-rotation settings, stored as one small JSON blob in the same KV namespace
// as the ads themselves. Not routed (leading underscore) — imported by ads.js (to read
// the interval when picking which ads to show) and api/admin/settings.js (to let the
// admin panel read/write it).

const KV_KEY = 'ads_settings';
const DEFAULT_ROTATION_HOURS = 3;
export const MIN_ROTATION_HOURS = 1;
export const MAX_ROTATION_HOURS = 5;
const DEFAULT_ADS_ENABLED = true;

async function readSettings(env) {
  if (!env.FRAGLY_ADS) return { rotationHours: DEFAULT_ROTATION_HOURS, adsEnabled: DEFAULT_ADS_ENABLED };
  const raw = await env.FRAGLY_ADS.get(KV_KEY);
  if (!raw) return { rotationHours: DEFAULT_ROTATION_HOURS, adsEnabled: DEFAULT_ADS_ENABLED };
  try {
    const parsed = JSON.parse(raw);
    return {
      rotationHours: clamp(Number(parsed.rotationHours)) || DEFAULT_ROTATION_HOURS,
      // Older stored blobs predate this field entirely — treat missing as "on" so
      // existing sites don't silently go dark on deploy.
      adsEnabled: parsed.adsEnabled === undefined ? DEFAULT_ADS_ENABLED : !!parsed.adsEnabled
    };
  } catch (e) {
    return { rotationHours: DEFAULT_ROTATION_HOURS, adsEnabled: DEFAULT_ADS_ENABLED };
  }
}

async function writeSettings(env, patch) {
  const current = await readSettings(env);
  const next = { ...current, ...patch };
  await env.FRAGLY_ADS.put(KV_KEY, JSON.stringify(next));
  return next;
}

export async function getRotationHours(env) {
  return (await readSettings(env)).rotationHours;
}

export async function setRotationHours(env, hours) {
  const n = clamp(Number(hours));
  if (!n) return null;
  const saved = await writeSettings(env, { rotationHours: n });
  return saved.rotationHours;
}

export async function getAdsEnabled(env) {
  return (await readSettings(env)).adsEnabled;
}

export async function setAdsEnabled(env, enabled) {
  const saved = await writeSettings(env, { adsEnabled: !!enabled });
  return saved.adsEnabled;
}

function clamp(n) {
  if (!Number.isInteger(n)) return 0;
  if (n < MIN_ROTATION_HOURS || n > MAX_ROTATION_HOURS) return 0;
  return n;
}
