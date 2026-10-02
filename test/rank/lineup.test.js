import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrunkWinRate, strengthPercentile, coverage, fitScore, synergyScore, confidenceFor, teamSummary, rankCandidates } from '../../src/rank/lineup.js';
import { WEIGHTS } from '../../src/rank/weights.js';
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';

const prof = (id, over = {}) => ({ ...EMPTY_PROFILE(id, `C${id}`), riotId: `C${id}`, warnings: [], sources: { cdragon: true, aramkit: true, override: false }, ...over });
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const rankingsOf = (rows) => ({ byId: Object.fromEntries(rows.map((r) => [r.id, { games: 1_000_000, tier: 'B', rank: 1, pickRate: 0.1, ...r }])) });

test('shrunkWinRate pulls low samples toward 50%', () => {
  assert.equal(shrunkWinRate(0.6, 0, 20000), 0.5);
  near(shrunkWinRate(0.6, 20000, 20000), 0.55);
  near(shrunkWinRate(0.6, 2_000_000, 20000), 0.6, 0.001);
});

test('strengthPercentile ranks among all rows; ties count half', () => {
  const r = rankingsOf([{ id: 1, winRate: 0.6 }, { id: 2, winRate: 0.5 }, { id: 3, winRate: 0.4 }]);
  near(strengthPercentile(1, r, WEIGHTS), 2.5 / 3);
  near(strengthPercentile(2, r, WEIGHTS), 1.5 / 3);
  near(strengthPercentile(3, r, WEIGHTS), 0.5 / 3);
  assert.equal(strengthPercentile(9, r, WEIGHTS), null);
});

test('coverage is noisy-OR per trait and damage-share-weighted physical share', () => {
  const c = coverage([prof(1, { frontline: 0.5, physicalShare: 1, damageShare: 0.3 }), prof(2, { frontline: 0.5, physicalShare: 0, damageShare: 0.1 })]);
  near(c.frontline, 0.75);
  near(c.physicalShare, 0.75);
  assert.equal(coverage([]).frontline, 0);
  assert.equal(coverage([]).physicalShare, 0.5);
});

test('fit: diminishing returns and damage balance; unknown allies shrink toward neutral', () => {
  const tank = prof(1, { frontline: 0.9 });
  const four = [prof(2), prof(3), prof(4), prof(5)];
  const first = fitScore(tank, four, WEIGHTS);
  const second = fitScore(tank, [prof(2, { frontline: 0.9 }), prof(3), prof(4), prof(5)], WEIGHTS);
  assert.ok(first.gains.frontline > second.gains.frontline);
  assert.ok(first.fit > second.fit);
  const adAllies = [prof(2, { physicalShare: 1 }), prof(3, { physicalShare: 1 }), prof(4, { physicalShare: 1 }), prof(5, { physicalShare: 1 })];
  assert.ok(fitScore(prof(9, { physicalShare: 0 }), adAllies, WEIGHTS).balanceGain > fitScore(prof(9, { physicalShare: 1 }), adAllies, WEIGHTS).balanceGain);
  const none = fitScore(tank, [], WEIGHTS);
  near(none.fit, WEIGHTS.fitNeutral);
});

test('synergy: generic terms and curated pairs', () => {
  const engager = prof(1, { engage: 1, riotId: 'Malphite' });
  const burst = prof(2, { burst: 1, riotId: 'Yasuo' });
  const s = synergyScore(engager, [burst], [{ a: 'Yasuo', b: 'Malphite', delta: 0.5, reason: 'knock-up for Last Breath' }]);
  assert.ok(s.synergy > 0.5);
  assert.ok(s.terms.some((t) => t.key === 'curated' && t.reason === 'knock-up for Last Breath'));
  assert.ok(s.terms.some((t) => t.key === 'engageBurst' && t.value === 1));
  assert.equal(synergyScore(prof(3), [], []).synergy, 0);
});

test('confidence levels', () => {
  const full = prof(1);
  assert.equal(confidenceFor({ knownAllies: 4, games: 60000, profile: full }, WEIGHTS), 'high');
  assert.equal(confidenceFor({ knownAllies: 3, games: 60000, profile: full }, WEIGHTS), 'medium');
  assert.equal(confidenceFor({ knownAllies: 3, games: 100, profile: full }, WEIGHTS), 'low');
  assert.equal(confidenceFor({ knownAllies: 4, games: 60000, profile: { ...full, sources: { cdragon: false, aramkit: true, override: false } } }, WEIGHTS), 'medium');
});

test('rankCandidates: held flagged, sorted by score, reasons and warnings, fallback strength', () => {
  const rankings = rankingsOf([{ id: 1, winRate: 0.58, tier: 'S' }, { id: 2, winRate: 0.50, tier: 'B' }, { id: 3, winRate: 0.45, tier: 'D', games: 1000 }]);
  const allies = [prof(10, { physicalShare: 1 }), prof(11, { physicalShare: 1 }), prof(12, { physicalShare: 1 }), prof(13, { physicalShare: 1 })];
  const profiles = { 1: prof(1, { physicalShare: 1 }), 2: prof(2, { physicalShare: 0, frontline: 0.9 }), 3: prof(3) };
  const champData = { 1: { champion: { id: 1, name: 'C1', icon: 'i1', winRate: 0.58, games: 1_000_000 } } };
  const out = rankCandidates({ held: 1, bench: [2, 3, 2], allies, rankings, profiles, champData, rules: [], weights: WEIGHTS });
  assert.deepEqual(out.map((c) => c.id).sort(), [1, 2, 3]);
  assert.equal(out.find((c) => c.id === 1).held, true);
  assert.equal(out.find((c) => c.id === 1).icon, 'i1');
  assert.equal(out.find((c) => c.id === 1).tier, 'S');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
  const two = out.find((c) => c.id === 2);
  assert.ok(two.reasons.includes('adds magic damage'));
  assert.ok(two.reasons.includes('adds frontline'));
  const three = out.find((c) => c.id === 3);
  assert.ok(three.warnings.some((w) => /low sample/.test(w)));
  assert.equal(three.confidence, 'medium'); // one failure: low sample (allies known, profile complete)
  // no rankings at all → strength from champ data
  const noRank = rankCandidates({ held: 1, bench: [], allies, rankings: null, profiles, champData, rules: [], weights: WEIGHTS });
  assert.ok(noRank[0].components.strength > 0.5);
  assert.ok(noRank[0].warnings.includes('rankings unavailable'));
  // missing both a rankings row and champ data → neutral 0.5, not the shrunk-undefined-win-rate fallback
  const noData = rankCandidates({ held: 99, bench: [], allies, rankings, profiles: {}, champData: {}, rules: [], weights: WEIGHTS });
  assert.equal(noData.find((c) => c.id === 99).components.strength, 0.5);
});

test('teamSummary', () => {
  const t = teamSummary([prof(1, { frontline: 1 }), prof(2)]);
  assert.equal(t.knownAllies, 2);
  assert.equal(t.coverage.frontline, 1);
  assert.equal(typeof t.physicalShare, 'number');
});
