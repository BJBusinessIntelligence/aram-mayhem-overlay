import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImporter } from '../../src/import/importer.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const yasuo = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const champ = (id, name) => ({ ...yasuo, champion: { ...yasuo.champion, id, name } });

// Malformed cached champion data: an archetype without `starters`, which pickBuild dereferences.
function withBadBuild(data) {
  const broken = { ...data.build.archetypes[0] };
  delete broken.starters;
  return { ...data, build: { ...data.build, archetypes: [broken] } };
}

function setup({ phase = 'champselect', queueId = 2400, held = 157, enemies = [], enabled = true, spellsOk = true, setOk = true, failChamp = false, badBuild = false } = {}) {
  const st = { game: { phase, queueId, championId: null, lineup: { held, bench: [], allies: [], enemies } }, view: { stage: 'auto', bracket: 'all' }, context: null, statuses: [] };
  const state = { getGame: () => st.game, getView: () => st.view, getBuildContext: () => st.context, setImportStatus: (p) => st.statuses.push(p) };
  const writes = [];
  const writer = {
    setSpells: async (ids) => { writes.push(['spells', ids]); return spellsOk ? { ok: true, status: 204 } : { ok: false, status: 400, error: 'HTTP 400' }; },
    upsertItemSet: async (s) => { writes.push(['set', s.title, s.blocks.map((b) => b.type)]); return setOk ? { ok: true, status: 201 } : { ok: false, status: 500, error: 'HTTP 500' }; },
  };
  const champCalls = [];
  const repository = { getChamp: async (id, bracket) => {
    champCalls.push([id, bracket]);
    if (failChamp) throw new Error('all sources down');
    const data = champ(id, id === 157 ? 'Yasuo' : `#${id}`);
    return { data: badBuild ? withBadBuild(data) : data, stale: false, source: 'aramkit' };
  } };
  const timers = [];
  const logs = [];
  const imp = createImporter({ state, repository, writer, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, now: () => 1234, log: (m) => logs.push(m) });
  imp.setEnabled(enabled);
  return { imp, st, writes, timers, logs, champCalls };
}

test('champ select: first tick writes spells then the item set; unchanged snapshot writes nothing more', async () => {
  const { imp, writes, st, logs } = setup();
  await imp.tick();
  assert.deepEqual(writes, [['spells', [32, 4]], ['set', 'AMO · Yasuo', ['Start', 'Boots', 'Core (in order)', 'Later']]]);
  await imp.tick();
  assert.equal(writes.length, 2);
  const last = st.statuses.at(-1);
  assert.equal(last.lastChampion, 'Yasuo'); assert.equal(last.lastSpells, 'Mark + Flash'); assert.equal(last.lastItemSetAt, 1234); assert.equal(last.lastError, null);
  assert.ok(logs.some((m) => /\[import\] spells Mark \+ Flash for Yasuo/.test(m)));
  assert.ok(logs.some((m) => /\[import\] item set AMO · Yasuo \(4 blocks\)/.test(m)));
});

test('held change (hover or swap) re-imports; in game only the item set is written, with the situational block', async () => {
  const { imp, writes, st } = setup();
  await imp.tick();
  st.game = { ...st.game, lineup: { ...st.game.lineup, held: 99 } };
  await imp.tick();
  assert.deepEqual(writes.slice(2).map((w) => w[0]), ['spells', 'set']);
  st.game = { ...st.game, phase: 'ingame', championId: 99, lineup: { held: 99, bench: [], allies: [1, 2, 3, 4], enemies: [5, 6, 7, 8, 9] } };
  st.context = { allies: [], enemies: [], itemCategories: {} };
  await imp.tick();
  const w = writes.at(-1);
  assert.equal(w[0], 'set');
  assert.equal(writes.filter((x) => x[0] === 'spells').length, 2, 'no spell write in game');
  await imp.tick();
  assert.equal(writes.length, 5);
});

test('idle when disabled, out of phase, or without a held champion', async () => {
  const off = setup({ enabled: false }); await off.imp.tick(); assert.equal(off.writes.length, 0);
  const none = setup({ phase: 'none' }); await none.imp.tick(); assert.equal(none.writes.length, 0);
  const loading = setup({ phase: 'loading' }); await loading.imp.tick(); assert.equal(loading.writes.length, 0);
  const noHeld = setup({ held: null }); await noHeld.imp.tick(); assert.equal(noHeld.writes.length, 0);
});

