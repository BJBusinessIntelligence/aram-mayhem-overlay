import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLcuClient, pickedChampion, extractChampSelect } from '../../src/game/lcu.js';
import { fixture } from '../helpers/fixtures.js';

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
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 62, champSelect: { held: 62, bench: [], allies: [], picking: false } });
  assert.match(calls[0][0], /^https:\/\/127\.0\.0\.1:55555\//);
  assert.equal(calls[0][1].headers.authorization, 'Basic ' + Buffer.from('riot:secret').toString('base64'));
  assert.equal(calls[0][1].rejectUnauthorized, false);
});

test('in progress: no champ-select call; session failure leaves queue null', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'InProgress' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'InProgress', queueId: null, championId: null, champSelect: null });
  assert.ok(!calls.some(([u]) => u.includes('champ-select')));
});

test('phase None skips session lookup', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'None' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'None', queueId: null, championId: null, champSelect: null });
  assert.equal(calls.length, 1);
});

test('phase request failure → disconnected', async () => {
  const { getJson } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': new Error('ECONNREFUSED') });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: false });
});

test('extractChampSelect: held, bench without empty slots, allies without me', () => {
  const cs = fixture('lcu', 'champ-select-session.json');
  assert.deepEqual(extractChampSelect(cs), { held: 27, bench: [91, 8, 114, 43, 875, 33, 157], allies: [40, 901, 805, 111], picking: false });
  assert.deepEqual(extractChampSelect({}), { held: null, bench: [], allies: [], picking: false });
  assert.deepEqual(extractChampSelect({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 0 }, { cellId: 1, championId: 0 }] }), { held: null, bench: [], allies: [], picking: false });
});

test('snapshot in champ select carries champSelect; other phases carry null', async () => {
  const cs = fixture('lcu', 'champ-select-session.json');
  const { getJson } = fakeGetJson({
    '/lol-gameflow/v1/gameflow-phase': 'ChampSelect',
    '/lol-gameflow/v1/session': { gameData: { queue: { id: 2400 } } },
    '/lol-champ-select/v1/session': cs,
  });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  const s = await lcu.snapshot();
  assert.equal(s.championId, 27);
  assert.deepEqual(s.champSelect, { held: 27, bench: [91, 8, 114, 43, 875, 33, 157], allies: [40, 901, 805, 111], picking: false });
  const { getJson: g2 } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'InProgress' });
  assert.equal((await createLcuClient({ readLockfile: async () => lock, getJson: g2 }).snapshot()).champSelect, null);
});

const SUBSET = [77, 86, 35, 62, 102, 157, 526, 92];

test('opening pick: nobody locked → picking, bench is the offered subset, no allies yet', () => {
  const cs = fixture('lcu', 'champ-select-pick-phase.json');
  assert.deepEqual(extractChampSelect(cs, SUBSET), { held: null, bench: SUBSET, allies: [], picking: true });
});

test('opening pick: my hover is held, allies are their locks or hovers, hover removed from the subset', () => {
  const cs = fixture('lcu', 'champ-select-pick-hover.json');
  assert.deepEqual(extractChampSelect(cs, SUBSET), { held: 77, bench: [86, 35, 62, 102, 157, 526, 92], allies: [35, 86], picking: true });
});

test('after locking in BAN_PICK the bench comes from benchChampions again', () => {
  const cs = fixture('lcu', 'champ-select-pick-hover.json');
  const me = cs.myTeam.find((p) => p.cellId === cs.localPlayerCellId);
  me.championId = 77;
  cs.benchChampions = [{ championId: 157 }, { championId: 526 }];
  assert.deepEqual(extractChampSelect(cs, SUBSET), { held: 77, bench: [157, 526], allies: [35, 86], picking: false });
});

test('snapshot reads the team-builder subset list in champ select (object or array form; 404 → none)', async () => {
  const cs = fixture('lcu', 'champ-select-pick-phase.json');
  const base = { '/lol-gameflow/v1/gameflow-phase': 'ChampSelect', '/lol-gameflow/v1/session': { gameData: { queue: { id: 2400 } } }, '/lol-champ-select/v1/session': cs };
  const obj = createLcuClient({ readLockfile: async () => lock, getJson: fakeGetJson({ ...base, '/lol-lobby-team-builder/champ-select/v1/subset-champion-list': { subsetChampionIds: SUBSET } }).getJson });
  let s = await obj.snapshot();
  assert.equal(s.championId, null);
  assert.deepEqual(s.champSelect, { held: null, bench: SUBSET, allies: [], picking: true });
  const arr = createLcuClient({ readLockfile: async () => lock, getJson: fakeGetJson({ ...base, '/lol-lobby-team-builder/champ-select/v1/subset-champion-list': SUBSET }).getJson });
  assert.deepEqual((await arr.snapshot()).champSelect.bench, SUBSET);
  const none = createLcuClient({ readLockfile: async () => lock, getJson: fakeGetJson(base).getJson });
  s = await none.snapshot();
  assert.deepEqual(s.champSelect, { held: null, bench: [], allies: [], picking: true });
});
