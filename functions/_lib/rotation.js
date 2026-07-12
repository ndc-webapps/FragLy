// Deterministic time-bucketed random selection — picks a stable-but-rotating subset
// without any cron job or background task. The "randomness" is seeded purely from the
// current wall-clock bucket, so:
//   - every visitor within the same rotation window sees the identical picks (it's not
//     re-randomized per request)
//   - the picks change automatically the instant the clock crosses into the next bucket,
//     computed fresh on whatever request happens to land after that — no scheduled job,
//     no stored "current selection" state, nothing that can drift or fail to run.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// pool: array of ads (already filtered to active+this slot). rotationHours: 1-5.
// bucketKey: e.g. the slot name, so banner and square get independent shuffles even
// when they rotate on the same clock. now: inject Date.now() for testability.
export function pickRotation(pool, bucketKey, rotationHours, displayCount, now) {
  if (!pool.length) return [];
  const periodMs = Math.max(1, rotationHours) * 60 * 60 * 1000;
  const bucket = Math.floor((now == null ? Date.now() : now) / periodMs);
  const rand = mulberry32(hashSeed(bucketKey + ':' + bucket));
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
  }
  return shuffled.slice(0, displayCount);
}
