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
  const c = loadConfig({ env: { PORT: '4000', POLL_MS: '500', CACHE_TTL_H: '2', PRIMARY_SOURCE: 'blitz', LOL_LOCKFILE: 'D:\\lol\\lockfile', CACHE_DIR: 'tmp/c' }, argv: [] });
  assert.equal(c.port, 4000);
  assert.equal(c.pollMs, 500);
  assert.equal(c.cacheTtlMs, 2 * 3600 * 1000);
  assert.equal(c.primarySource, 'blitz');
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

test('ocr defaults depend on platform', () => {
  assert.equal(loadConfig({ env: {}, argv: [], platform: 'win32' }).ocrEnabled, true);
  assert.equal(loadConfig({ env: {}, argv: [], platform: 'linux' }).ocrEnabled, false);
  const c = loadConfig({ env: {}, argv: [], platform: 'win32' });
  assert.equal(c.ocrIdleMs, 1500);
  assert.equal(c.ocrActiveMs, 500);
  assert.equal(c.ocrRegion, 'band');
  assert.equal(c.ocrDebug, false);
});

test('ocr overrides from env and argv', () => {
  const c = loadConfig({ env: { OCR_ENABLED: 'false', OCR_IDLE_MS: '2000', OCR_ACTIVE_MS: '250', OCR_REGION: 'full', OCR_DEBUG: '1' }, argv: [], platform: 'win32' });
  assert.equal(c.ocrEnabled, false);
  assert.equal(c.ocrIdleMs, 2000);
  assert.equal(c.ocrActiveMs, 250);
  assert.equal(c.ocrRegion, 'full');
  assert.equal(c.ocrDebug, true);
  const d = loadConfig({ env: { OCR_ENABLED: '0' }, argv: ['--ocr=true', '--ocr-debug'], platform: 'linux' });
  assert.equal(d.ocrEnabled, true);
  assert.equal(d.ocrDebug, true);
  assert.throws(() => loadConfig({ env: { OCR_REGION: 'left' }, argv: [], platform: 'win32' }), /Invalid ocr region/);
});

test('rec-debug flag and env', () => {
  assert.equal(loadConfig({}).recDebug, false);
  assert.equal(loadConfig({ argv: ['--rec-debug'] }).recDebug, true);
  assert.equal(loadConfig({ env: { REC_DEBUG: 'true' } }).recDebug, true);
  assert.equal(loadConfig({ env: { REC_DEBUG: 'false' } }).recDebug, false);
});

test('import flags', () => {
  assert.equal(loadConfig({}).importEnabled, true);
  assert.equal(loadConfig({ argv: ['--import=false'] }).importEnabled, false);
  assert.equal(loadConfig({ env: { IMPORT_ENABLED: 'off' } }).importEnabled, false);
  assert.equal(loadConfig({}).importDebug, false);
  assert.equal(loadConfig({ argv: ['--import-debug'] }).importDebug, true);
  assert.equal(loadConfig({ env: { IMPORT_DEBUG: '1' } }).importDebug, true);
});
