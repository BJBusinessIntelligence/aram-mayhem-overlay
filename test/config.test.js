import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseArgs, DEFAULTS } from '../src/config.js';

test('defaults when nothing given', () => {
  const c = loadConfig({ env: {}, argv: [] });
  assert.equal(c.port, 3777);
  assert.equal(c.pollMs, 2000);
  assert.equal(c.cacheTtlMs, 24 * 3600 * 1000);
  assert.equal(c.primarySource, 'aramkit');
  assert.equal(c.open, false);
  assert.match(c.lockfilePath, /lockfile$/);
  assert.equal(c.cacheDir, DEFAULTS.cacheDir);
});

test('env overrides defaults', () => {
  const c = loadConfig({ env: { PORT: '4000', POLL_MS: '500', CACHE_TTL_H: '2', PRIMARY_SOURCE: 'aramkit', LOL_LOCKFILE: 'D:\\lol\\lockfile', CACHE_DIR: 'tmp/c' }, argv: [] });
  assert.equal(c.port, 4000);
  assert.equal(c.pollMs, 500);
  assert.equal(c.cacheTtlMs, 2 * 3600 * 1000);
  assert.equal(c.primarySource, 'aramkit');
  assert.equal(c.lockfilePath, 'D:\\lol\\lockfile');
  assert.equal(c.cacheDir, 'tmp/c');
});

test('argv beats env, both forms', () => {
  const c = loadConfig({ env: { PORT: '4000' }, argv: ['--port=5000', '--poll-ms', '750', '--open'] });
  assert.equal(c.port, 5000);
  assert.equal(c.pollMs, 750);
  assert.equal(c.open, true);
});

test('parseArgs handles = and space and bare flags', () => {
  assert.deepEqual(parseArgs(['--a=1', '--b', '2', '--c', '--d=x=y']), { a: '1', b: '2', c: 'true', d: 'x=y' });
});

test('invalid numbers and sources throw', () => {
  assert.throws(() => loadConfig({ env: { PORT: 'abc' }, argv: [] }), /Invalid port/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--port=0'] }), /Invalid port/);
  assert.throws(() => loadConfig({ env: { PRIMARY_SOURCE: 'opgg' }, argv: [] }), /Invalid primary source/);
  assert.throws(() => loadConfig({ env: { PRIMARY_SOURCE: 'aramgg' }, argv: [] }), /Invalid primary source/);
});
