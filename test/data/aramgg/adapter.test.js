import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramggAdapter } from '../../../src/data/aramgg/adapter.js';
import { createCache } from '../../../src/data/cache.js';
import { createChampionIndex } from '../../../src/data/champions.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture } from '../../helpers/fixtures.js';

const sample = fixture('aramgg', 'champion-157.sample.json');
const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));

function fakeClient() {
  const calls = { config: 0, champion: 0, augments: 0, items: 0 };
  return {
    calls,
    async config() { calls.config++; return { dataVersion: '16.18.3', generatedAt: '2026-09-21T09:31:09.379Z' }; },
    async champion() { calls.champion++; return sample; },
    async augments() { calls.augments++; return { data: { augments: [{ id: 1058, name: 'Mystic Punch', rarity: 'Prismatic', stats: { winRate: 0.51 } }] } }; },
    async items() { calls.items++; return { data: { items: [{ id: 3032, name: 'Yun Tal Wildarrows', iconUrl: 'https://cdn/x.png' }] } }; },
    async spells() { return { data: [] }; },
  };
}

test('disabled without key', () => {
  const a = createAramggAdapter({ client: fakeClient(), cache: createCache({ dir: 'c', ttlMs: 1, fs: createMemFs() }), apiKey: null });
  assert.equal(a.enabled, false);
  assert.equal(a.name, 'aramgg');
  assert.equal(a.supportsBracket('high'), false);
  assert.equal(a.supportsBracket('all'), true);
  assert.equal(a.supportsStages(), false);
});

test('version from config; champion normalized with resources and champ index names', async () => {
  const fs = createMemFs();
  const client = fakeClient();
  const a = createAramggAdapter({ client, cache: createCache({ dir: 'c', ttlMs: 1000, fs, now: () => 5 }), apiKey: 'k', champIndex: index, now: () => 5 });
  assert.equal(a.enabled, true);
  assert.equal(await a.version(), '16.18.3');
  const d = await a.champion(157, 'all');
  assert.equal(d.champion.riotId, 'Yasuo');
  assert.equal(d.dataDate, '2026-09-21');
  assert.equal(d.augments.all[0].globalWinRate, 0.51);
  assert.equal(d.build.archetypes[0].core[0].icon, 'https://cdn/x.png', 'resource icon fills in when the item ref has none');
  assert.equal(client.calls.config, 1);
  assert.equal(client.calls.augments, 1);
  await a.champion(157, 'all');
  assert.equal(client.calls.augments, 1, 'resources cached');
  const c2 = fakeClient();
  const b = createAramggAdapter({ client: c2, cache: createCache({ dir: 'c', ttlMs: 1000, fs, now: () => 5 }), apiKey: 'k', champIndex: index });
  await b.champion(157, 'all');
  assert.equal(c2.calls.augments, 0, 'second adapter reads disk cache');
  assert.equal(c2.calls.items, 0, 'second adapter reads disk cache');
});
