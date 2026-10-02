import { createChampionIndex } from '../champions.js';
import { normalizeAramkit, combatFromAverages } from './normalize.js';
import { ARAMKIT_BASE } from './client.js';

// ChampData resource field → aramkit resource file name
const RESOURCE_FIELDS = Object.freeze({
  champions: 'champions',
  augments: 'augments',
  items: 'items',
  spells: 'summoner-spells',
  archetypes: 'archetypes',
});

export function createAramkitAdapter({ client, cache, now = Date.now, versionTtlMs = 6 * 3600 * 1000 }) {
  let entry = null;
  let entryAt = -Infinity;
  let entryPromise = null;
  let resourcesMemo = null; // { resourcePath, data }

  function versionEntry() {
    if (entry && now() - entryAt < versionTtlMs) return Promise.resolve(entry);
    if (!entryPromise) {
      entryPromise = client.latestVersion()
        .then((e) => { entry = e; entryAt = now(); return e; })
        .finally(() => { entryPromise = null; });
    }
    return entryPromise;
  }

  async function resources() {
    const e = await versionEntry();
    if (resourcesMemo && resourcesMemo.resourcePath === e.resourcePath) return resourcesMemo.data;
    const data = {};
    for (const [field, name] of Object.entries(RESOURCE_FIELDS)) {
      const key = ['aramkit', 'resources', name];
      const hit = await cache.get(key);
      if (hit && hit.value && hit.value.resourcePath === e.resourcePath) { data[field] = hit.value.data; continue; }
      const fetched = await client.resource(name, e);
      await cache.set(key, { resourcePath: e.resourcePath, data: fetched });
      data[field] = fetched;
    }
    resourcesMemo = { resourcePath: e.resourcePath, data };
    return data;
  }

  // Version-keyed single-file caches (rankings, averages): one fetch per data version per bracket.
  const fileMemo = new Map(); // key → { version, data }
  async function versionedFile(name, bracket, fetcher, shape) {
    const e = await versionEntry();
    const key = ['aramkit', bracket, name];
    const memo = fileMemo.get(key.join('/'));
    if (memo && memo.version === e.version) return memo.data;
    const hit = await cache.get(key);
    if (hit && hit.value && hit.value.version === e.version) { fileMemo.set(key.join('/'), hit.value); return hit.value.data; }
    const raw = await fetcher(bracket, e);
    const data = shape(raw, e.version);
    await cache.set(key, { version: e.version, data });
    fileMemo.set(key.join('/'), { version: e.version, data });
    return data;
  }

  return {
    name: 'aramkit',
    enabled: true,
    supportsBracket: (b) => b === 'all' || b === 'high',
    supportsStages: () => true,
    version: async () => (await versionEntry()).version,
    versionEntry,
    resources,
    async champion(id, bracket) {
      const e = await versionEntry();
      const [raw, res] = await Promise.all([client.champion(id, bracket, e), resources()]);
      return normalizeAramkit(raw, res, {
        version: e.version, dataDate: e.dataDate ?? null, bracket, fetchedAt: now(), iconBase: `${ARAMKIT_BASE}/`,
      });
    },
    async championIndex() {
      return createChampionIndex((await resources()).champions);
    },
    rankings: (bracket = 'all') => versionedFile('champion-rankings', bracket, client.rankings, (raw, version) => ({
      version,
      byId: Object.fromEntries((raw?.rows ?? []).filter((r) => r && Number.isInteger(r.id)).map((r) => [r.id, {
        id: r.id, rank: r.rank ?? null, tier: r.tier ?? null, winRate: r.winRate ?? null, pickRate: r.pickRate ?? null, games: r.sampleCount ?? 0,
      }])),
    })),
    averages: (bracket = 'all') => versionedFile('champion-performance-averages', bracket, client.averages, (raw, version) => ({
      version, combat: combatFromAverages(raw?.averages),
    })),
  };
}
