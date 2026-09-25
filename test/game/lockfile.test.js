import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile, readLockfile } from '../../src/game/lockfile.js';
import { createMemFs } from '../helpers/memfs.js';

test('parses the five colon-separated fields', () => {
  assert.deepEqual(parseLockfile('LeagueClient:1234:52345:abcDEF-xyz:https\n'), { name: 'LeagueClient', pid: 1234, port: 52345, password: 'abcDEF-xyz', protocol: 'https' });
});

test('rejects malformed content', () => {
  assert.throws(() => parseLockfile('garbage'), /malformed/);
  assert.throws(() => parseLockfile('LeagueClient:1:notaport:pw:https'), /malformed/);
  assert.throws(() => parseLockfile('LeagueClient:1:1000::https'), /malformed/);
});

test('readLockfile returns null when missing, empty, or unreadable', async () => {
  assert.equal(await readLockfile('C:/x/lockfile', { fs: createMemFs() }), null);
  assert.equal(await readLockfile('C:/x/lockfile', { fs: createMemFs({ 'C:/x/lockfile': '   ' }) }), null);
  const busy = { readFile: async () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } };
  assert.equal(await readLockfile('C:/x/lockfile', { fs: busy }), null);
});

test('readLockfile parses an existing file', async () => {
  const fs = createMemFs({ 'C:/Riot Games/League of Legends/lockfile': 'LeagueClient:9:60000:pw:https' });
  const lock = await readLockfile('C:\\Riot Games\\League of Legends\\lockfile', { fs });
  assert.equal(lock.port, 60000);
  assert.equal(lock.password, 'pw');
});
