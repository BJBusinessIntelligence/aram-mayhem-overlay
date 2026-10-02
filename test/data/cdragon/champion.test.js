import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCdragonChampions, normalizeCdragonChampion } from '../../../src/data/cdragon/champion.js';
import { CDRAGON_BASE } from '../../../src/data/cdragon/resources.js';
import { createCache } from '../../../src/data/cache.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture } from '../../helpers/fixtures.js';

const yasuo = fixture('cdragon', 'champions', '157.json');
const url = (id) => `${CDRAGON_BASE}v1/champions/${id}.json`;

function fakeFetch(routes) {
  const calls = [];
  return { calls, fetch: async (u) => { calls.push(u); return u in routes ? { status: 200, json: async () => routes[u] } : { status: 404, json: async () => ({}) }; } };
}

test('normalizeCdragonChampion maps riot enums', () => {
  assert.deepEqual(normalizeCdragonChampion(yasuo), {
    id: 157, roles: ['fighter', 'assassin'], damageType: 'physical', attackType: 'melee',
    playstyle: { damage: 3, durability: 1, crowdControl: 2, mobility: 3, utility: 2 },
  });
  assert.equal(normalizeCdragonChampion({ id: 1, tacticalInfo: { damageType: 'kMixed', attackType: 'ranged' } }).damageType, 'mixed');
  assert.equal(normalizeCdragonChampion({ id: 1 }).attackType, 'melee');
  assert.deepEqual(normalizeCdragonChampion({ id: 1 }).playstyle, { damage: null, durability: null, crowdControl: null, mobility: null, utility: null });
});

test('get fetches once, then serves memory/disk cache within 24h', async () => {
  const { fetch, calls } = fakeFetch({ [url(157)]: yasuo });
  const fs = createMemFs();
  const clock = { t: 1_000_000 };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const src = createCdragonChampions({ fetch, cache, now: () => clock.t });
  const a = await src.get(157);
  assert.equal(a.attackType, 'melee');
  await src.get(157);
  assert.equal(calls.length, 1);
  clock.t += 25 * 3600 * 1000;
  await src.get(157);
  assert.equal(calls.length, 2);
});

test('404 rejects with HttpError; stale cache is served when refetch fails', async () => {
  const fs = createMemFs();
  const clock = { t: 1_000_000 };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const good = createCdragonChampions({ fetch: fakeFetch({ [url(54)]: fixture('cdragon', 'champions', '54.json') }).fetch, cache, now: () => clock.t });
  await good.get(54);
  clock.t += 25 * 3600 * 1000;
  const logs = [];
  const bad = createCdragonChampions({ fetch: fakeFetch({}).fetch, cache, now: () => clock.t, log: (m) => logs.push(m) });
  assert.equal((await bad.get(54)).attackType, 'melee');
  assert.match(logs[0], /serving stale/);
  await assert.rejects(bad.get(99), /HTTP 404/);
});
