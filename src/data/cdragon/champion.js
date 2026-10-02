import { HttpError } from '../model.js';
import { CDRAGON_BASE } from './resources.js';

const FETCH_TIMEOUT_MS = 8000;
const REFRESH_MS = 24 * 3600 * 1000;
const DAMAGE = Object.freeze({ kPhysical: 'physical', kMagic: 'magic', kMixed: 'mixed' });
const PLAYSTYLE_KEYS = ['damage', 'durability', 'crowdControl', 'mobility', 'utility'];

export function normalizeCdragonChampion(raw) {
  const t = raw?.tacticalInfo ?? {};
  const p = raw?.playstyleInfo ?? {};
  return {
    id: raw?.id ?? null,
    roles: Array.isArray(raw?.roles) ? raw.roles.slice() : [],
    damageType: DAMAGE[t.damageType] ?? 'mixed',
    attackType: t.attackType === 'ranged' ? 'ranged' : 'melee',
    playstyle: Object.fromEntries(PLAYSTYLE_KEYS.map((k) => [k, typeof p[k] === 'number' ? p[k] : null])),
  };
}

export function createCdragonChampions({ fetch = globalThis.fetch, cache, now = Date.now, log = () => {}, userAgent = 'aram-mayhem-overlay/0.1 (personal tool)' } = {}) {
  const memo = new Map(); // id → { at, value }

  async function fetchJson(id) {
    const url = `${CDRAGON_BASE}v1/champions/${id}.json`;
    const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) throw new HttpError(res.status, url);
    return res.json();
  }

  async function get(id) {
    const m = memo.get(id);
    if (m && now() - m.at < REFRESH_MS) return m.value;
    const key = ['cdragon', 'champions', String(id)];
    const hit = await cache.get(key);
    if (hit && now() - hit.fetchedAt < REFRESH_MS) { memo.set(id, { at: hit.fetchedAt, value: hit.value }); return hit.value; }
    try {
      const value = normalizeCdragonChampion(await fetchJson(id));
      await cache.set(key, value);
      memo.set(id, { at: now(), value });
      return value;
    } catch (e) {
      if (hit) { log(`WARN cdragon champion ${id} refetch failed, serving stale cache: ${e.message}`); return hit.value; }
      throw e;
    }
  }

  return { get };
}
