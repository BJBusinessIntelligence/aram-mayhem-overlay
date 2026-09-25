import { createChampionIndex } from '../champions.js';
import { normalizeAramkit } from './normalize.js';
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
  };
}
