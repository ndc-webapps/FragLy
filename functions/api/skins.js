// Public, cached VALORANT weapon skins catalog — real data from valorant-api.com (a
// free, keyless, community-run mirror of Riot's own game data, same kind of source the
// site already uses for rank tier icons and agent art). No auth, no rate-limit risk to
// the player's own Henrik API key.
//
// The raw /v1/weapons response is ~3.5MB (every chroma + every upgrade level, full
// asset paths, etc.) — far more than a skins browser needs. We trim it down to what the
// UI actually renders: per skin, its tier, a display render, up to 4 chroma variants
// (for the color-swatch picker), and — when Riot has one — a real animated preview
// video pulled from their own CDN, not a YouTube search-and-hope.
//
// Cached in the same KV namespace as ads/leaderboard/news (binding: FRAGLY_ADS,
// different key). Skin catalogs only change with major game updates (roughly once an
// act), so a 24h cache is safe and keeps this to one upstream fetch a day regardless of
// traffic.
const WEAPONS_URL = 'https://valorant-api.com/v1/weapons';
const TIERS_URL = 'https://valorant-api.com/v1/contenttiers';
const CACHE_KEY = 'valorant_skins_v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CATEGORY_LABELS = {
  'EEquippableCategory::Sidearm': 'Sidearms',
  'EEquippableCategory::SMG': 'SMGs',
  'EEquippableCategory::Shotgun': 'Shotguns',
  'EEquippableCategory::Rifle': 'Rifles',
  'EEquippableCategory::Sniper': 'Snipers',
  'EEquippableCategory::Heavy': 'Heavy',
  'EEquippableCategory::Melee': 'Melee'
};
const CATEGORY_ORDER = ['Sidearms', 'SMGs', 'Shotguns', 'Rifles', 'Snipers', 'Heavy', 'Melee'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
}

// Prefer the most-upgraded level's video (later levels are the fully animated payoff
// version of a skin) — fall back to any earlier level or chroma that has one.
function bestVideo(skin) {
  const levels = skin.levels || [];
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i]?.streamedVideo) return levels[i].streamedVideo;
  }
  const chromaHit = (skin.chromas || []).find((c) => c.streamedVideo);
  return chromaHit ? chromaHit.streamedVideo : null;
}

function bestRender(skin) {
  const chromaWithRender = (skin.chromas || []).find((c) => c.fullRender);
  if (chromaWithRender) return chromaWithRender.fullRender;
  const levelWithIcon = (skin.levels || []).find((l) => l.displayIcon);
  return levelWithIcon ? levelWithIcon.displayIcon : skin.displayIcon || '';
}

function trimChromas(skin) {
  return (skin.chromas || [])
    .filter((c) => c.fullRender || c.swatch)
    .slice(0, 6)
    .map((c) => ({
      name: (c.displayName || '').replace(skin.displayName, '').replace(/[()\r\n]/g, ' ').trim() || 'Standard',
      render: c.fullRender || '',
      swatch: c.swatch || '',
      video: c.streamedVideo || ''
    }));
}

async function fetchCatalog() {
  const [weaponsRes, tiersRes] = await Promise.all([
    fetch(WEAPONS_URL),
    fetch(TIERS_URL)
  ]);
  if (!weaponsRes.ok) throw new Error('weapons upstream ' + weaponsRes.status);
  if (!tiersRes.ok) throw new Error('contenttiers upstream ' + tiersRes.status);
  const weaponsData = await weaponsRes.json();
  const tiersData = await tiersRes.json();

  const tierByUuid = {};
  (tiersData.data || []).forEach((t) => {
    tierByUuid[t.uuid] = { name: t.devName, rank: t.rank, icon: t.displayIcon };
  });

  const weapons = (weaponsData.data || [])
    .filter((w) => w.category && w.skins?.length)
    .map((w) => {
      const category = CATEGORY_LABELS[w.category] || 'Other';
      const skins = w.skins
        .filter((s) => s.displayName && !/^Standard /.test(s.displayName) && s.displayName !== w.displayName)
        .map((s) => {
          const tier = tierByUuid[s.contentTierUuid] || { name: 'Standard', rank: -1, icon: '' };
          return {
            id: s.uuid,
            name: s.displayName.replace(/\r?\n/g, ' ').trim(),
            tier: tier.name,
            tierRank: tier.rank,
            tierIcon: tier.icon,
            icon: s.displayIcon || '',
            render: bestRender(s),
            video: bestVideo(s),
            chromas: trimChromas(s)
          };
        })
        .sort((a, b) => b.tierRank - a.tierRank || a.name.localeCompare(b.name));
      return {
        id: w.uuid,
        name: w.displayName,
        category,
        icon: w.displayIcon || '',
        skins
      };
    })
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));

  return weapons;
}

// The full catalog (weapons + every skin, trimmed) is ~1.2MB — fine to hold in KV for a
// day, but too heavy to hand a mobile visitor in one shot just to render 20 weapon tabs.
// So the HTTP response is split: no ?weapon= param returns a light weapon list (just
// enough to build tabs), and ?weapon=<id> returns that one weapon's skins. Both read
// from the same cached full catalog — only one upstream fetch either way.
async function getCatalog(env) {
  if (env.FRAGLY_ADS) {
    try {
      const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached.cachedAt && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
          return cached.payload.weapons;
        }
      }
    } catch (e) { /* corrupt/missing cache — fall through to a fresh fetch */ }
  }

  try {
    const weapons = await fetchCatalog();
    if (!weapons.length) throw new Error('no weapons parsed');
    if (env.FRAGLY_ADS) {
      await env.FRAGLY_ADS.put(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), payload: { weapons } }));
    }
    return weapons;
  } catch (e) {
    if (env.FRAGLY_ADS) {
      try {
        const raw = await env.FRAGLY_ADS.get(CACHE_KEY);
        if (raw) return JSON.parse(raw).payload.weapons;
      } catch (e2) { /* no usable cache either */ }
    }
    throw e;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const weaponId = url.searchParams.get('weapon');

  try {
    const weapons = await getCatalog(env);
    if (weaponId) {
      const w = weapons.find((x) => x.id === weaponId);
      if (!w) return json({ error: 'Unknown weapon' }, 404);
      return json({ weapon: w, updatedAt: Date.now() });
    }
    const list = weapons.map((w) => ({ id: w.id, name: w.name, category: w.category, icon: w.icon, skinCount: w.skins.length }));
    return json({ weapons: list, updatedAt: Date.now() });
  } catch (e) {
    return json({ error: 'Skins catalog unavailable' }, 502);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return onRequestGet(context);
}
