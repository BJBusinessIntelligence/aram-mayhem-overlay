import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppState, buildPayload } from '../../src/server/state.js';
import { EMPTY_GAME } from '../../src/data/model.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const yasuo = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', dataDate: '2026-09-24', bracket: 'all', fetchedAt: 5 });

function fakeRepo({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getChamp(id, bracket, opts = {}) {
      calls.push([id, bracket, !!opts.force]);
      if (fail) throw new Error('all sources down');
      return { data: { ...yasuo, bracket, champion: { ...yasuo.champion, id } }, stale: false, source: 'aramkit' };
    },
  };
}

const game = (over) => ({ ...EMPTY_GAME, ...over });

test('buildPayload with no data', () => {
  const p = buildPayload({ game: EMPTY_GAME, loading: false, champData: null, view: { stage: 'auto', bracket: 'all' }, source: null, stale: false, errors: [] });
  assert.equal(p.champ, null);
  assert.equal(p.augments, null);
  assert.equal(p.build, null);
  assert.equal(p.meta, null);
  assert.equal(p.view.stageUsed, null);
});

test('buildPayload shapes augments by game level', () => {
  const p = buildPayload({ game: game({ level: 11 }), loading: false, champData: yasuo, view: { stage: 'auto', bracket: 'all' }, source: 'aramkit', stale: true, errors: [] });
  assert.equal(p.view.stageUsed, 3);
  assert.equal(p.champ.name, 'Yasuo');
  assert.equal(p.champ.source, 'aramkit');
  assert.equal(p.build.primary.key, 'crit');
  assert.equal(p.meta.stale, true);
  assert.equal(p.meta.version, '16.19');
  assert.ok(p.augments.columns.prismatic.length > 0);
});

test('setGame with a champion loads once; same champion again does not reload', async () => {
  const repo = fakeRepo();
  const s = createAppState({ repository: repo, now: () => 1 });
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 3 }));
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 4 }));
  assert.deepEqual(repo.calls, [[157, 'all', false]]);
  const p = s.snapshot();
  assert.equal(p.champ.id, 157);
  assert.equal(p.loading, false);
  assert.equal(p.game.level, 4);
});

test('bracket change reloads; stage change does not', async () => {
  const repo = fakeRepo();
  const s = createAppState({ repository: repo });
  await s.setGame(game({ championId: 157 }));
  await s.setView({ stage: 2 });
  await s.setView({ bracket: 'high' });
  assert.deepEqual(repo.calls, [[157, 'all', false], [157, 'high', false]]);
  assert.equal(s.snapshot().view.stage, 2);
  assert.equal(s.snapshot().meta.bracket, 'high');
});

test('refresh forces a reload', async () => {
  const repo = fakeRepo();
  const s = createAppState({ repository: repo });
  await s.setGame(game({ championId: 157 }));
  await s.refresh();
  assert.deepEqual(repo.calls.at(-1), [157, 'all', true]);
});

test('load failure records an error and leaves champ null', async () => {
  const s = createAppState({ repository: fakeRepo({ fail: true }), now: () => 7 });
  await s.setGame(game({ championId: 157 }));
  const p = s.snapshot();
  assert.equal(p.champ, null);
  assert.equal(p.errors[0].scope, 'data');
  assert.match(p.errors[0].message, /all sources down/);
  assert.equal(p.errors[0].at, 7);
});

test('game error is recorded once per distinct message', async () => {
  const s = createAppState({ repository: fakeRepo() });
  await s.setGame(game({ error: 'unknown champion "X"' }));
  await s.setGame(game({ error: 'unknown champion "X"' }));
  assert.equal(s.snapshot().errors.length, 1);
});

test('errors ring buffer keeps the newest maxErrors', () => {
  const s = createAppState({ repository: fakeRepo(), maxErrors: 2 });
  s.pushError('a', '1'); s.pushError('a', '2'); s.pushError('a', '3');
  assert.deepEqual(s.snapshot().errors.map((e) => e.message), ['3', '2']);
});

test('champion change while a load is pending keeps only the newest result', async () => {
  let resolveFirst;
  const repo = { async getChamp(id) { if (id === 1) return new Promise((r) => { resolveFirst = () => r({ data: { ...yasuo, champion: { ...yasuo.champion, id: 1 } }, stale: false, source: 'aramkit' }); }); return { data: { ...yasuo, champion: { ...yasuo.champion, id } }, stale: false, source: 'aramkit' }; } };
  const s = createAppState({ repository: repo });
  const first = s.setGame(game({ championId: 1 }));
  await s.setGame(game({ championId: 2 }));
  resolveFirst();
  await first;
  assert.equal(s.snapshot().champ.id, 2);
});

test('preview returns a payload for any champion without touching game state', async () => {
  const repo = fakeRepo();
  const s = createAppState({ repository: repo });
  const p = await s.preview(62, { bracket: 'all', stage: 'all' });
  assert.equal(p.champ.id, 62);
  assert.equal(p.view.stageUsed, 'all');
  assert.equal(s.snapshot().champ, null);
});

test('payload carries offer and ocr with safe defaults', () => {
  const p = buildPayload({ game: EMPTY_GAME, loading: false, champData: null, view: { stage: 'auto', bracket: 'all' }, source: null, stale: false, errors: [] });
  assert.equal(p.offer, null);
  assert.deepEqual(p.ocr, { enabled: false, running: false, lastCaptureMs: null, lastCaptureAt: null, lastError: null });
});

test('setOffer shows in snapshot and clears when the phase leaves ingame', async () => {
  const s = createAppState({ repository: fakeRepo() });
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 7 }));
  const offer = { detectedAt: 1, cards: [], pickSlot: null, note: null };
  s.setOffer(offer);
  assert.equal(s.snapshot().offer, offer);
  assert.equal(s.getOffer(), offer);
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 8 }));
  assert.equal(s.snapshot().offer, offer, 'level change keeps the offer');
  await s.setGame(game({ phase: 'none', championId: 157 }));
  assert.equal(s.snapshot().offer, null);
});

test('setOcrStatus merges partial updates', () => {
  const s = createAppState({ repository: fakeRepo() });
  s.setOcrStatus({ enabled: true });
  s.setOcrStatus({ lastCaptureMs: 210, lastError: 'x' });
  assert.deepEqual(s.snapshot().ocr, { enabled: true, running: false, lastCaptureMs: 210, lastCaptureAt: null, lastError: 'x' });
});

test('getChampData returns data only for the current champion', async () => {
  const s = createAppState({ repository: fakeRepo() });
  assert.equal(s.getChampData(), null);
  await s.setGame(game({ championId: 157 }));
  assert.equal(s.getChampData().champion.id, 157);
  await s.setGame(game({ championId: 62 }));
  assert.equal(s.getChampData().champion.id, 62);
});
