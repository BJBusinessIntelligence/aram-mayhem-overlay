import { WEIGHTS } from './weights.js';
import { coverage } from './lineup.js';

// Highest win rate among entries with pickRate >= minPick; if none qualify, among all.
function best(list, minPick) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const qualified = list.filter((x) => (x.pickRate ?? 0) >= minPick);
  const pool = qualified.length ? qualified : list;
  return pool.slice().sort((a, b) => ((b.winRate ?? -1) - (a.winRate ?? -1)) || ((b.games ?? 0) - (a.games ?? 0)))[0];
}

// What each aramkit archetype brings to a composition.
const ARCHETYPE_NEEDS = Object.freeze({
  bruiser: ['frontline'], tank: ['frontline'], juggernaut: ['frontline'],
  ap: ['magic'], burst: ['magic'], crit: ['physical'], ad: ['physical'], on_hit: ['physical'], lethality: ['physical'],
  support: ['peel', 'sustain'], enchanter: ['peel', 'sustain'], utility: ['peel'],
});
const NEED_LABEL = Object.freeze({ frontline: 'frontline', peel: 'peel', sustain: 'sustain', magic: 'magic damage', physical: 'physical damage' });
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function unmetNeeds(allies) {
  const cov = coverage(allies);
  return {
    frontline: 1 - cov.frontline, peel: 1 - cov.peel, sustain: 1 - cov.sustain,
    magic: clamp01((cov.physicalShare - 0.5) * 2), physical: clamp01((0.5 - cov.physicalShare) * 2),
  };
}

function archetypeModifier(key, unmet, weights) {
  const needs = ARCHETYPE_NEEDS[key] ?? [];
  let top = null;
  for (const n of needs) if (!top || unmet[n] > unmet[top]) top = n;
  return { pp: top ? weights.archetypeCapPp * unmet[top] : 0, need: top };
}

function chooseArchetype(archetypes, minPick, context, weights) {
  const plain = best(archetypes, minPick);
  if (!context || !Array.isArray(context.allies) || context.allies.length === 0 || !plain) return { primary: plain, contextDelta: null, contextReason: null };
  const unmet = unmetNeeds(context.allies);
  const adjusted = (a) => (a.winRate ?? 0) + archetypeModifier(a.key, unmet, weights).pp / 100;
  const pool = archetypes.filter((a) => (a.pickRate ?? 0) >= weights.archetypeMinPick);
  const winner = pool.slice().sort((a, b) => adjusted(b) - adjusted(a))[0] ?? plain;
  if (winner === plain) return { primary: plain, contextDelta: null, contextReason: null };
  const mod = archetypeModifier(winner.key, unmet, weights);
  return { primary: winner, contextDelta: Math.round((adjusted(winner) - adjusted(plain)) * 1000) / 10, contextReason: `team lacks ${NEED_LABEL[mod.need]}` };
}

const CATEGORY_THREAT = Object.freeze({ Armor: 'physical', SpellBlock: 'magic', Tenacity: 'cc', Health: 'burst' });
const THREAT_REASON = Object.freeze({
  physical: (t) => `${Math.round(t * 100)} % physical damage → Armor`,
  magic: (t) => `${Math.round(t * 100)} % magic damage → Magic resist`,
  cc: () => 'heavy crowd control → Tenacity',
  burst: () => 'high burst → Health',
  healing: () => 'enemy healing → anti-heal',
});

function situationalItems(champData, primary, context, weights) {
  const enemies = context?.enemies;
  if (!Array.isArray(enemies) || enemies.length === 0) return [];
  const cov = coverage(enemies);
  const threats = {
    physical: cov.physicalShare, magic: 1 - cov.physicalShare, cc: cov.cc,
    burst: Math.max(0, ...enemies.map((e) => (e.poke > 0.5 || e.roles.includes('assassin') ? e.burst : 0))),
    healing: cov.sustain,
  };
  const exclude = new Set([...(primary?.core ?? []).map((i) => i.id), primary?.boots?.id, ...(primary?.starter ?? []).map((i) => i.id)].filter((x) => x != null));
  const cats = context.itemCategories ?? {};
  const scored = [];
  for (const it of champData.items ?? []) {
    if ((it.pickRate ?? 0) < weights.itemMinPick || exclude.has(it.id)) continue;
    let bestThreat = null; let bestValue = 0;
    for (const c of cats[it.id] ?? []) {
      const t = CATEGORY_THREAT[c];
      if (t && threats[t] > bestValue) { bestValue = threats[t]; bestThreat = t; }
    }
    if (weights.antiHealItems.includes(it.id) && threats.healing > bestValue) { bestValue = threats.healing; bestThreat = 'healing'; }
    if (!bestThreat || bestValue < 0.3) continue;
    scored.push({ item: { id: it.id, name: it.name, icon: it.icon }, winRate: it.winRate, pickRate: it.pickRate, games: it.games,
      reason: THREAT_REASON[bestThreat](bestValue), adjusted: (it.winRate ?? 0) + (weights.itemCapPp * bestValue) / 100 });
  }
  return scored.sort((a, b) => b.adjusted - a.adjusted).slice(0, weights.maxSituational).map(({ adjusted, ...rest }) => rest);
}

export function pickBuild(champData, { minPick = 0.05, context = null, weights = WEIGHTS } = {}) {
  const archetypes = champData?.build?.archetypes ?? [];
  if (archetypes.length === 0) return null;
  const { primary, contextDelta, contextReason } = chooseArchetype(archetypes, minPick, context, weights);
  const spells = best(champData.summoners, minPick);
  const skill = best(champData.skills, minPick);
  const built = {
    context: !context || !context.allies?.length ? 'none' : context.enemies?.length ? 'both' : 'allies',
    primary: {
      key: primary.key, name: primary.name, winRate: primary.winRate, pickRate: primary.pickRate, games: primary.games,
      starter: primary.starters[0]?.items ?? [], boots: primary.boots[0]?.item ?? null, core: primary.core, later: primary.later.map((l) => l.item),
      spells: spells?.names ?? [], skillOrder: skill?.order ?? null, routeWinRate: primary.routeWinRate, routeGames: primary.routeGames,
      contextDelta, contextReason,
    },
    alternatives: archetypes.filter((a) => a !== primary).map((a) => ({ key: a.key, name: a.name, winRate: a.winRate, pickRate: a.pickRate, games: a.games })),
    situational: [],
  };
  built.situational = situationalItems(champData, built.primary, context, weights);
  return built;
}
