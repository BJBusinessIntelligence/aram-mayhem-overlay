import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAramkit } from '../../../src/data/aramkit/normalize.js';
import { NormalizeError } from '../../../src/data/model.js';
import { fixture, aramkitResources } from '../../helpers/fixtures.js';

const raw = fixture('aramkit', 'champion-details-157-all.json');
const resources = aramkitResources();
const meta = { version: '16.19', dataDate: '2026-09-24', bracket: 'all', fetchedAt: 42, iconBase: 'https://data.aramkit.com/' };
const data = normalizeAramkit(raw, resources, meta);

test('meta and champion', () => {
  assert.equal(data.source, 'aramkit');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.dataDate, '2026-09-24');
  assert.equal(data.fetchedAt, 42);
  assert.equal(data.bracket, 'all');
  assert.deepEqual(data.champion, {
    id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: 1,
    winRate: 0.5764, pickRate: 0.1083, games: 804398,
    icon: 'https://data.aramkit.com/assets/champion/157-617df344cd83.webp',
  });
});

test('augments.all joined with names, rarity, icon', () => {
  assert.equal(data.augments.all.length, 126);
  const { description, ...rest } = data.augments.all.find((a) => a.id === 1058);
  assert.deepEqual(rest, {
    id: 1058, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1,
    winRate: 0.6517, pickRate: 0.1477, games: 112923, globalWinRate: 0.5128,
    icon: 'https://data.aramkit.com/assets/augment/1058-9450203898b2.webp',
  });
  assert.equal(typeof description, 'string');
  assert.ok(description.length > 20);
  const rarities = new Set(data.augments.all.map((a) => a.rarity));
  assert.deepEqual([...rarities].sort(), ['gold', 'prismatic', 'silver']);
});

test('stages 1-4 present with per-stage rows', () => {
  assert.deepEqual([1, 2, 3, 4].map((s) => data.augments.stages[s].length), [115, 123, 111, 109]);
  const first = data.augments.stages[1][0];
  assert.equal(first.id, 2009);
  assert.equal(first.name, 'Zealot');
  assert.equal(first.winRate, 0.68);
});

test('archetypes flattened from top profile top route', () => {
  const keys = data.build.archetypes.map((a) => a.key);
  assert.deepEqual(keys, ['crit', 'bruiser', 'ad', 'on_hit']);
  const crit = data.build.archetypes[0];
  assert.equal(crit.name, 'Crit');
  assert.equal(crit.winRate, 0.6011);
  assert.equal(crit.pickRate, 0.5979);
  assert.equal(crit.games, 300925);
  assert.deepEqual(crit.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.equal(crit.core[0].name, 'Yun Tal Wildarrows');
  assert.equal(crit.core[1].name, 'Rite of Ruin');
  assert.match(crit.core[0].icon, /^https:\/\/data\.aramkit\.com\/assets\/item\/3032-/);
  assert.deepEqual(crit.starters[0].items.map((i) => i.id), [1038]);
  assert.equal(crit.starters[0].pickRate, 0.5027);
  assert.equal(crit.boots[0].item.id, 3006);
  assert.equal(crit.boots[0].item.name, "Berserker's Greaves");
  assert.ok(crit.boots.every((b) => b.item.id !== 0), 'No Boots (id 0) is dropped');
  assert.deepEqual(crit.later.map((l) => l.item.id), [3153, 3031, 3065, 6665, 3033, 3143]);
  assert.equal(crit.routeWinRate, 0.657);
  assert.equal(crit.routeGames, 19097);
});

test('summoners and skills', () => {
  assert.deepEqual(data.summoners[0], { spellIds: [4, 32], names: ['Flash', 'Mark'], winRate: 0.5783, pickRate: 0.9149, games: 735948 });
  assert.deepEqual(data.skills[0], { order: 'E>Q>W', winRate: 0.6119, pickRate: 0.1979, games: 151461 });
});

test('unknown resource ids degrade to placeholders', () => {
  const d = normalizeAramkit(raw, { champions: {}, augments: {}, items: {}, spells: {}, archetypes: {} }, meta);
  assert.equal(d.champion.name, '#157');
  assert.equal(d.champion.riotId, null);
  const mp = d.augments.all.find((a) => a.id === 1058);
  assert.equal(mp.name, '#1058');
  assert.equal(mp.rarity, 'unknown');
  assert.equal(mp.icon, null);
  assert.equal(mp.description, null);
  assert.equal(d.build.archetypes[0].name, 'crit');
  assert.equal(d.build.archetypes[0].core[0].name, '#3032');
  assert.deepEqual(d.summoners[0].names, ['#4', '#32']);
});

test('missing champion or empty augments throws NormalizeError', () => {
  assert.throws(() => normalizeAramkit({}, resources, meta), NormalizeError);
  assert.throws(() => normalizeAramkit({ champion: { id: 1 }, augments: { all: [] } }, resources, meta), /augments\.all empty/);
});

test('missing optional sections give empty arrays', () => {
  const d = normalizeAramkit({ champion: { id: 1, stats: {} }, augments: { all: [{ id: 1058, winRate: 0.5 }] } }, resources, meta);
  assert.deepEqual(d.build.archetypes, []);
  assert.deepEqual(d.summoners, []);
  assert.deepEqual(d.skills, []);
  assert.deepEqual(d.augments.stages, { 1: [], 2: [], 3: [], 4: [] });
  assert.equal(d.augments.all[0].games, 0);
  assert.equal(d.augments.all[0].globalWinRate, null);
});
