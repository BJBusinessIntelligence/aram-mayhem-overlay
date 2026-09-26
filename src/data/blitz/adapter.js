import { normalizeBlitz } from './normalize.js';

// `cache` is accepted for interface parity with the other adapters (createAramkitAdapter etc.);
// blitz doesn't need it directly: CommunityDragon resource caching lives in cdragon/resources.js,
// and per-champion ChampData caching lives one layer up, in repository.js.
export function createBlitzAdapter({ client, resources, cache, now = Date.now, versionTtlMs = 6 * 3600 * 1000 } = {}) {
  let lastId = null;
  let versionEntry = null;
  let versionAt = -Infinity;
  let versionPromise = null;

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
      return normalizeBlitz({ mayhem, builds }, res, { fetchedAt: now() });
    },
  };
}
