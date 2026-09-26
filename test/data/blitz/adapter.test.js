import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlitzAdapter } from '../../../src/data/blitz/adapter.js';
import { createCache } from '../../../src/data/cache.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture } from '../../helpers/fixtures.js';

const mayhem157 = fixture('blitz', 'aram_mayhem_champion-157.json');
const builds157 = fixture('blitz', 'champion_builds_tags-157.json');

function fakeResources() {
  const augments = fixture('cdragon', 'cherry-augments.json');
  const items = fixture('cdragon', 'items.json');
  const spells = fixture('cdragon', 'summoner-spells.json');
  const champions = fixture('cdragon', 'champion-summary.json');
  // Matches createCdragonResources().load(): champions is the raw champion-summary array; the
  // adapter is responsible for building the byId/byRiotId index from it.
  const loaded = {
    augmentsById: Object.fromEntries(augments.map((a) => [a.id, a])),
    itemsById: Object.fromEntries(items.map((i) => [i.id, i])),
    spellsById: Object.fromEntries(spells.map((s) => [s.id, s])),
    champions,
  };
  const calls = { load: 0 };
  return { calls, async load() { calls.load++; return loaded; } };
}

function fakeClient() {
  const calls = { championMayhem: [], builds: [] };
  return {
    calls,
    async championMayhem(id) { calls.championMayhem.push(id); if (id !== 157) return { data: [] }; return mayhem157; },
    async builds(id) { calls.builds.push(id); if (id !== 157) return { data: [] }; return builds157; },
  };
}

function setup({ t = 1_000_000 } = {}) {
  const clock = { t };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs: createMemFs(), now: () => clock.t });
  const client = fakeClient();
  const resources = fakeResources();
  const adapter = createBlitzAdapter({ client, resources, cache, now: () => clock.t });
  return { adapter, client, resources, clock };
}

test('interface flags', () => {
  const { adapter } = setup();
  assert.equal(adapter.name, 'blitz');
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.supportsBracket('all'), true);
  assert.equal(adapter.supportsBracket('high'), false);
  assert.equal(adapter.supportsStages(), false);
});

test('champion fetches both endpoints in parallel and normalizes', async () => {
  const { adapter, client, resources } = setup();
  const data = await adapter.champion(157, 'all');
  assert.equal(data.champion.name, 'Yasuo');
  assert.equal(data.source, 'blitz');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.augments.all.length, 126);
  assert.equal(data.build.archetypes.length, 4);
  assert.deepEqual(client.calls.championMayhem, [157]);
  assert.deepEqual(client.calls.builds, [157]);
  assert.equal(resources.calls.load, 1);
});

test('version reads the patch from champion 157 by default and caches for 6h', async () => {
  const { adapter, client, clock } = setup();
  assert.equal(await adapter.version(), '16.19');
  assert.equal(await adapter.version(), '16.19');
  assert.deepEqual(client.calls.championMayhem, [157]);
  clock.t += 6 * 3600_000;
  await adapter.version();
  assert.equal(client.calls.championMayhem.length, 2);
});

test('version uses the last requested champion id once one has been fetched', async () => {
  const { adapter, client } = setup();
  await adapter.champion(157, 'all');
  await adapter.version();
  assert.deepEqual(client.calls.championMayhem, [157, 157]);
});
