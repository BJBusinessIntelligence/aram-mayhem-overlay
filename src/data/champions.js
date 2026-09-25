// Champion lookup built from aramkit resources/champions.json ({ "157": { slug, riotId, name, icon } }).
export function createChampionIndex(resource = {}) {
  const list = Object.entries(resource ?? {})
    .map(([id, c]) => ({ id: Number(id), riotId: c?.riotId, name: c?.name ?? c?.riotId, slug: c?.slug ?? '', icon: c?.icon ?? null }))
    .filter((c) => Number.isInteger(c.id) && typeof c.riotId === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
  const byIdMap = new Map(list.map((c) => [c.id, c]));
  const byRiotMap = new Map(list.map((c) => [c.riotId.toLowerCase(), c]));
  return {
    size: list.length,
    byId: (id) => byIdMap.get(Number(id)) ?? null,
    byRiotId: (riotId) => (riotId ? byRiotMap.get(String(riotId).toLowerCase()) ?? null : null),
    search(q, limit = 10) {
      const s = String(q ?? '').trim().toLowerCase();
      if (!s) return [];
      return list
        .filter((c) => c.name.toLowerCase().startsWith(s) || c.riotId.toLowerCase().startsWith(s) || c.slug.startsWith(s))
        .slice(0, limit);
    },
    all: () => list.slice(),
  };
}
