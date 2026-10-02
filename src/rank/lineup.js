import { TRAITS, EMPTY_PROFILE } from './profiles.js';
import { WEIGHTS } from './weights.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TRAIT_LABEL = Object.freeze({ frontline: 'frontline', engage: 'engage', peel: 'peel', sustain: 'sustain', cc: 'crowd control', poke: 'poke' });

export function shrunkWinRate(winRate, games, K) {
  const n = Number(games) || 0;
  const wr = typeof winRate === 'number' ? winRate : 0.5;
  return (wr * n + 0.5 * K) / (n + K);
}

// Fraction of all ranked champions whose shrunk win rate is below this champion's (ties count half).
export function strengthPercentile(id, rankings, weights = WEIGHTS) {
  const rows = Object.values(rankings?.byId ?? {});
  const me = rankings?.byId?.[id];
  if (!me || rows.length === 0) return null;
  const s = shrunkWinRate(me.winRate, me.games, weights.shrinkGames);
  let below = 0; let equal = 0;
  for (const r of rows) {
    const v = shrunkWinRate(r.winRate, r.games, weights.shrinkGames);
    if (v < s) below++; else if (v === s) equal++;
  }
  return (below + 0.5 * equal) / rows.length;
}

// Noisy-OR per trait: a second tank adds much less than the first.
export function coverage(profiles, weights = WEIGHTS) {
  const out = {};
  for (const t of TRAITS) out[t] = 1 - profiles.reduce((acc, p) => acc * (1 - clamp01(p?.[t] ?? 0)), 1);
  const w = profiles.reduce((s, p) => s + (p?.damageShare ?? weights.defaultDamageShare), 0);
  out.physicalShare = w > 0 ? profiles.reduce((s, p) => s + (p?.physicalShare ?? 0.5) * (p?.damageShare ?? weights.defaultDamageShare), 0) / w : 0.5;
  return out;
}

export function fitScore(candidate, allies, weights = WEIGHTS) {
  const before = coverage(allies, weights);
  const after = coverage([...allies, candidate], weights);
  const gains = {};
  let sum = 0; let wsum = 0;
  for (const t of TRAITS) {
    gains[t] = Math.max(0, after[t] - before[t]);
    sum += weights.traits[t] * gains[t]; wsum += weights.traits[t];
  }
  const balanceGain = clamp01(2 * Math.max(0, Math.abs(before.physicalShare - 0.5) - Math.abs(after.physicalShare - 0.5)));
  sum += weights.traits.balance * balanceGain; wsum += weights.traits.balance;
  const raw = wsum > 0 ? sum / wsum : 0;
  const known = Math.min(weights.teamSize, allies.length) / weights.teamSize;
  const fit = weights.fitNeutral + (raw - weights.fitNeutral) * known;
  return { fit: clamp01(fit), raw, gains, balanceGain, after };
}

const isHypercarry = (p) => (p.roles.includes('marksman') || p.roles.includes('mage')) && p.style.durability <= 0.3;

export function synergyScore(candidate, allies, rules = []) {
  const terms = [];
  if (allies.length) {
    const engageBurst = clamp01(candidate.engage * Math.max(...allies.map((a) => a.burst)));
    const peelCarry = clamp01(candidate.peel * Math.max(...allies.map((a) => (isHypercarry(a) ? a.style.damage : 0))));
    const ccChain = clamp01(candidate.cc * Math.max(...allies.map((a) => a.cc)));
    terms.push({ key: 'engageBurst', value: engageBurst, reason: 'engage for allied burst' });
    terms.push({ key: 'peelCarry', value: peelCarry, reason: `peel for ${allies.find(isHypercarry)?.name ?? 'the carry'}` });
    terms.push({ key: 'ccChain', value: ccChain, reason: 'crowd-control chain' });
  }
  let curated = 0;
  for (const r of rules) {
    const pair = [r.a, r.b];
    const other = pair[0] === candidate.riotId ? pair[1] : pair[1] === candidate.riotId ? pair[0] : null;
    if (other && allies.some((a) => a.riotId === other)) { curated += Number(r.delta) || 0; terms.push({ key: 'curated', value: clamp01(Number(r.delta) || 0), reason: r.reason ?? `pairs with ${other}` }); }
  }
  const generic = terms.filter((t) => t.key !== 'curated');
  const base = generic.length ? generic.reduce((s, t) => s + t.value, 0) / generic.length : 0;
  return { synergy: clamp01(base + curated), terms };
}

