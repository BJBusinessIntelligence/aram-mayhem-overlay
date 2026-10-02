import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramkitAdapter } from '../../../src/data/aramkit/adapter.js';
import { createCache } from '../../../src/data/cache.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture, aramkitResources } from '../../helpers/fixtures.js';

const versions = fixture('aramkit', 'versions.json');
const champ157 = fixture('aramkit', 'champion-details-157-all.json');
const res = aramkitResources();
const RESOURCE_FILES = { champions: res.champions, augments: res.augments, items: res.items, 'summoner-spells': res.spells, archetypes: res.archetypes };

function fakeClient() {
  const calls = { latestVersion: 0, champion: [], resource: [], rankings: 0, averages: 0 };
  return {
    calls,
    async latestVersion() { calls.latestVersion++; return versions.versions[0]; },
    async champion(id, bracket) { calls.champion.push([id, bracket]); if (id !== 157) throw new Error('no such champ'); return champ157; },
    async resource(name) { calls.resource.push(name); return RESOURCE_FILES[name]; },
    async rankings(bracket) { calls.rankings = (calls.rankings ?? 0) + 1; return fixture('aramkit', 'champion-rankings-all.json'); },
    async averages(bracket) { calls.averages = (calls.averages ?? 0) + 1; return fixture('aramkit', 'champion-performance-averages-all.json'); },
  };
}

function setup({ fs = createMemFs(), t = 1_000_000 } = {}) {
  const clock = { t };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const client = fakeClient();
  const adapter = createAramkitAdapter({ client, cache, now: () => clock.t });
  return { adapter, client, cache, fs, clock };
}

test('interface flags', () => {
  const { adapter } = setup();
  assert.equal(adapter.name, 'aramkit');
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.supportsBracket('all'), true);
  assert.equal(adapter.supportsBracket('high'), true);
  assert.equal(adapter.supportsBracket('mid'), false);
  assert.equal(adapter.supportsStages(), true);
});

test('version comes from latest entry and is cached for 6h', async () => {
  const { adapter, client, clock } = setup();
  assert.equal(await adapter.version(), '16.19');
  assert.equal(await adapter.version(), '16.19');
  assert.equal(client.calls.latestVersion, 1);
  clock.t += 6 * 3600_000;
  await adapter.version();
  assert.equal(client.calls.latestVersion, 2);
});

test('champion fetches resources once and normalizes', async () => {
  const { adapter, client } = setup();
  const data = await adapter.champion(157, 'all');
  assert.equal(data.champion.name, 'Yasuo');
  assert.equal(data.bracket, 'all');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.fetchedAt, 1_000_000);
  assert.equal(client.calls.resource.length, 5);
  await adapter.champion(157, 'high');
  assert.equal(client.calls.resource.length, 5, 'resources reused in memory');
  assert.deepEqual(client.calls.champion, [[157, 'all'], [157, 'high']]);
});

test('resources are read from disk cache by a fresh adapter when resourcePath matches', async () => {
  const fs = createMemFs();
  const a = setup({ fs });
  await a.adapter.champion(157, 'all');
  const b = setup({ fs });
  await b.adapter.champion(157, 'all');
  assert.equal(b.client.calls.resource.length, 0);
});

test('championIndex is built from resources', async () => {
  const { adapter } = setup();
  const index = await adapter.championIndex();
  assert.equal(index.byRiotId('monkeyking').id, 62);
});

test('client errors propagate', async () => {
  const { adapter } = setup();
  await assert.rejects(adapter.champion(1, 'all'), /no such champ/);
});

test('rankings: map by id, cached per version, one fetch', async () => {
  const { adapter, client, fs } = setup();
  const r = await adapter.rankings('all');
  assert.equal(r.version, versions.versions[0].version);
  assert.deepEqual(r.byId[157], { id: 157, rank: 1, tier: 'S', winRate: 0.5764, pickRate: 0.1083, games: 804398 });
  await adapter.rankings('all');
  assert.equal(client.calls.rankings, 1);
  assert.ok([...fs.files.keys()].some((k) => k.endsWith('champion-rankings.json')));
  const client2 = fakeClient();
  const again = createAramkitAdapter({ client: client2, cache: createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => 1_000_000 }), now: () => 1_000_000 });
  await again.rankings('all');
  assert.equal(client2.calls.rankings, 0, 'the second adapter instance reads the disk cache: no new rankings fetch on its own client');
});

test('rankings: a null row is dropped instead of throwing', async () => {
  const { adapter, client } = setup();
  const original = fixture('aramkit', 'champion-rankings-all.json');
  client.rankings = async () => ({ ...original, rows: [null, ...original.rows] });
  const r = await adapter.rankings('all');
  assert.deepEqual(r.byId[157], { id: 157, rank: 1, tier: 'S', winRate: 0.5764, pickRate: 0.1083, games: 804398 });
  assert.equal(Object.keys(r.byId).length, original.rows.length);
});

test('averages: combat shape', async () => {
  const { adapter } = setup();
  const a = await adapter.averages('all');
  assert.equal(a.combat.damageSelfMitigated, 46272.043);
  assert.equal(a.combat.healsOnTeammates, 479.216);
});
