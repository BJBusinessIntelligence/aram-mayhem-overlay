import { normalizeAramgg } from './normalize.js';

const RESOURCES = [
  ['augmentsById', 'augments', (c) => c.augments()],
  ['itemsById', 'items', (c) => c.items()],
];

function toList(payload, name) {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.[name])) return d[name];
  return d && typeof d === 'object' ? Object.values(d) : [];
}

export function createAramggAdapter({ client, cache, apiKey, champIndex = null, now = Date.now, versionTtlMs = 6 * 3600 * 1000 }) {
  const enabled = !!apiKey;
  let cfg = null;
  let cfgAt = -Infinity;

  async function config() {
    if (cfg && now() - cfgAt < versionTtlMs) return cfg;
    cfg = await client.config();
    cfgAt = now();
    return cfg;
  }

  async function resources(version) {
    const out = {};
    for (const [field, name, call] of RESOURCES) {
      const key = ['aramgg', 'resources', name];
      const hit = await cache.get(key);
      let list;
      if (hit && hit.value && hit.value.version === version) list = hit.value.data;
      else { list = toList(await call(client), name); await cache.set(key, { version, data: list }); }
      out[field] = Object.fromEntries(list.map((x) => [Number(x.id ?? x.augmentId ?? x.itemId), x]));
    }
    return out;
  }

  return {
    name: 'aramgg',
    enabled,
    supportsBracket: (b) => b === 'all',
    supportsStages: () => false,
    version: async () => (await config()).dataVersion,
    async champion(id) {
      const c = await config();
      const [raw, res] = await Promise.all([client.champion(id), resources(c.dataVersion)]);
      const known = champIndex ? champIndex.byId(id) : null;
      return normalizeAramgg(raw, res, {
        version: c.dataVersion,
        dataDate: typeof c.generatedAt === 'string' ? c.generatedAt.slice(0, 10) : null,
        fetchedAt: now(),
        championId: id,
        riotId: known?.riotId ?? null,
        name: known?.name ?? null,
      });
    },
  };
}
