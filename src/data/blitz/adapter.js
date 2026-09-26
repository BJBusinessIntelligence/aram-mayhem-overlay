import { normalizeBlitz } from './normalize.js';
import { createChampionIndexFromCdragon } from '../champions.js';

// `cache` is accepted for interface parity with the other adapters (createAramkitAdapter etc.);
// blitz doesn't need it directly: CommunityDragon resource caching lives in cdragon/resources.js,
// and per-champion ChampData caching lives one layer up, in repository.js.
export function createBlitzAdapter({ client, resources, cache, now = Date.now, versionTtlMs = 6 * 3600 * 1000 } = {}) {
  let lastId = null;
  let versionEntry = null;
  let versionAt = -Infinity;
  let versionPromise = null;
  let champIndexMemo = null;
  let champIndexFor = null; // the raw champions array the memo was built from (identity check)

  // resources.load() hands back CommunityDragon's raw champion-summary array; build (and cache)
  // the byId/byRiotId index normalizeBlitz expects, same shape createChampionIndex produces.
  function champIndexOf(rawChampions) {
    if (champIndexFor !== rawChampions) {
      champIndexMemo = createChampionIndexFromCdragon(rawChampions);
      champIndexFor = rawChampions;
    }
    return champIndexMemo;
  }

  async function version() {
    if (versionEntry && now() - versionAt < versionTtlMs) return versionEntry;
    if (!versionPromise) {
      versionPromise = client.championMayhem(lastId ?? 157)
        .then((raw) => {
          versionEntry = raw?.data?.[0]?.patch ?? null;
          versionAt = now();
          return versionEntry;
        })
        .finally(() => { versionPromise = null; });
    }
    return versionPromise;
  }

  return {
    name: 'blitz',
    enabled: true,
    supportsBracket: (b) => b === 'all',
    supportsStages: () => false,
    version,
    async champion(id) {
      lastId = id;
      const [mayhem, builds, res] = await Promise.all([client.championMayhem(id), client.builds(id), resources.load()]);
      const withIndex = { ...res, champions: champIndexOf(res.champions) };
      return normalizeBlitz({ mayhem, builds }, withIndex, { fetchedAt: now() });
    },
  };
}
