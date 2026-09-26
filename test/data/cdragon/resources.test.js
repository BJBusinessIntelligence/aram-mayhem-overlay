import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCdragonResources, iconUrl, rarityOf, CDRAGON_BASE } from '../../../src/data/cdragon/resources.js';
import { createCache } from '../../../src/data/cache.js';
import { HttpError } from '../../../src/data/model.js';
import { createMemFs } from '../../helpers/memfs.js';

const AUGMENTS = [{ id: 1058, nameTRA: 'Mystic Punch', rarity: 'kPrismatic', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/MysticPunch_small.png' }];
const ITEMS = [{ id: 3006, name: 'Berserker\'s Greaves', iconPath: '/lol-game-data/assets/ASSETS/Items/Icons2D/3006.png' }];
const SPELLS = [{ id: 4, name: 'Flash' }];
const CHAMPIONS = [{ id: -1, name: 'None', alias: 'None' }, { id: 157, name: 'Yasuo', alias: 'Yasuo' }];

function fakeFetch(routes = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (!(url in routes)) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => routes[url] };
  };
  return { fetch, calls };
}

// Simulates a network-level failure (timeout, DNS, connection reset), not an HTTP error status.
function rejectingFetch() {
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error('network unreachable'); };
  return { fetch, calls };
}

function urls() {
  return {
    augments: `${CDRAGON_BASE}v1/cherry-augments.json`,
    items: `${CDRAGON_BASE}v1/items.json`,
    spells: `${CDRAGON_BASE}v1/summoner-spells.json`,
    champions: `${CDRAGON_BASE}v1/champion-summary.json`,
  };
}

function routesFor(u) {
  return { [u.augments]: AUGMENTS, [u.items]: ITEMS, [u.spells]: SPELLS, [u.champions]: CHAMPIONS };
}

function setup({ fs = createMemFs(), t = 1_000_000, routes } = {}) {
  const clock = { t };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const u = urls();
  const { fetch, calls } = fakeFetch(routes ?? routesFor(u));
  const resources = createCdragonResources({ fetch, cache, now: () => clock.t });
  return { resources, cache, fs, clock, calls, u };
}

test('iconUrl strips the lol-game-data prefix and lower-cases the rest', () => {
  assert.equal(iconUrl('/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/MysticPunch_small.png'), `${CDRAGON_BASE}assets/ux/cherry/augments/icons/mysticpunch_small.png`);
  assert.equal(iconUrl(null), null);
  assert.equal(iconUrl(''), null);
});

test('rarityOf maps kPrismatic/kGold/kSilver, else unknown', () => {
  assert.equal(rarityOf('kPrismatic'), 'prismatic');
  assert.equal(rarityOf('kGold'), 'gold');
  assert.equal(rarityOf('kSilver'), 'silver');
  assert.equal(rarityOf('kWhatever'), 'unknown');
  assert.equal(rarityOf(undefined), 'unknown');
});

test('load fetches all four files and indexes them by id', async () => {
  const { resources, calls } = setup();
  const data = await resources.load();
  assert.equal(calls.length, 4);
  assert.equal(data.augmentsById[1058].nameTRA, 'Mystic Punch');
  assert.equal(data.itemsById[3006].name, "Berserker's Greaves");
  assert.equal(data.spellsById[4].name, 'Flash');
  assert.deepEqual(data.champions, CHAMPIONS);
});

test('a second load() call in the same process reuses the in-memory memo', async () => {
  const { resources, calls } = setup();
  await resources.load();
  await resources.load();
  assert.equal(calls.length, 4);
});

test('a fresh instance reads from disk cache instead of refetching', async () => {
  const fs = createMemFs();
  const a = setup({ fs });
  await a.resources.load();
  const b = setup({ fs, routes: {} }); // no routes: a network call here would 404
  const data = await b.resources.load();
  assert.equal(b.calls.length, 0);
  assert.equal(data.augmentsById[1058].nameTRA, 'Mystic Punch');
});

test('disk cache older than 24h is refetched', async () => {
  const fs = createMemFs();
  const a = setup({ fs, t: 0 });
  await a.resources.load();
  const b = setup({ fs, t: 24 * 3600_000 + 1 });
  await b.resources.load();
  assert.equal(b.calls.length, 4);
});

test('non-200 response throws HttpError', async () => {
  const { resources } = setup({ routes: {} });
  await assert.rejects(resources.load(), (e) => e instanceof HttpError && e.status === 404);
});

test('a stale (>24h) disk cache is served when the refetch fails, and the failure is logged once', async () => {
  const fs = createMemFs();
  const a = setup({ fs, t: 0 });
  await a.resources.load();

  const clock = { t: 24 * 3600_000 + 1 };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const { fetch, calls } = rejectingFetch();
  const logs = [];
  const resources = createCdragonResources({ fetch, cache, now: () => clock.t, log: (msg) => logs.push(msg) });

  const data = await resources.load();
  assert.equal(calls.length, 4, 'a refetch was attempted for every file');
  assert.equal(data.augmentsById[1058].nameTRA, 'Mystic Punch');
  assert.equal(data.itemsById[3006].name, "Berserker's Greaves");
  assert.equal(logs.length, 4, 'one log line per stale file served');
  assert.match(logs[0], /cdragon .* refetch failed, serving stale cache/);
});

test('no disk cache + refetch failure rejects', async () => {
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs: createMemFs(), now: () => 0 });
  const { fetch } = rejectingFetch();
  const resources = createCdragonResources({ fetch, cache, now: () => 0 });
  await assert.rejects(resources.load(), /network unreachable/);
});
