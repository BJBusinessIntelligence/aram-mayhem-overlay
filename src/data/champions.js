const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function buildIndex(list) {
  const filtered = list
    .filter((c) => Number.isInteger(c.id) && typeof c.riotId === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
  const byIdMap = new Map(filtered.map((c) => [c.id, c]));
  const byRiotMap = new Map(filtered.map((c) => [c.riotId.toLowerCase(), c]));
  return {
    size: filtered.length,
    byId: (id) => byIdMap.get(Number(id)) ?? null,
    byRiotId: (riotId) => (riotId ? byRiotMap.get(String(riotId).toLowerCase()) ?? null : null),
    search(q, limit = 10) {
      const s = String(q ?? '').trim().toLowerCase();
      if (!s) return [];
      return filtered
        .filter((c) => c.name.toLowerCase().startsWith(s) || c.riotId.toLowerCase().startsWith(s) || c.slug.startsWith(s))
        .slice(0, limit);
    },
    all: () => filtered.slice(),
  };
}

// Champion lookup built from aramkit resources/champions.json ({ "157": { slug, riotId, name, icon } }).
export function createChampionIndex(resource = {}) {
  const list = Object.entries(resource ?? {})
    .map(([id, c]) => ({ id: Number(id), riotId: c?.riotId, name: c?.name ?? c?.riotId, slug: c?.slug ?? '', icon: c?.icon ?? null }));
  return buildIndex(list);
}

// Champion lookup built from CommunityDragon's v1/champion-summary.json (array of { id, name, alias, ... }).
// alias is Riot's internal name (riotId), e.g. "MonkeyKing"; id -1 ("None") is skipped.
export function createChampionIndexFromCdragon(summaryArray = []) {
  const list = (summaryArray ?? [])
    .filter((c) => c && c.id !== -1)
    .map((c) => ({ id: c.id, riotId: c.alias, name: c.name ?? c.alias, slug: slugify(c.name ?? c.alias), icon: null }));
  return buildIndex(list);
}
