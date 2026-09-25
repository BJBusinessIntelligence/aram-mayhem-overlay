import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBuild } from '../../src/rank/builds.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

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
