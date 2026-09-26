import { HttpError } from '../model.js';

export const CDRAGON_BASE = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';
const FETCH_TIMEOUT_MS = 8000;
const REFRESH_MS = 24 * 3600 * 1000; // cdragon "latest" carries no version string to key on

const FILES = Object.freeze({
  augments: 'v1/cherry-augments.json',
  items: 'v1/items.json',
  spells: 'v1/summoner-spells.json',
  champions: 'v1/champion-summary.json',
});

const ICON_PREFIX = '/lol-game-data/assets/';
const RARITIES = Object.freeze({ kPrismatic: 'prismatic', kGold: 'gold', kSilver: 'silver' });

// e.g. "/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/MysticPunch_small.png"
//   -> "https://raw.communitydragon.org/latest/.../default/assets/ux/cherry/augments/icons/mysticpunch_small.png"
export function iconUrl(iconPath) {
  if (!iconPath) return null;
  const rest = iconPath.startsWith(ICON_PREFIX) ? iconPath.slice(ICON_PREFIX.length) : iconPath.replace(/^\//, '');
  return CDRAGON_BASE + rest.toLowerCase();
}

export function rarityOf(rarity) {
  return RARITIES[rarity] ?? 'unknown';
}

export function createCdragonResources({
  fetch = globalThis.fetch,
  cache,
  now = Date.now,
  userAgent = 'aram-mayhem-overlay/0.1 (personal tool)',
} = {}) {
  let memo = null;
  let memoAt = -Infinity;

  async function fetchJson(name) {
    const url = `${CDRAGON_BASE}${name}`;
    const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) throw new HttpError(res.status, url);
    return res.json();
  }

  async function loadOne(name) {
    const key = ['cdragon', name];
    const hit = await cache.get(key);
    if (hit && now() - hit.fetchedAt < REFRESH_MS) return hit.value;
    const data = await fetchJson(name);
    await cache.set(key, data);
    return data;
  }

  async function load() {
    if (memo && now() - memoAt < REFRESH_MS) return memo;
    const [augments, items, spells, champions] = await Promise.all([
      loadOne(FILES.augments),
      loadOne(FILES.items),
      loadOne(FILES.spells),
      loadOne(FILES.champions),
    ]);
    memo = {
      augmentsById: Object.fromEntries(augments.map((a) => [a.id, a])),
      itemsById: Object.fromEntries(items.map((i) => [i.id, i])),
      spellsById: Object.fromEntries(spells.map((s) => [s.id, s])),
      champions,
    };
    memoAt = now();
    return memo;
  }

  return { load };
}
