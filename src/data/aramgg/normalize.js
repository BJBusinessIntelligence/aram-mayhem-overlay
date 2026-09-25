import { NormalizeError } from '../model.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rarityOf = (v) => {
  const s = String(v ?? '').toLowerCase();
  return ['prismatic', 'gold', 'silver'].find((r) => s.includes(r)) ?? 'unknown';
};
const keyOf = (label, i) => (label ? String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_') : `build_${i + 1}`);

function itemOf(ref, itemsById) {
  const id = Number(ref?.id ?? ref?.itemId ?? ref);
  const r = itemsById[id];
  return { id, name: ref?.name ?? r?.name ?? `#${id}`, icon: ref?.iconUrl ?? r?.iconUrl ?? null };
}

export function normalizeAramgg(envelope, resources, meta) {
  const d = envelope?.data ?? envelope ?? {};
  const champ = d.champion ?? d;
  const id = Number(champ?.id ?? champ?.championId ?? meta?.championId);
  if (!Number.isInteger(id)) throw new NormalizeError('aramgg: champion id missing');
  const augmentsById = resources?.augmentsById ?? {};
  const itemsById = resources?.itemsById ?? {};

  const augList = Array.isArray(d.augments) ? d.augments : [];
  if (augList.length === 0) throw new NormalizeError('aramgg: augments empty', { championId: id });
  const all = augList
    .map((a) => {
      const aid = Number(a.id ?? a.augmentId);
      const known = augmentsById[aid] ?? {};
      const st = a.stats ?? a;
      return {
        id: aid,
        name: a.name ?? known.name ?? `#${aid}`,
        rarity: rarityOf(a.rarity ?? known.rarity),
        tier: null,
        rank: num(st.rank),
        winRate: num(st.winRate),
        pickRate: num(st.pickRate),
        games: st.games ?? 0,
        globalWinRate: num(known.stats?.winRate),
        icon: a.iconUrl ?? known.iconUrl ?? null,
      };
    })
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  const builds = Array.isArray(d.builds) ? d.builds : d.build ? [d.build] : [];
  const archetypes = builds.map((b, i) => ({
    key: keyOf(b.label, i),
    name: b.label ?? `Build ${i + 1}`,
    winRate: num(b.winRate), pickRate: num(b.pickRate), games: b.games ?? 0,
    core: (b.coreItems ?? []).map((x) => itemOf(x, itemsById)),
    starters: b.startingItems?.length ? [{ items: b.startingItems.map((x) => itemOf(x, itemsById)), winRate: num(b.winRate), pickRate: num(b.pickRate), games: b.games ?? 0 }] : [],
    boots: [],
    later: (b.situationalItems ?? []).slice(0, 6).map((x) => ({ item: itemOf(x, itemsById), winRate: num(x.winRate), pickRate: num(x.pickRate), games: x.games ?? 0 })),
    routeWinRate: num(b.winRate), routePickRate: num(b.pickRate), routeGames: b.games ?? 0,
  }));

  const b0 = builds[0] ?? {};
  const stats = champ.stats ?? {};
  return {
    source: 'aramgg',
    sourceVersion: meta.version,
    dataDate: meta.dataDate ?? null,
    fetchedAt: meta.fetchedAt,
    bracket: 'all',
    champion: {
      id,
      riotId: meta.riotId ?? null,
      name: champ.name ?? meta.name ?? `#${id}`,
      tier: champ.tier ?? null,
      rank: num(stats.rank ?? champ.rank),
      winRate: num(stats.winRate ?? champ.winRate),
      pickRate: num(stats.pickRate ?? champ.pickRate),
      games: stats.games ?? champ.games ?? 0,
      icon: champ.iconUrl ?? null,
    },
    augments: { all, stages: {} },
    build: { archetypes },
    summoners: (b0.summonerSpells ?? []).map((s) => ({
      spellIds: s.summonerSpellIds ?? (s.spells ?? []).map((x) => x.id),
      names: (s.spells ?? []).map((x) => x.name),
      winRate: num(s.winRate), pickRate: num(s.pickRate), games: s.games ?? 0,
    })),
    skills: (b0.skillOrders ?? []).map((s) => ({ order: (s.skillKeys ?? []).join('>'), winRate: num(s.winRate), pickRate: num(s.pickRate), games: s.games ?? 0 })),
  };
}
