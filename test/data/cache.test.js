import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../../src/data/cache.js';
import { createMemFs } from '../helpers/memfs.js';

function setup(ttlMs = 1000) {
  let t = 10_000;
  const fs = createMemFs();
  const cache = createCache({ dir: 'c', ttlMs, fs, now: () => t });
  return { fs, cache, tick: (ms) => { t += ms; } };
}

test('miss returns null', async () => {
  const { cache } = setup();
  assert.equal(await cache.get(['aramkit', 'all', 'champ-157']), null);
});

test('set then get is fresh and round-trips value', async () => {
  const { cache } = setup();
  await cache.set(['aramkit', 'all', 'champ-157'], { a: 1 });
  const hit = await cache.get(['aramkit', 'all', 'champ-157']);
  assert.deepEqual(hit.value, { a: 1 });
  assert.equal(hit.fetchedAt, 10_000);
  assert.equal(hit.fresh, true);
});

test('expired entry is returned with fresh=false', async () => {
  const { cache, tick } = setup(1000);
  await cache.set(['k'], 1);
  tick(1000);
  assert.equal((await cache.get(['k'])).fresh, false);
});

test('corrupt file is deleted and treated as miss', async () => {
  const { cache, fs } = setup();
  const p = cache.filePath(['k']).replace(/\\/g, '/');
  fs.files.set(p, '{not json');
  assert.equal(await cache.get(['k']), null);
  assert.equal(fs.files.has(p), false);
});

test('wrong shape is a miss', async () => {
  const { cache, fs } = setup();
  fs.files.set(cache.filePath(['k']).replace(/\\/g, '/'), JSON.stringify({ nope: 1 }));
  assert.equal(await cache.get(['k']), null);
});

test('key segments are sanitised into the path', () => {
  const { cache } = setup();
  assert.match(cache.filePath(['a/b', 'c d']).replace(/\\/g, '/'), /^c\/a_b\/c_d\.json$/);
});
