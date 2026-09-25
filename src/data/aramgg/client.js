import { HttpError } from '../model.js';

export const ARAMGG_BASE = 'https://data.dtodo.cn/api/v1/en';

export function createAramggClient({ fetch = globalThis.fetch, apiKey = null, now = Date.now, cooldownMs = 60 * 60 * 1000, base = ARAMGG_BASE } = {}) {
  let cooldownUntil = 0;

  async function fetchJson(p, { auth = true } = {}) {
    if (auth && !apiKey) throw new Error('aramgg: no API key');
    if (auth && now() < cooldownUntil) throw new Error(`aramgg: cooling down after 429 until ${new Date(cooldownUntil).toISOString()}`);
    const headers = { accept: 'application/json' };
    if (auth) headers['x-api-key'] = apiKey;
    const res = await fetch(`${base}${p}`, { headers });
    if (res.status === 429) { cooldownUntil = now() + cooldownMs; throw new HttpError(429, p); }
    if (res.status !== 200) throw new HttpError(res.status, p);
    return res.json();
  }

  return {
    config: () => fetchJson('/config.json', { auth: false }),
    champion: (id) => fetchJson(`/champions/${id}.json`),
    augments: () => fetchJson('/augments.json'),
    items: () => fetchJson('/items.json'),
    spells: () => fetchJson('/summoner-spells.json'),
    isCoolingDown: () => now() < cooldownUntil,
  };
}
