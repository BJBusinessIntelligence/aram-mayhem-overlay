import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripChampionPrefix, extractActive, createLiveClient, LIVE_URL } from '../../src/game/liveclient.js';
import { fixture } from '../helpers/fixtures.js';

const data = fixture('liveclient', 'allgamedata.json');

test('stripChampionPrefix', () => {
  assert.equal(stripChampionPrefix('game_character_displayname_MonkeyKing'), 'MonkeyKing');
  assert.equal(stripChampionPrefix('Yasuo'), 'Yasuo');
  assert.equal(stripChampionPrefix(null), null);
});

test('extractActive matches by riotId and splits teams', () => {
  assert.deepEqual(extractActive(data), {
    championRiotId: 'MonkeyKing', championName: 'Wukong', level: 7, gameMode: 'ARAM',
    allies: ['Annie'], enemies: ['Lux', 'Malphite', 'Jinx'],
  });
});

test('extractActive falls back to summonerName and tolerates missing fields', () => {
  const d = JSON.parse(JSON.stringify(data));
  delete d.activePlayer.riotId;
  delete d.allPlayers[1].riotId;
  delete d.activePlayer.level;
  delete d.gameData;
  assert.deepEqual(extractActive(d), { championRiotId: 'MonkeyKing', championName: 'Wukong', level: null, gameMode: null, allies: ['Annie'], enemies: ['Lux', 'Malphite', 'Jinx'] });
  assert.equal(extractActive({}), null);
  assert.equal(extractActive({ activePlayer: { riotId: 'x' }, allPlayers: [] }), null);
});

test('snapshot connected', async () => {
  const calls = [];
  const live = createLiveClient({ getJson: async (url, opts) => { calls.push([url, opts]); return { status: 200, body: data }; } });
  const s = await live.snapshot();
  assert.equal(s.connected, true);
  assert.equal(s.championRiotId, 'MonkeyKing');
  assert.equal(s.level, 7);
  assert.equal(calls[0][0], LIVE_URL);
  assert.equal(calls[0][1].rejectUnauthorized, false);
});

test('snapshot disconnected on error, non-200, or no active player', async () => {
  assert.deepEqual(await createLiveClient({ getJson: async () => { throw new Error('ECONNREFUSED'); } }).snapshot(), { connected: false });
  assert.deepEqual(await createLiveClient({ getJson: async () => ({ status: 404, body: null }) }).snapshot(), { connected: false });
  assert.deepEqual(await createLiveClient({ getJson: async () => ({ status: 200, body: {} }) }).snapshot(), { connected: false });
});
