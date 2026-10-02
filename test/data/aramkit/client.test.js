import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aramkitUrls, pickLatest, createAramkitClient, VERSIONS_URL } from '../../../src/data/aramkit/client.js';
import { HttpError } from '../../../src/data/model.js';
import { fixture } from '../../helpers/fixtures.js';

const versions = fixture('aramkit', 'versions.json');
const entry = pickLatest(versions);

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => hit };
  };
  return { fetch, calls };
}

test('pickLatest returns the entry matching latest', () => {
  assert.equal(entry.version, '16.19');
  assert.equal(entry.dataPath, 'data/16.19-20260924-6f95ad08cfe5');
  assert.throws(() => pickLatest({ versions: [] }), /no versions/);
});

test('url builders', () => {
  const u = aramkitUrls(entry);
  assert.equal(u.champion(157, 'all'), 'https://data.aramkit.com/data/16.19-20260924-6f95ad08cfe5/stats/all/champion-details/157.json');
  assert.equal(u.champion(62, 'high'), 'https://data.aramkit.com/data/16.19-20260924-6f95ad08cfe5/stats/high/champion-details/62.json');
  assert.equal(u.resource('champions'), 'https://data.aramkit.com/resources/16.19-0971924da1f4/en-US/resources/champions.json');
  assert.equal(u.icon('assets/x.webp'), 'https://data.aramkit.com/assets/x.webp');
  assert.equal(u.icon(null), null);
  assert.throws(() => aramkitUrls({}), /dataPath/);
});

test('latestVersion fetches versions.json', async () => {
  const { fetch, calls } = fakeFetch({ [VERSIONS_URL]: versions });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  const e = await client.latestVersion();
  assert.equal(e.version, '16.19');
  assert.deepEqual(calls, [VERSIONS_URL]);
});

test('non-200 throws HttpError with status', async () => {
  const { fetch } = fakeFetch({});
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.champion(1, 'all', entry), (e) => e instanceof HttpError && e.status === 404);
});

test('throttles consecutive requests by minIntervalMs', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const url1 = aramkitUrls(entry).resource('items');
  const url2 = aramkitUrls(entry).resource('augments');
  const { fetch } = fakeFetch({ [url1]: { a: 1 }, [url2]: { b: 2 } });
  const client = createAramkitClient({ fetch, now: () => t, sleep, minIntervalMs: 500 });
  await client.resource('items', entry);
  await client.resource('augments', entry);
  assert.deepEqual(sleeps, [500]);
});

test('sends a user-agent header', async () => {
  let seen;
  const fetch = async (url, init) => { seen = init.headers; return { status: 200, json: async () => ({}) }; };
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await client.fetchJson('https://data.aramkit.com/x.json');
  assert.match(seen['user-agent'], /aram-mayhem-overlay/);
});

test('dedupes concurrent requests for the same url', async () => {
  const url = aramkitUrls(entry).champion(157, 'all');
  const { fetch, calls } = fakeFetch({ [url]: { ok: 1 } });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  const [a, b] = await Promise.all([client.champion(157, 'all', entry), client.champion(157, 'all', entry)]);
  assert.deepEqual(a, { ok: 1 });
  assert.deepEqual(b, { ok: 1 });
  assert.equal(calls.length, 1);
});

test('a failed request does not block the next one', async () => {
  const url = aramkitUrls(entry).resource('items');
  const { fetch } = fakeFetch({ [url]: { a: 1 } });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.fetchJson('https://data.aramkit.com/missing.json'));
  assert.deepEqual(await client.resource('items', entry), { a: 1 });
});

test('rankings and averages urls', () => {
  const u = aramkitUrls({ dataPath: 'data/v', resourcePath: 'resources/r' });
  assert.equal(u.rankings('all'), 'https://data.aramkit.com/data/v/stats/all/champion-rankings.json');
  assert.equal(u.averages('high'), 'https://data.aramkit.com/data/v/stats/high/champion-performance-averages.json');
});
