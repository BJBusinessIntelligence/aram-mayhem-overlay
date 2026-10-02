import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceGameState, sameState, createDetector } from '../../src/game/detector.js';
import { EMPTY_GAME, EMPTY_LINEUP } from '../../src/data/model.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const now = () => 99;
const OFF = { connected: false };
const reduce = (prev, snaps) => reduceGameState(prev, snaps, index, now);

test('nothing connected → none, previous champion retained, level cleared', () => {
  const prev = { ...EMPTY_GAME, phase: 'ingame', championId: 157, riotId: 'Yasuo', level: 9, stage: 2, queueId: 2400, gameMode: 'ARAM' };
  const s = reduce(prev, { lcu: OFF, live: OFF });
  assert.equal(s.phase, 'none');
  assert.equal(s.championId, 157);
  assert.equal(s.level, null);
  assert.equal(s.stage, null);
  assert.equal(s.queueId, null);
  assert.equal(s.gameMode, null);
  assert.equal(s.lcuConnected, false);
  assert.equal(s.updatedAt, 99);
});

test('live connected → ingame with champion, level, stage, gameMode', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'InProgress', queueId: 2400, championId: null }, live: { connected: true, championRiotId: 'MonkeyKing', championName: 'Wukong', level: 11, gameMode: 'ARAM' } });
  assert.equal(s.phase, 'ingame');
  assert.equal(s.championId, 62);
  assert.equal(s.riotId, 'MonkeyKing');
  assert.equal(s.level, 11);
  assert.equal(s.stage, 3);
  assert.equal(s.gameMode, 'ARAM');
  assert.equal(s.queueId, 2400);
  assert.equal(s.liveConnected, true);
});

test('live unknown champion → error and null championId', () => {
  const s = reduce(EMPTY_GAME, { lcu: OFF, live: { connected: true, championRiotId: 'NewChamp', level: 1, gameMode: 'ARAM' } });
  assert.equal(s.championId, null);
  assert.match(s.error, /unknown champion "NewChamp"/);
});

test('champ select with pick → champselect', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2450, championId: 157 }, live: OFF });
  assert.equal(s.phase, 'champselect');
  assert.equal(s.championId, 157);
  assert.equal(s.riotId, 'Yasuo');
  assert.equal(s.queueId, 2450);
});

test('champ select without pick → none but queue kept', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2400, championId: null }, live: OFF });
  assert.equal(s.phase, 'none');
  assert.equal(s.queueId, 2400);
});

test('loading: InProgress without live keeps champion from champ select', () => {
  const prev = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 157 }, live: OFF });
  const s = reduce(prev, { lcu: { connected: true, phase: 'InProgress', queueId: null, championId: null }, live: OFF });
  assert.equal(s.phase, 'loading');
  assert.equal(s.championId, 157);
  assert.equal(s.queueId, 2400, 'queue retained while not none');
});

test('sameState ignores updatedAt', () => {
  assert.equal(sameState({ ...EMPTY_GAME, updatedAt: 1 }, { ...EMPTY_GAME, updatedAt: 2 }), true);
  assert.equal(sameState({ ...EMPTY_GAME }, { ...EMPTY_GAME, level: 3 }), false);
});

test('detector tick calls onChange only when state changes', async () => {
  const changes = [];
  let liveSnap = { connected: true, championRiotId: 'Yasuo', level: 3, gameMode: 'ARAM' };
  const det = createDetector({ lcu: { snapshot: async () => OFF }, live: { snapshot: async () => liveSnap }, champIndex: index, onChange: (s) => changes.push(s), now });
  await det.tick();
  await det.tick();
  assert.equal(changes.length, 1);
  liveSnap = { ...liveSnap, level: 7 };
  await det.tick();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].stage, 2);
  assert.equal(det.getState().level, 7);
});

test('detector swallows onChange errors and keeps state', async () => {
  const det = createDetector({ lcu: { snapshot: async () => OFF }, live: { snapshot: async () => ({ connected: true, championRiotId: 'Yasuo', level: 1 }) }, champIndex: index, onChange: async () => { throw new Error('boom'); }, now });
  await det.tick();
  assert.equal(det.getState().championId, 157);
});

test('champ select lineup: held, bench, allies from LCU; rev bumps only on change', () => {
  const lcu = { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 157, champSelect: { held: 157, bench: [99, 54], allies: [1, 62, 25, 103] } };
  const a = reduce(EMPTY_GAME, { lcu, live: OFF });
  assert.deepEqual(a.lineup, { held: 157, bench: [99, 54], allies: [1, 62, 25, 103], enemies: [] });
  assert.equal(a.lineupRev, 1);
  const b = reduce(a, { lcu, live: OFF });
  assert.equal(b.lineupRev, 1);
  const c = reduce(b, { lcu: { ...lcu, championId: 99, champSelect: { held: 99, bench: [157, 54], allies: [1, 62, 25, 103] } }, live: OFF });
  assert.equal(c.lineupRev, 2);
  assert.equal(c.lineup.held, 99);
});

test('in game lineup: allies and enemies mapped through the champion index, unknown names dropped', () => {
  const live = { connected: true, championRiotId: 'MonkeyKing', level: 3, gameMode: 'ARAM', allies: ['Annie', 'Nope'], enemies: ['Lux', 'Malphite', 'Jinx'] };
  const s = reduce(EMPTY_GAME, { lcu: OFF, live });
  assert.deepEqual(s.lineup, { held: 62, bench: [], allies: [1], enemies: [99, 54, 222] });
  assert.equal(s.lineupRev, 1);
});

test('no game → EMPTY_LINEUP; sameState sees lineup changes', () => {
  const s = reduce({ ...EMPTY_GAME, lineup: { held: 1, bench: [], allies: [], enemies: [] }, lineupRev: 3 }, { lcu: OFF, live: OFF });
  assert.deepEqual(s.lineup, EMPTY_LINEUP);
  assert.equal(s.lineupRev, 4);
  assert.equal(sameState({ ...EMPTY_GAME, lineupRev: 1 }, { ...EMPTY_GAME, lineupRev: 2 }), false);
});
