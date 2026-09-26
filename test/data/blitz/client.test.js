import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlitzClient, BLITZ_BASE } from '../../../src/data/blitz/client.js';
import { HttpError } from '../../../src/data/model.js';

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

test('championMayhem and builds hit the expected urls', async () => {
  const mayhemUrl = `${BLITZ_BASE}aram_mayhem_champion?champion_id=157`;
  const buildsUrl = `${BLITZ_BASE}champion_builds_tags?champion_id=157&queue_id=HOWLING_ABYSS_ARAM`;
  const { fetch, calls } = fakeFetch({ [mayhemUrl]: { data: [{ champion_id: '157' }] }, [buildsUrl]: { data: [] } });
  const client = createBlitzClient({ fetch, minIntervalMs: 0 });
  const mayhem = await client.championMayhem(157);
  const builds = await client.builds(157);
  assert.deepEqual(mayhem, { data: [{ champion_id: '157' }] });
  assert.deepEqual(builds, { data: [] });
  assert.deepEqual(calls, [mayhemUrl, buildsUrl]);
});

test('non-200 throws HttpError with status', async () => {
  const { fetch } = fakeFetch({});
  const client = createBlitzClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.championMayhem(1), (e) => e instanceof HttpError && e.status === 404);
});

test('throttles consecutive requests by minIntervalMs', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const u1 = `${BLITZ_BASE}aram_mayhem_champion?champion_id=1`;
  const u2 = `${BLITZ_BASE}aram_mayhem_champion?champion_id=2`;
  const { fetch } = fakeFetch({ [u1]: { data: [] }, [u2]: { data: [] } });
  const client = createBlitzClient({ fetch, now: () => t, sleep, minIntervalMs: 500 });
  await client.championMayhem(1);
  await client.championMayhem(2);
  assert.deepEqual(sleeps, [500]);
});

test('sends a user-agent header', async () => {
  let seen;
  const fetch = async (url, init) => { seen = init.headers; return { status: 200, json: async () => ({}) }; };
  const client = createBlitzClient({ fetch, minIntervalMs: 0 });
  await client.championMayhem(1);
  assert.match(seen['user-agent'], /aram-mayhem-overlay/);
});

test('dedupes concurrent requests for the same url', async () => {
  const url = `${BLITZ_BASE}aram_mayhem_champion?champion_id=157`;
  const { fetch, calls } = fakeFetch({ [url]: { ok: 1 } });
  const client = createBlitzClient({ fetch, minIntervalMs: 0 });
  const [a, b] = await Promise.all([client.championMayhem(157), client.championMayhem(157)]);
  assert.deepEqual(a, { ok: 1 });
  assert.deepEqual(b, { ok: 1 });
  assert.equal(calls.length, 1);
});

test('a failed request does not block the next one', async () => {
  const url = `${BLITZ_BASE}aram_mayhem_champion?champion_id=157`;
  const { fetch } = fakeFetch({ [url]: { a: 1 } });
  const client = createBlitzClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.championMayhem(999));
  assert.deepEqual(await client.championMayhem(157), { a: 1 });
});
