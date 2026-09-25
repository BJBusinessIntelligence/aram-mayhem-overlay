import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeAugments, resolveStage, compareRows } from '../../src/rank/augments.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const real = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });

const row = (over) => ({ id: 1, name: 'x', rarity: 'gold', tier: 'B', rank: 1, winRate: 0.5, pickRate: 0.1, games: 1000, globalWinRate: 0.5, icon: null, ...over });
const synthetic = (all, stages = {}) => ({ champion: { id: 1, winRate: 0.5 }, augments: { all, stages: { 1: [], 2: [], 3: [], 4: [], ...stages } } });

test('resolveStage: auto uses level, falls back to all when stage empty', () => {
  assert.equal(resolveStage(real, { stage: 'auto', level: 7 }), 2);
  assert.equal(resolveStage(real, { stage: 'auto', level: null }), 'all');
  assert.equal(resolveStage(real, { stage: 3 }), 3);
  assert.equal(resolveStage(real, { stage: '4' }), 4);
  assert.equal(resolveStage(real, { stage: 'all', level: 15 }), 'all');
  assert.equal(resolveStage(real, { stage: 9 }), 'all');
  assert.equal(resolveStage(synthetic([row()]), { stage: 2 }), 'all');
});

test('groups by rarity, unknown separate, stageUsed reported', () => {
  const out = shapeAugments(real, { stage: 'auto', level: 1 });
  assert.equal(out.stageUsed, 1);
  assert.equal(out.columns.prismatic.length + out.columns.gold.length + out.columns.silver.length + out.unknown.length, 115);
  assert.deepEqual(out.unknown, []);
  const all = shapeAugments(real, { stage: 'all' });
  assert.equal(all.stageUsed, 'all');
  const mp = all.columns.prismatic.find((r) => r.id === 1058);
  assert.ok(Math.abs(mp.lift - (0.6517 - 0.5128)) < 1e-9);
  assert.equal(mp.lowSample, false);
});

test('sort: tier first, then winRate, then games; low sample last', () => {
  const rows = [
    row({ id: 1, tier: 'A', winRate: 0.60 }),
    row({ id: 2, tier: 'S', winRate: 0.55 }),
    row({ id: 3, tier: 'S', winRate: 0.58 }),
    row({ id: 4, tier: 'S', winRate: 0.70, games: 50 }),
    row({ id: 5, tier: null, winRate: 0.90 }),
    row({ id: 6, tier: 'S', winRate: 0.58, games: 5000 }),
  ];
  const out = shapeAugments(synthetic(rows), { stage: 'all', minGames: 200 });
  assert.deepEqual(out.columns.gold.map((r) => r.id), [6, 3, 2, 1, 5, 4]);
  assert.equal(out.columns.gold.at(-1).lowSample, true);
});

test('lift is null without globalWinRate; unknown rarity goes to unknown', () => {
  const out = shapeAugments(synthetic([row({ globalWinRate: null }), row({ id: 9, rarity: 'unknown' })]), { stage: 'all' });
  assert.equal(out.columns.gold[0].lift, null);
  assert.equal(out.unknown.length, 1);
});

test('compareRows is a valid comparator for equal rows', () => {
  assert.equal(compareRows(row(), row()), 0);
});
