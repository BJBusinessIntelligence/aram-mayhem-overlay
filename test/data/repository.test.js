import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../src/data/repository.js';
import { createCache } from '../../src/data/cache.js';
import { DataUnavailable } from '../../src/data/model.js';
import { createMemFs } from '../helpers/memfs.js';

function fakeAdapter(name, { enabled = true, version = 'v1', brackets = ['all', 'high'], fail = false, delayMs = 0 } = {}) {
  const calls = [];
  return {
    name, enabled, calls,
    supportsBracket: (b) => brackets.includes(b),
    supportsStages: () => true,
    async version() { if (fail === 'version') throw new Error('version down'); return version; },
    async champion(id, bracket) {
      calls.push([id, bracket]);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail === true) throw new Error(`${name} down`);
      return { source: name, sourceVersion: version, bracket, champion: { id }, augments: { all: [{ id: 1 }], stages: {} } };
    },
  };
}

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const fs = createMemFs();
  const cache = createCache({ dir: 'c', ttlMs: 1000, fs, now: () => clock.t });
  const primary = opts.primary ?? fakeAdapter('aramkit');
  const fallback = opts.fallback === undefined ? fakeAdapter('aramgg', { brackets: ['all'] }) : opts.fallback;
  return { repo: createRepository({ primary, fallback, cache }), primary, fallback, cache, clock };
}

test('primary hit is cached; second call does not refetch', async () => {
  const { repo, primary } = setup();
  const r1 = await repo.getChamp(157, 'all');
  assert.equal(r1.source, 'aramkit');
  assert.equal(r1.stale, false);
  const r2 = await repo.getChamp(157, 'all');
  assert.equal(r2.data.champion.id, 157);
  assert.equal(primary.calls.length, 1);
});

test('force bypasses cache', async () => {
  const { repo, primary } = setup();
  await repo.getChamp(157, 'all');
  await repo.getChamp(157, 'all', { force: true });
  assert.equal(primary.calls.length, 2);
});

test('expired cache refetches; version mismatch refetches', async () => {
  const { repo, primary, clock } = setup();
  await repo.getChamp(157, 'all');
  clock.t += 1000;
  await repo.getChamp(157, 'all');
  assert.equal(primary.calls.length, 2);
});

test('primary failure → fallback, bracket downgraded to all', async () => {
  const { repo, fallback } = setup({ primary: fakeAdapter('aramkit', { fail: true }) });
  const r = await repo.getChamp(157, 'high');
  assert.equal(r.source, 'aramgg');
  assert.deepEqual(fallback.calls, [[157, 'all']]);
  assert.equal(r.data.bracket, 'all');
});

test('primary version failure → fallback', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: 'version' }) });
  assert.equal((await repo.getChamp(157, 'all')).source, 'aramgg');
});

test('disabled fallback is skipped', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: true }), fallback: fakeAdapter('aramgg', { enabled: false }) });
  await assert.rejects(repo.getChamp(157, 'all'), DataUnavailable);
});

test('both fail with stale cache → stale result with errors', async () => {
  const primary = fakeAdapter('aramkit');
  const { repo, clock } = setup({ primary, fallback: null });
  await repo.getChamp(157, 'all');
  primary.champion = async () => { throw new Error('aramkit down'); };
  clock.t += 5000;
  const r = await repo.getChamp(157, 'all');
  assert.equal(r.stale, true);
  assert.equal(r.source, 'aramkit');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /aramkit: aramkit down/);
});

test('both fail without cache → DataUnavailable listing both', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: true }), fallback: fakeAdapter('aramgg', { fail: true }) });
  await assert.rejects(repo.getChamp(157, 'all'), (e) => e instanceof DataUnavailable && e.errors.length === 2);
});

test('concurrent calls for same champ share one fetch', async () => {
  const { repo, primary } = setup({ primary: fakeAdapter('aramkit', { delayMs: 5 }) });
  await Promise.all([repo.getChamp(157, 'all'), repo.getChamp(157, 'all')]);
  assert.equal(primary.calls.length, 1);
});
