import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLcuClient, pickedChampion } from '../../src/game/lcu.js';

const lock = { port: 55555, password: 'secret' };
function fakeGetJson(routes) {
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => {
      calls.push([url, opts]);
      const p = new URL(url).pathname;
      if (!(p in routes)) return { status: 404, body: null };
      const v = routes[p];
      if (v instanceof Error) throw v;
      return { status: 200, body: v };
    },
  };
}

test('pickedChampion reads my cell', () => {
  const cs = { localPlayerCellId: 2, myTeam: [{ cellId: 1, championId: 1 }, { cellId: 2, championId: 157 }] };
  assert.equal(pickedChampion(cs), 157);
  assert.equal(pickedChampion({ localPlayerCellId: 2, myTeam: [{ cellId: 2, championId: 0 }] }), null);
  assert.equal(pickedChampion({}), null);
});

test('no lockfile → disconnected, no requests', async () => {
  const { getJson, calls } = fakeGetJson({});
  const lcu = createLcuClient({ readLockfile: async () => null, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: false });
  assert.equal(calls.length, 0);
});

test('champ select: phase, queue, picked champion; auth header and insecure tls', async () => {
  const { getJson, calls } = fakeGetJson({
    '/lol-gameflow/v1/gameflow-phase': 'ChampSelect',
    '/lol-gameflow/v1/session': { gameData: { queue: { id: 2400 } } },
    '/lol-champ-select/v1/session': { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 62 }] },
  });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 62 });
  assert.match(calls[0][0], /^https:\/\/127\.0\.0\.1:55555\//);
  assert.equal(calls[0][1].headers.authorization, 'Basic ' + Buffer.from('riot:secret').toString('base64'));
  assert.equal(calls[0][1].rejectUnauthorized, false);
});

test('in progress: no champ-select call; session failure leaves queue null', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'InProgress' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'InProgress', queueId: null, championId: null });
  assert.ok(!calls.some(([u]) => u.includes('champ-select')));
});

test('phase None skips session lookup', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'None' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'None', queueId: null, championId: null });
  assert.equal(calls.length, 1);
});

test('phase request failure → disconnected', async () => {
  const { getJson } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': new Error('ECONNREFUSED') });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: false });
});
