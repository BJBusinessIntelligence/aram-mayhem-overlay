import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBlitz } from '../../../src/data/blitz/normalize.js';
import { NormalizeError } from '../../../src/data/model.js';
import { createChampionIndexFromCdragon } from '../../../src/data/champions.js';
import { fixture } from '../../helpers/fixtures.js';

function blitzResources() {
  const augments = fixture('cdragon', 'cherry-augments.json');
  const items = fixture('cdragon', 'items.json');
  const spells = fixture('cdragon', 'summoner-spells.json');
  const champions = fixture('cdragon', 'champion-summary.json');
  return {
    augmentsById: Object.fromEntries(augments.map((a) => [a.id, a])),
    itemsById: Object.fromEntries(items.map((i) => [i.id, i])),
    spellsById: Object.fromEntries(spells.map((s) => [s.id, s])),
    champions: createChampionIndexFromCdragon(champions),
  };
}

const mayhem = fixture('blitz', 'aram_mayhem_champion-157.json');
const builds = fixture('blitz', 'champion_builds_tags-157.json');
const resources = blitzResources();
const meta = { fetchedAt: 42 };
const data = normalizeBlitz({ mayhem, builds }, resources, meta);

test('meta and champion', () => {
  assert.equal(data.source, 'blitz');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.dataDate, '2026-09-25');
  assert.equal(data.fetchedAt, 42);
  assert.equal(data.bracket, 'all');
  assert.deepEqual(data.champion, {
    id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: null,
    winRate: null, pickRate: null, games: null, icon: null,
  });
});

test('augments.all has 126 rows with cdragon names/rarity/icon and no rates', () => {
  assert.equal(data.augments.all.length, 126);
  const mp = data.augments.all.find((a) => a.id === 1058);
  assert.deepEqual(mp, {
    id: 1058, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1,
    winRate: null, pickRate: null, games: null, globalWinRate: null,
    icon: 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/ux/cherry/augments/icons/mysticpunch_small.png',
  });
  assert.deepEqual(data.augments.stages, {});
});

test('unknown augment id falls back to #id / unknown rarity', () => {
  const raw = { mayhem: { data: [{ champion_id: '157', patch: '16.19', dt: '2026-09-25', data: { tier: 1, augments: { 999999: { tier: 2 } } } }] }, builds: { data: [] } };
  const custom = normalizeBlitz(raw, resources, meta);
  assert.deepEqual(custom.augments.all[0], {
    id: 999999, name: '#999999', rarity: 'unknown', tier: 'A', rank: 2,
    winRate: null, pickRate: null, games: null, globalWinRate: null, icon: null,
  });
});

test('build.archetypes: one per blitz build, core/starters/later/route', () => {
  assert.equal(data.build.archetypes.length, 4);
  const onHit = data.build.archetypes[0];
  assert.equal(onHit.key, 'on-hit');
  assert.equal(onHit.name, 'On-Hit (ARAM)');
  assert.equal(onHit.winRate, 0.5072727272727273);
  assert.equal(onHit.pickRate, 0.12278612888822742);
  assert.equal(onHit.games, 1650);
  assert.deepEqual(onHit.core.map((i) => i.id), [3006, 3153, 3091]);
  assert.equal(onHit.core[0].name, "Berserker's Greaves");
  assert.ok(onHit.core[0].icon.startsWith('https://raw.communitydragon.org/'));
  assert.deepEqual(onHit.boots, []);
  assert.ok(onHit.starters.length > 0);
  const picks = onHit.starters.map((s) => s.pickRate);
  assert.deepEqual(picks, [...picks].sort((a, b) => b - a));
  assert.equal(onHit.later.length, 6);
  const laterPicks = onHit.later.map((l) => l.pickRate);
  assert.deepEqual(laterPicks, [...laterPicks].sort((a, b) => b - a));
  assert.equal(onHit.routeWinRate, 0.5241379310344828);
  assert.equal(onHit.routeGames, 435);
});

test('build key falls back to build_N when name_tags is missing', () => {
  const raw = {
    mayhem,
    builds: { data: [{ name_tags: [], win_rate: 0.5, pick_rate: 0.1, games: 10, coreItems: [{ itemIds: '3006', win_rate: 0.5, pick_rate: 0.1, games: 10 }], startingItems: [], situationalItems: [], summonerSpells: [], skillOrders: [] }] },
  };
  const custom = normalizeBlitz(raw, resources, meta);
  assert.equal(custom.build.archetypes[0].key, 'build_1');
  assert.equal(custom.build.archetypes[0].name, 'Build (ARAM)');
});

test('summoners/skills come from the first build', () => {
  assert.deepEqual(data.summoners[0].spellIds, [4, 32]);
  assert.deepEqual(data.summoners[0].names, ['Flash', 'Mark']);
  assert.equal(data.summoners[0].winRate, 0.5019011406844106);
  assert.equal(data.summoners[0].games, 1315);
  assert.equal(data.skills[0].order, 'Q>E>W');
  assert.equal(data.skills[0].winRate, 0.5674342105263158);
});

test('throws NormalizeError when champion unknown to blitz (empty data array)', () => {
  assert.throws(() => normalizeBlitz({ mayhem: { data: [] }, builds: { data: [] } }, resources, meta), NormalizeError);
});

test('throws NormalizeError when augments empty', () => {
  const raw = { mayhem: { data: [{ champion_id: '1', patch: '16.19', dt: null, data: { tier: 1, augments: {} } }] }, builds: { data: [] } };
  assert.throws(() => normalizeBlitz(raw, resources, meta), NormalizeError);
});
