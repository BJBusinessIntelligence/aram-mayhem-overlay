import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAramgg } from '../../../src/data/aramgg/normalize.js';
import { NormalizeError } from '../../../src/data/model.js';
import { fixture } from '../../helpers/fixtures.js';

const sample = fixture('aramgg', 'champion-157.sample.json');
const resources = { augmentsById: { 1058: { id: 1058, name: 'Mystic Punch', rarity: 'prismatic', stats: { winRate: 0.51 } } }, itemsById: {} };
const meta = { version: '16.18.3', dataDate: '2026-09-21', fetchedAt: 9, championId: 157, riotId: 'Yasuo', name: 'Yasuo' };
const d = normalizeAramgg(sample, resources, meta);

test('meta and champion', () => {
  assert.equal(d.source, 'aramgg');
  assert.equal(d.sourceVersion, '16.18.3');
  assert.equal(d.bracket, 'all');
  assert.deepEqual(d.champion, { id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: 1, winRate: 0.571, pickRate: 0.1, games: 12345, icon: 'https://cdn.dtodo.cn/hextech/champion/157.png' });
});

test('augments: sorted by rank, null stats tolerated, rarity lower-cased, global WR from resources', () => {
  assert.deepEqual(d.augments.all.map((a) => a.id), [1058, 2009, 1077]);
  const mp = d.augments.all[0];
  assert.equal(mp.rarity, 'prismatic');
  assert.equal(mp.tier, null);
  assert.equal(mp.winRate, 0.64);
  assert.equal(mp.games, 1000);
  assert.equal(mp.globalWinRate, 0.51);
  const z = d.augments.all[1];
  assert.equal(z.winRate, null);
  assert.equal(z.games, 0);
  assert.equal(z.rarity, 'gold');
  assert.equal(z.globalWinRate, null);
  assert.deepEqual(d.augments.stages, {});
});

test('builds map to archetypes; first build feeds spells and skills', () => {
  assert.deepEqual(d.build.archetypes.map((a) => a.key), ['crit', 'bruiser']);
  const crit = d.build.archetypes[0];
  assert.equal(crit.name, 'Crit');
  assert.deepEqual(crit.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.deepEqual(crit.starters[0].items.map((i) => i.id), [1038]);
  assert.deepEqual(crit.boots, []);
  assert.deepEqual(crit.later.map((l) => l.item.id), [3031]);
  assert.equal(crit.routeWinRate, 0.6);
  assert.deepEqual(d.summoners[0], { spellIds: [4, 32], names: ['Flash', 'Mark'], winRate: 0.6, pickRate: 0.9, games: 4000 });
  assert.deepEqual(d.skills[0], { order: 'E>Q>W', winRate: 0.6, pickRate: 0.2, games: 1000 });
});

test('missing id or augments throws NormalizeError', () => {
  assert.throws(() => normalizeAramgg({ data: {} }, resources, { ...meta, championId: undefined }), NormalizeError);
  assert.throws(() => normalizeAramgg({ data: { id: 1, augments: [] } }, resources, meta), /augments empty/);
});