test('idle outside the Mayhem queues: no writes and no champion fetch', async () => {
  const other = setup({ queueId: 420 });
  await other.imp.tick();
  assert.equal(other.writes.length, 0);
  assert.equal(other.champCalls.length, 0, 'the queue is checked before any fetch');
  const unknown = setup({ queueId: null });
  await unknown.imp.tick();
  assert.equal(unknown.writes.length, 0);
  assert.equal(unknown.champCalls.length, 0);
  const mayhemClassic = setup({ queueId: 2450 });
  await mayhemClassic.imp.tick();
  assert.equal(mayhemClassic.writes.length, 2, 'Mayhem Classic imports like ARAM Mayhem');
});

test('leaving champ select clears what was written, so a dodge and re-queue imports again', async () => {
  const { imp, writes, st } = setup();
  await imp.tick();
  assert.equal(writes.length, 2);
  st.game = { ...st.game, phase: 'none', queueId: null, lineup: { held: null, bench: [], allies: [], enemies: [] } };
  await imp.tick();
  assert.equal(writes.length, 2, 'nothing is written out of phase');
  st.game = { ...st.game, phase: 'champselect', queueId: 2400, lineup: { held: 157, bench: [], allies: [], enemies: [] } };
  await imp.tick();
  assert.deepEqual(writes.slice(2).map((w) => w[0]), ['spells', 'set'], 'the same champion is re-imported');
});

test('a failed write reports the error and is retried only once the plan changes', async () => {
  const { imp, writes, st } = setup({ spellsOk: false });
  await imp.tick();
  assert.equal(st.statuses.at(-1).lastError, 'spells: HTTP 400');
  assert.deepEqual(writes.map((w) => w[0]), ['spells', 'set'], 'a failed spells write still lets the item set through');
  await imp.tick();
  assert.equal(writes.length, 2, 'no retry and no re-PUT while nothing has changed');
  st.game = { ...st.game, lineup: { ...st.game.lineup, held: 99 } };
  await imp.tick();
  assert.deepEqual(writes.slice(2).map((w) => w[0]), ['spells', 'set'], 'a changed champion writes again');
});

test('each write has its own fingerprint: a failed spells write does not re-PUT the item set', async () => {
  const { imp, writes } = setup({ spellsOk: false, setOk: true });
  await imp.tick();
  assert.equal(writes.length, 2);
  await imp.tick();
  assert.equal(writes.length, 2, 'the second tick writes nothing at all');
});

test('an unchanged snapshot does not even fetch the champion; any input change does', async () => {
  const { imp, st, champCalls } = setup();
  await imp.tick();
  await imp.tick();
  assert.equal(champCalls.length, 1, 'the second tick stops before the repository');
  st.game = { ...st.game, lineup: { ...st.game.lineup, held: 99 } };
  await imp.tick();
  assert.equal(champCalls.length, 2, 'a changed held champion fetches again');
  st.context = { allies: [], enemies: [], itemCategories: {} };
  await imp.tick();
  assert.equal(champCalls.length, 3, 'a rebuilt build context fetches again');
  await imp.tick();
  assert.equal(champCalls.length, 3, 'the same context object does not');
});

test('champion data failure is reported, never thrown, and not re-fetched until something changes', async () => {
  const { imp, st, writes, champCalls } = setup({ failChamp: true });
  await imp.tick();
  assert.equal(writes.length, 0);
  assert.match(st.statuses.at(-1).lastError, /all sources down/);
  await imp.tick();
  assert.equal(champCalls.length, 1, 'a champion without data is not re-fetched every second');
});

test('an unexpected failure while planning reaches the status instead of rejecting the tick', async () => {
  const { imp, st, writes, logs } = setup({ badBuild: true });
  await imp.tick();
  assert.equal(writes.length, 0);
  assert.match(st.statuses.at(-1).lastError, /^tick: /);
  assert.ok(logs.some((m) => /^\[import\] tick failed: /.test(m)));
  await imp.tick();
  assert.equal(writes.length, 0, 'still not wedged by the busy flag');
});

test('disable then re-enable re-imports the same lineup; start/stop manage the timer and running flag', async () => {
  const { imp, writes, timers, st } = setup();
  await imp.tick();
  imp.setEnabled(false); imp.setEnabled(true);
  await imp.tick();
  assert.equal(writes.length, 4);
  imp.start();
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1000);
  assert.equal(st.statuses.at(-1).running, true);
  imp.stop();
  assert.equal(st.statuses.at(-1).running, false);
});
