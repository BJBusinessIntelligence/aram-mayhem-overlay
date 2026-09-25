import { NormalizeError, STAGES } from '../model.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const byPickDesc = (a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0);

export function normalizeAramkit(raw, resources, meta) {
  const { champions = {}, augments = {}, items = {}, spells = {}, archetypes = {} } = resources ?? {};
  const iconBase = meta?.iconBase ?? 'https://data.aramkit.com/';
  const icon = (p) => (p ? iconBase + p : null);

  const champRaw = raw?.champion;
  if (!champRaw || !Number.isInteger(champRaw.id)) throw new NormalizeError('aramkit: champion.id missing');
  const allRaw = raw?.augments?.all;
  if (!Array.isArray(allRaw) || allRaw.length === 0) throw new NormalizeError('aramkit: augments.all empty', { championId: champRaw.id });

  const champRes = champions[champRaw.id] ?? {};
  const stat = (s) => ({ winRate: num(s?.winRate), pickRate: num(s?.pickRate), games: s?.sampleCount ?? 0 });
  const item = (ref) => {
    const id = ref?.id;
    const r = items[id];
    return { id, name: r?.name ?? `#${id}`, icon: icon(r?.icon) };
  };
  const augRow = (a) => {
    const r = augments[a.id];
    return {
      id: a.id, name: r?.name ?? `#${a.id}`, rarity: r?.rarity ?? 'unknown',
      tier: a.tier ?? null, rank: a.rank ?? null,
      winRate: num(a.winRate), pickRate: num(a.pickRate), games: a.sampleCount ?? 0,
      globalWinRate: num(a.augmentWinRate), icon: icon(r?.icon),
    };
  };

  const stages = {};
  for (const s of STAGES) stages[s] = (raw.augments.stages?.[s] ?? []).map(augRow);

  const archetypeRows = [];
  for (const a of raw.builds?.filtered?.archetypes ?? []) {
    const route = a.profiles?.[0]?.routes?.[0];
    if (!route || !Array.isArray(route.purchaseOrder)) continue;
    archetypeRows.push({
      key: a.key,
      name: archetypes[a.key]?.name ?? a.key,
      winRate: num(a.winRate), pickRate: num(a.pickRate), games: a.sampleCount ?? 0,
      core: route.purchaseOrder.map(item),
      starters: (route.starters ?? []).map((s) => ({ items: (s.items ?? []).map(item), ...stat(s) })).sort(byPickDesc),
      boots: (route.boots ?? []).filter((b) => b.item && b.item.id).map((b) => ({ item: item(b.item), ...stat(b) })).sort(byPickDesc),
      later: (route.laterItems ?? []).slice().sort(byPickDesc).slice(0, 6).map((l) => ({ item: item(l.item), ...stat(l) })),
      routeWinRate: num(route.winRate), routePickRate: num(route.pickRate), routeGames: route.sampleCount ?? 0,
    });
  }

  return {
    source: 'aramkit',
    sourceVersion: meta.version,
    dataDate: meta.dataDate ?? null,
    fetchedAt: meta.fetchedAt,
    bracket: meta.bracket,
    champion: {
      id: champRaw.id,
      riotId: champRes.riotId ?? null,
      name: champRes.name ?? `#${champRaw.id}`,
      tier: champRaw.tier ?? null,
      rank: champRaw.rank ?? null,
      winRate: num(champRaw.stats?.winRate),
      pickRate: num(champRaw.stats?.pickRate),
      games: champRaw.stats?.sampleCount ?? 0,
      icon: icon(champRes.icon),
    },
    augments: { all: allRaw.map(augRow), stages },
    build: { archetypes: archetypeRows },
    summoners: (raw.summoners ?? []).map((s) => {
      const ids = (s.spells ?? []).map((x) => x.id);
      return { spellIds: ids, names: ids.map((id) => spells[id]?.name ?? `#${id}`), ...stat(s) };
    }),
    skills: (raw.skills ?? []).map((s) => ({ order: s.order, ...stat(s) })),
  };
}
