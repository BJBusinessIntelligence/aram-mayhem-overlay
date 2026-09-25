import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceGameState, sameState, createDetector } from '../../src/game/detector.js';
import { EMPTY_GAME } from '../../src/data/model.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const now = () => 99;
const OFF = { connected: false };
const reduce = (prev, snaps) => reduceGameState(prev, snaps, index, now);

test('nothing connected → none, previous champion retained, level cleared', () => {
  const prev = { ...EMPTY_GAME, phase: 'ingame', championId: 157, riotId: 'Yasuo', level: 9, stage: 2, queueId: 2400 };
  const s = reduce(prev, { lcu: OFF, live: OFF });
  assert.equal(s.phase, 'none');
  assert.equal(s.championId, 157);
  assert.equal(s.level, null);
  assert.equal(s.stage, null);
  assert.equal(s.queueId, null);
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
