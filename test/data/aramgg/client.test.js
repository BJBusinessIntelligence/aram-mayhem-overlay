import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramggClient, ARAMGG_BASE } from '../../../src/data/aramgg/client.js';
import { HttpError } from '../../../src/data/model.js';

function fakeFetch(status, body = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push([url, init]); return { status, json: async () => body }; } };
}

test('config is public (no key needed)', async () => {
  const { fetch, calls } = fakeFetch(200, { dataVersion: '16.18.3' });
  const c = createAramggClient({ fetch, apiKey: null });
  assert.deepEqual(await c.config(), { dataVersion: '16.18.3' });
  assert.equal(calls[0][0], `${ARAMGG_BASE}/config.json`);
  assert.equal(calls[0][1].headers['x-api-key'], undefined);
});

test('champion needs a key and sends it', async () => {
  await assert.rejects(createAramggClient({ fetch: fakeFetch(200).fetch, apiKey: null }).champion(157), /no API key/);
  const { fetch, calls } = fakeFetch(200, { data: {} });
  await createAramggClient({ fetch, apiKey: 'hx_live_k' }).champion(157);
  assert.equal(calls[0][0], `${ARAMGG_BASE}/champions/157.json`);
  assert.equal(calls[0][1].headers['x-api-key'], 'hx_live_k');
});

test('non-200 throws HttpError; 429 starts a cooldown', async () => {
  let t = 0;
  const { fetch } = fakeFetch(429);
  const c = createAramggClient({ fetch, apiKey: 'k', now: () => t, cooldownMs: 1000 });
  await assert.rejects(c.augments(), (e) => e instanceof HttpError && e.status === 429);
  assert.equal(c.isCoolingDown(), true);
  await assert.rejects(c.items(), /cooling down/);
  t = 1000;
  assert.equal(c.isCoolingDown(), false);
  const ok = createAramggClient({ fetch: fakeFetch(404).fetch, apiKey: 'k' });
  await assert.rejects(ok.spells(), (e) => e instanceof HttpError && e.status === 404);
});
