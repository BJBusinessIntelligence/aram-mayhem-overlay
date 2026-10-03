import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppState, buildPayload, EMPTY_IMPORT } from '../../src/server/state.js';
import { EMPTY_GAME } from '../../src/data/model.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';

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

// `delays` gives a per-call delay (consumed in order) so a later compute can resolve first.
function fakeRecommender({ delayMs = 0, delays = null, fail = false } = {}) {
  const calls = [];
  const queue = delays ? delays.slice() : null;
  return {
    calls,
    async compute(input) {
      calls.push(input);
      const wait = queue ? queue.shift() ?? 0 : delayMs;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (fail) throw new Error('recommender exploded');
      const p = (id) => ({ ...EMPTY_PROFILE(id, `C${id}`), frontline: 0 });
      return {
        recommend: { context: input.enemies.length ? 'ingame' : 'champselect', team: { knownAllies: input.allies.length, bracket: input.bracket, coverage: {}, physicalShare: 0.5 }, candidates: [{ id: input.held, held: true, score: 50, reasons: [], warnings: [] }], warnings: [] },
        profiles: { allies: input.allies.map(p), enemies: input.enemies.map(p) },
        itemCategories: {},
      };
    },
  };
}
const lineup = (over) => ({ held: 157, bench: [99], allies: [1, 62, 25, 103], enemies: [], ...over });

test('recommend: computed on lineup change, carried in snapshot with rev, build gets context', async () => {
  const rec = fakeRecommender();
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  let p = s.snapshot();
  assert.equal(p.recommend.rev, 1);
  assert.equal(p.recommend.context, 'champselect');
  assert.equal(p.build.context, 'allies');
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1, level: null }));
  assert.equal(rec.calls.length, 1, 'same rev → no recompute');
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 3, lineup: lineup({ bench: [], enemies: [99, 54, 222, 40, 21] }), lineupRev: 2 }));
  p = s.snapshot();
  assert.equal(rec.calls.length, 2);
  assert.equal(p.recommend.rev, 2);
  assert.equal(p.build.context, 'both');
  await s.setGame(game({ phase: 'none' }));
  assert.equal(s.snapshot().recommend, null);
  assert.equal(s.snapshot().build, null);
});

test('recommend: a late result for an older lineup is dropped', async () => {
  // rev 1's compute is slower (~40ms) than rev 2's (~5ms), so rev 2 finishes first and
  // rev 1's late result must be dropped by the superseded-lineupRev guard, not by timing luck.
  const rec = fakeRecommender({ delays: [40, 5] });
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  const first = s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  const second = s.setGame(game({ phase: 'champselect', championId: 99, lineup: lineup({ held: 99, bench: [157] }), lineupRev: 2 }));
  await Promise.all([first, second]);
  assert.equal(s.snapshot().recommend.rev, 2);
  assert.equal(s.snapshot().recommend.candidates[0].id, 99);
});

test('recommend: failure records an error and leaves recommend null', async () => {
  const s = createAppState({ repository: fakeRepo(), recommender: fakeRecommender({ fail: true }) });
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  assert.equal(s.snapshot().recommend, null);
  assert.equal(s.snapshot().errors[0].scope, 'recommend');
});

test('previewRecommend does not touch game state and returns build with context', async () => {
  const rec = fakeRecommender();
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  const r = await s.previewRecommend({ held: 157, bench: [99], allies: [1, 62], enemies: [54] });
  assert.equal(r.recommend.preview, true);
  assert.equal(r.recommend.rev, null);
  assert.equal(r.build.context, 'both');
  assert.equal(s.snapshot().recommend, null);
});

test('without a recommender the payload has recommend null and build context none', async () => {
  const s = createAppState({ repository: fakeRepo() });
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  assert.equal(s.snapshot().recommend, null);
  assert.equal(s.snapshot().build.context, 'none');
});

test('recommend: recomputed only when the bracket actually changes', async () => {
  const rec = fakeRecommender();
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  assert.equal(rec.calls.length, 1);
  await s.setView({ bracket: 'all' });
  assert.equal(rec.calls.length, 1, 'same bracket → no recompute');
  await s.setView({ bracket: 'high' });
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[1].bracket, 'high');
  assert.equal(s.snapshot().recommend.team.bracket, 'high');
  await s.setView({ stage: 2 });
  assert.equal(rec.calls.length, 2, 'stage change → no recompute');
});

test('recommend: two bracket recomputes at the same lineupRev keep the newest result', async () => {
  const rec = fakeRecommender({ delays: [0, 40, 5] });
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  await s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  const high = s.setView({ bracket: 'high' });
  const back = s.setView({ bracket: 'all' });
  await Promise.all([high, back]);
  assert.deepEqual(rec.calls.map((c) => c.bracket), ['all', 'high', 'all']);
  assert.equal(s.snapshot().recommend.team.bracket, 'all', 'the slower earlier compute must not win');
});

test('recommend: clearing on phase none invalidates an in-flight compute', async () => {
  const rec = fakeRecommender({ delayMs: 30 });
  const s = createAppState({ repository: fakeRepo(), recommender: rec });
  const pending = s.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  // same lineupRev, so only the clear itself can invalidate the compute already in flight
  await s.setGame(game({ phase: 'none', lineup: lineup(), lineupRev: 1 }));
  await pending;
  assert.equal(s.snapshot().recommend, null);
  assert.equal(s.snapshot().build, null);
});

test('payload carries import status with safe defaults; setImportStatus merges; getBuildContext exposes the stored context', async () => {
  const s = createAppState({ repository: fakeRepo() });
  assert.deepEqual(s.snapshot().import, EMPTY_IMPORT);
  s.setImportStatus({ enabled: true, lastChampion: 'Yasuo' });
  assert.equal(s.snapshot().import.enabled, true);
  assert.equal(s.snapshot().import.lastChampion, 'Yasuo');
  assert.equal(s.snapshot().import.lastError, null);
  assert.equal(s.getBuildContext(), null);
  const rec = fakeRecommender();
  const s2 = createAppState({ repository: fakeRepo(), recommender: rec });
  await s2.setGame(game({ phase: 'champselect', championId: 157, lineup: lineup(), lineupRev: 1 }));
  assert.equal(s2.getBuildContext().allies.length, 4);
});