export function confidenceFor({ knownAllies, games, profile }, weights = WEIGHTS) {
  const failures = [knownAllies < weights.teamSize, (games ?? 0) < weights.lowSampleGames, !(profile?.sources?.cdragon && profile?.sources?.aramkit)].filter(Boolean).length;
  return failures === 0 ? 'high' : failures === 1 ? 'medium' : 'low';
}

export function teamSummary(allies) {
  const cov = coverage(allies);
  return { knownAllies: allies.length, coverage: cov, physicalShare: cov.physicalShare };
}

function reasonsFor({ candidate, strength, fit, synergy, games, weights }) {
  const pos = [];
  for (const t of TRAITS) if (fit.gains[t] >= weights.reasonMinGain) pos.push({ v: fit.gains[t], text: `adds ${TRAIT_LABEL[t]}` });
  if (fit.balanceGain >= weights.reasonMinGain) pos.push({ v: fit.balanceGain, text: candidate.physicalShare < 0.5 ? 'adds magic damage' : 'adds physical damage' });
  for (const term of synergy.terms) if (term.value >= weights.reasonMinSynergy) pos.push({ v: term.value, text: term.reason });
  if (strength >= 0.8) pos.push({ v: strength, text: 'top-tier win rate' });
  const reasons = [...new Set(pos.sort((a, b) => b.v - a.v).map((p) => p.text))].slice(0, 3);
  const lacking = TRAITS.filter((t) => fit.after[t] < weights.lackThreshold).sort((a, b) => fit.after[a] - fit.after[b])[0];
  if (lacking) reasons.push(`team still lacks ${TRAIT_LABEL[lacking]}`);
  if ((games ?? 0) < weights.lowSampleGames) reasons.push(`low sample (${Math.round((games ?? 0) / 1000)}k games)`);
  return reasons;
}

export function rankCandidates({ held, bench = [], allies = [], rankings = null, profiles = {}, champData = {}, rules = [], weights = WEIGHTS }) {
  const ids = [...new Set([held, ...bench].filter((id) => Number.isInteger(id) && id > 0))];
  const out = ids.map((id) => {
    const profile = profiles[id] ?? EMPTY_PROFILE(id);
    const row = rankings?.byId?.[id] ?? null;
    const champ = champData[id]?.champion ?? null;
    const warnings = [...(profile.warnings ?? [])];
    let strength = rankings ? strengthPercentile(id, rankings, weights) : null;
    if (strength == null) {
      warnings.push(rankings ? 'not in rankings' : 'rankings unavailable');
      if (champ == null) {
        strength = 0.5; // missing both rankings row and champ data → neutral, no basis to guess either way
      } else {
        const wr = shrunkWinRate(champ.winRate, champ.games, weights.shrinkGames);
        strength = clamp01((wr - weights.fallbackStrength.floor) / weights.fallbackStrength.range);
      }
    }
    const games = row?.games ?? champ?.games ?? 0;
    if (games < weights.lowSampleGames) warnings.push(`low sample (${Math.round(games / 1000)}k games)`);
    const fit = fitScore(profile, allies, weights);
    const synergy = synergyScore(profile, allies, rules);
    const score = Math.round(100 * (weights.components.strength * strength + weights.components.fit * fit.fit + weights.components.synergy * synergy.synergy));
    return {
      id, riotId: profile.riotId ?? champ?.riotId ?? null, name: champ?.name ?? profile.name, icon: champ?.icon ?? profile.icon ?? null,
      held: id === held, tier: row?.tier ?? champ?.tier ?? null, winRate: row?.winRate ?? champ?.winRate ?? null, games,
      score, components: { strength, fit: fit.fit, synergy: synergy.synergy },
      confidence: confidenceFor({ knownAllies: allies.length, games, profile }, weights),
      reasons: reasonsFor({ candidate: profile, strength, fit, synergy, games, weights }),
      warnings: [...new Set(warnings)],
    };
  });
  return out.sort((a, b) => b.score - a.score || (b.winRate ?? 0) - (a.winRate ?? 0));
}
