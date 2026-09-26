import { NormalizeError } from '../model.js';
import { iconUrl, rarityOf } from '../cdragon/resources.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const byPickDesc = (a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0);

// Blitz tier 1 (best) .. 5 (worst) -> the same S/A/B/C/D letters aramkit uses.
const TIER_LETTERS = Object.freeze({ 1: 'S', 2: 'A', 3: 'B', 4: 'C', 5: 'D' });
const tierLetter = (n) => TIER_LETTERS[n] ?? null;

const slug = (s) => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');

// Blitz's 18-level skillOrder uses 1=Q 2=W 3=E 4=R; the max-priority order (the aramkit
// convention, e.g. "Q>E>W", R excluded) is the order in which Q/W/E reach their final point.
const SKILL_LETTERS = Object.freeze({ 1: 'Q', 2: 'W', 3: 'E' });
function deriveSkillOrder(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const order = [1, 2, 3]
    .map((key) => ({ key, last: levels.lastIndexOf(key) }))
    .filter((k) => k.last !== -1)
    .sort((a, b) => a.last - b.last)
    .map((k) => SKILL_LETTERS[k.key]);
  return order.length ? order.join('>') : null;
}

function itemOf(ref, itemsById) {
  const id = Number(ref);
  const r = itemsById[id];
  return { id, name: r?.name ?? `#${id}`, icon: iconUrl(r?.iconPath) ?? null };
}

export function normalizeBlitz({ mayhem, builds } = {}, resources = {}, meta = {}) {
  const entry = mayhem?.data?.[0];
  const champRaw = entry?.data;
  if (!entry || !champRaw) throw new NormalizeError('blitz: champion unknown to Blitz (empty data)');
  const augmentsRaw = champRaw.augments ?? {};
  const augIds = Object.keys(augmentsRaw);
  if (augIds.length === 0) throw new NormalizeError('blitz: augments empty', { championId: entry.champion_id });

  const id = Number(entry.champion_id);
  const { augmentsById = {}, itemsById = {}, spellsById = {}, champions } = resources ?? {};
  const known = champions && typeof champions.byId === 'function' ? champions.byId(id) : null;

  const augRow = (idStr) => {
    const a = augmentsRaw[idStr];
    const aid = Number(idStr);
    const r = augmentsById[aid];
    return {
      id: aid,
      name: r?.nameTRA ?? `#${aid}`,
      rarity: rarityOf(r?.rarity),
      tier: tierLetter(a?.tier),
      rank: a?.tier ?? null,
      winRate: null,
      pickRate: null,
      games: null,
      globalWinRate: null,
      icon: iconUrl(r?.augmentSmallIconPath),
    };
  };

  const buildList = Array.isArray(builds?.data) ? builds.data : [];
  const archetypes = buildList.map((b, i) => {
    const core0 = b.coreItems?.[0];
    const coreIds = typeof core0?.itemIds === 'string' ? core0.itemIds.split(',').filter(Boolean) : [];
    return {
      key: slug(b.name_tags?.[0] ?? `build_${i + 1}`),
      name: `${b.name_tags?.[0] ?? 'Build'} (ARAM)`,
      winRate: num(b.win_rate),
      pickRate: num(b.pick_rate),
      games: b.games ?? null,
      core: coreIds.map((x) => itemOf(x, itemsById)),
      starters: (b.startingItems ?? [])
        .map((s) => ({ items: (s.itemIds ?? []).map((x) => itemOf(x, itemsById)), winRate: num(s.win_rate), pickRate: num(s.pick_rate), games: s.games ?? null }))
        .sort(byPickDesc),
      boots: [],
      later: (b.situationalItems ?? [])
        .slice()
        .sort((x, y) => (y.pick_rate ?? 0) - (x.pick_rate ?? 0))
        .slice(0, 6)
        .map((x) => ({ item: itemOf(x.itemId, itemsById), winRate: num(x.win_rate), pickRate: num(x.pick_rate), games: x.games ?? null })),
      routeWinRate: num(core0?.win_rate),
      routePickRate: num(core0?.pick_rate),
      routeGames: core0?.games ?? null,
    };
  });

  const first = buildList[0];
  const summoners = (first?.summonerSpells ?? []).map((s) => ({
    spellIds: s.summonerSpellIds ?? [],
    names: (s.summonerSpellIds ?? []).map((sid) => spellsById[sid]?.name ?? `#${sid}`),
    winRate: num(s.win_rate),
    pickRate: num(s.pick_rate),
    games: s.games ?? null,
  }));
  const skills = (first?.skillOrders ?? []).map((s) => ({
    order: deriveSkillOrder(s.skillOrder),
    winRate: num(s.win_rate),
    pickRate: num(s.pick_rate),
    games: s.games ?? null,
  }));

  return {
    source: 'blitz',
    sourceVersion: entry.patch ?? null,
    dataDate: entry.dt ?? null,
    fetchedAt: meta?.fetchedAt ?? null,
    bracket: 'all',
    champion: {
      id,
      riotId: known?.riotId ?? null,
      name: known?.name ?? `#${id}`,
      tier: tierLetter(champRaw.tier),
      rank: null,
      winRate: null,
      pickRate: null,
      games: null,
      icon: null,
    },
    augments: { all: augIds.map(augRow), stages: {} },
    build: { archetypes },
    summoners,
    skills,
  };
}
