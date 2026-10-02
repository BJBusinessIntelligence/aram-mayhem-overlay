import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBuild } from '../../src/rank/builds.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';
import { WEIGHTS } from '../../src/rank/weights.js';
const prof = (id, over = {}) => ({ ...EMPTY_PROFILE(id, `C${id}`), warnings: [], ...over });
const squishy = () => [prof(1), prof(2), prof(3), prof(4)];                  // no frontline anywhere

const real = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });

test('real data: crit is primary, route flattened, spells and skills chosen by WR with pick filter', () => {
  const b = pickBuild(real);
  assert.equal(b.primary.key, 'crit');
  assert.equal(b.primary.name, 'Crit');
  assert.equal(b.primary.winRate, 0.6011);
  assert.deepEqual(b.primary.starter.map((i) => i.id), [1038]);
  assert.equal(b.primary.boots.id, 3006);
  assert.deepEqual(b.primary.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.deepEqual(b.primary.later.map((i) => i.id), [3153, 3031, 3065, 6665, 3033, 3143]);
  assert.deepEqual(b.primary.spells, ['Flash', 'Mark']);
  assert.equal(b.primary.skillOrder, 'E>Q>W');
  assert.equal(b.primary.routeWinRate, 0.657);
  assert.deepEqual(b.alternatives.map((a) => a.key), ['bruiser', 'ad', 'on_hit']);
});

const arch = (over) => ({ key: 'k', name: 'K', winRate: 0.5, pickRate: 0.5, games: 100, core: [], starters: [], boots: [], later: [], routeWinRate: 0.5, routePickRate: 0.5, routeGames: 10, ...over });

test('no archetype passes pick filter → all considered', () => {
  const d = { build: { archetypes: [arch({ key: 'a', pickRate: 0.01, winRate: 0.6 }), arch({ key: 'b', pickRate: 0.02, winRate: 0.7 })] }, summoners: [], skills: [] };
  const b = pickBuild(d);
  assert.equal(b.primary.key, 'b');
  assert.deepEqual(b.primary.spells, []);
  assert.equal(b.primary.skillOrder, null);
  assert.equal(b.primary.boots, null);
});

test('ties broken by games', () => {
  const d = { build: { archetypes: [arch({ key: 'a', games: 10 }), arch({ key: 'b', games: 20 })] }, summoners: [], skills: [] };
  assert.equal(pickBuild(d).primary.key, 'b');
});

test('empty archetypes → null', () => {
  assert.equal(pickBuild({ build: { archetypes: [] }, summoners: [], skills: [] }), null);
  assert.equal(pickBuild({}), null);
});

test('no context → context none, no situational, primary unchanged', () => {
  const b = pickBuild(real);
  assert.equal(b.context, 'none');
  assert.deepEqual(b.situational, []);
  assert.equal(b.primary.contextDelta, null);
});

test('allies only: a frontline need can promote bruiser within the cap; swap is explained', () => {
  const d = { build: { archetypes: [arch({ key: 'crit', name: 'Crit', winRate: 0.60, pickRate: 0.6 }), arch({ key: 'bruiser', name: 'Bruiser', winRate: 0.58, pickRate: 0.2 })] }, summoners: [], skills: [], items: [] };
  const b = pickBuild(d, { context: { allies: squishy(), enemies: null, itemCategories: {} } });
  assert.equal(b.context, 'allies');
  assert.equal(b.primary.key, 'bruiser');
  assert.ok(b.primary.contextDelta > 0 && b.primary.contextDelta <= WEIGHTS.archetypeCapPp);
  assert.equal(b.primary.contextReason, 'team lacks frontline');
  // a 5 pp gap is beyond the 3 pp cap: no swap
  const far = { ...d, build: { archetypes: [arch({ key: 'crit', winRate: 0.63, pickRate: 0.6 }), arch({ key: 'bruiser', winRate: 0.58, pickRate: 0.2 })] } };
  assert.equal(pickBuild(far, { context: { allies: squishy(), enemies: null, itemCategories: {} } }).primary.key, 'crit');
  // below the pick floor the alternative may not overtake
  const rare = { ...d, build: { archetypes: [arch({ key: 'crit', winRate: 0.60, pickRate: 0.6 }), arch({ key: 'bruiser', winRate: 0.58, pickRate: 0.02 })] } };
  assert.equal(pickBuild(rare, { context: { allies: squishy(), enemies: null, itemCategories: {} } }).primary.key, 'crit');
  // frontline already covered → no modifier
  const covered = [prof(1, { frontline: 1 }), prof(2), prof(3), prof(4)];
  assert.equal(pickBuild(d, { context: { allies: covered, enemies: null, itemCategories: {} } }).primary.key, 'crit');
});

test('both teams: situational items ranked by threat-matching categories, core excluded, max 3', () => {
  const items = [
    { id: 3065, name: 'Spirit Visage', icon: null, winRate: 0.55, pickRate: 0.05, games: 1000 },
    { id: 3075, name: 'Thornmail', icon: null, winRate: 0.54, pickRate: 0.04, games: 1000 },
    { id: 3047, name: 'Plated Steelcaps', icon: null, winRate: 0.56, pickRate: 0.3, games: 1000 },
    { id: 3031, name: 'Infinity Edge', icon: null, winRate: 0.62, pickRate: 0.5, games: 1000 },
    { id: 3153, name: 'BotRK', icon: null, winRate: 0.6, pickRate: 0.2, games: 1000 },
    { id: 9999, name: 'Rare', icon: null, winRate: 0.9, pickRate: 0.001, games: 10 },
  ];
  const itemCategories = { 3065: ['Health', 'SpellBlock'], 3075: ['Armor', 'Health'], 3047: ['Armor', 'Boots'], 3031: ['Damage', 'CriticalStrike'], 3153: ['Damage', 'LifeSteal'], 9999: ['Armor'] };
  const d = { build: { archetypes: [arch({ key: 'crit', winRate: 0.6, pickRate: 0.6, core: [{ id: 3031, name: 'IE', icon: null }] })] }, summoners: [], skills: [], items };
  const enemies = [prof(5, { physicalShare: 1, damageShare: 0.3 }), prof(6, { physicalShare: 1, damageShare: 0.3 }), prof(7, { physicalShare: 1 }), prof(8, { physicalShare: 1 }), prof(9, { physicalShare: 1 })];
  const b = pickBuild(d, { context: { allies: squishy(), enemies, itemCategories } });
  assert.equal(b.context, 'both');
  assert.ok(b.situational.length <= 3);
  const ids = b.situational.map((s) => s.item.id);
  assert.ok(ids.includes(3047) && ids.includes(3075), 'armor items vs an all-AD lineup');
  assert.ok(!ids.includes(3031), 'core item excluded');
  assert.ok(!ids.includes(9999), 'below pick floor excluded');
  assert.match(b.situational.find((s) => s.item.id === 3047).reason, /physical damage → Armor/);
  const healing = [prof(5, { sustain: 1 })];
  const h = pickBuild(d, { context: { allies: squishy(), enemies: healing, itemCategories } });
  assert.ok(h.situational.some((s) => s.item.id === 3075 && /anti-heal/.test(s.reason)));
});
