import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createOfferWatcher, createAugmentIndexMemo } from '../../src/ocr/watcher.js';

const FRAME = { w: 3440, h: 1440 };
const rows = [
  { id: 1, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1, winRate: 0.65, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 2, name: 'Final Form', rarity: 'prismatic', tier: 'B', rank: 2, winRate: 0.55, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 3, name: 'Clown College', rarity: 'prismatic', tier: 'D', rank: 3, winRate: 0.45, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 4, name: 'Zealot', rarity: 'gold', tier: 'A', rank: 1, winRate: 0.6, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
];
const champData = { champion: { id: 157, winRate: 0.5 }, augments: { all: rows, stages: { 1: [], 2: [], 3: [], 4: [] } } };
const titles = (a, b, c) => ({ ok: true, ...FRAME, window: true, ms: 200, lines: [a, b, c].filter(Boolean).map((t, i) => ({ text: t, x: 1180 + i * 430, y: 640, w: 220, h: 34 })) });
const EMPTY = { ok: true, ...FRAME, window: true, ms: 200, lines: [] };

function setup({
  phase = 'ingame', level = 7, available = true, frames = [], enabled = true,
  debugDir = null, fs: fsArg = null, path: pathArg = null, autoDump = false,
  maxTickDumps = 100, now = () => 1000,
} = {}) {
  const queue = frames.slice();
  const captures = [];
  const worker = { isAvailable: () => available, lastError: () => (available ? null : 'dead'), capture: async (o) => { captures.push(o); return queue.length ? queue.shift() : EMPTY; } };
  const st = { game: { phase, level, championId: 157 }, view: { stage: 'auto', bracket: 'all' }, offers: [], statuses: [], errors: [] };
  const state = {
    getGame: () => st.game, getView: () => st.view, getChampData: () => champData,
    setOffer: (o) => st.offers.push(o), setOcrStatus: (p) => st.statuses.push(p), pushError: (scope, m) => st.errors.push(`${scope}: ${m}`),
  };
  const timers = [];
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const w = createOfferWatcher({
    worker, state, setTimer, clearTimer: () => {}, now, idleMs: 1500, activeMs: 500,
    debugDir, fs: fsArg, path: pathArg, autoDump, maxTickDumps,
  });
  w.setEnabled(enabled);
  return { w, st, captures, timers, queue };
}

// Fake fs: records mkdir/writeFile/readdir/rm calls without touching disk.
function fakeFs({ readdirResult = [] } = {}) {
  const mkdirCalls = [];
  const writeFileCalls = [];
  const readdirCalls = [];
  const rmCalls = [];
  const copyFileCalls = [];
  return {
    mkdirCalls, writeFileCalls, readdirCalls, rmCalls, copyFileCalls,
    mkdir: async (dir, opts) => { mkdirCalls.push({ dir, opts }); },
    writeFile: async (p, data) => { writeFileCalls.push({ path: p, data }); },
    readdir: async (dir) => { readdirCalls.push(dir); return readdirResult; },
    copyFile: async (from, to) => { copyFileCalls.push({ from, to }); },
    rm: async (p) => { rmCalls.push(p); },
  };
}

// Flushes the microtask queue so fire-and-forget writeFile().then(prune) chains settle
// before assertions run.
const flush = () => new Promise((r) => setImmediate(r));

test('not in game: no capture, status updated, no offer', async () => {
  const { w, st, captures } = setup({ phase: 'none' });
  await w.tick();
  assert.equal(captures.length, 0);
  assert.deepEqual(st.offers, []);
  assert.equal(st.statuses.at(-1).enabled, true);
});

test('disabled or unavailable worker: no capture', async () => {
  const a = setup({ enabled: false }); await a.w.tick(); assert.equal(a.captures.length, 0);
  const b = setup({ available: false }); await b.w.tick(); assert.equal(b.captures.length, 0);
  assert.equal(b.st.statuses.at(-1).lastError, 'dead');
});

test('two agreeing frames publish one offer with advice; a third identical frame does not republish', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f, f] });
  await w.tick(); assert.equal(st.offers.length, 0);
  await w.tick(); assert.equal(st.offers.length, 1);
  await w.tick(); assert.equal(st.offers.length, 1);
  const o = st.offers[0];
  assert.equal(o.frames, 2);
  assert.equal(o.rarity, 'prismatic');
  assert.equal(o.pickSlot, 'left');
  assert.deepEqual(o.cards.map((c) => c.verdict), ['pick', 'keep', 'reroll']);
  assert.equal(o.detectedAt, 1000);
  assert.equal(o.stage, 'all');
});

test('a different offer replaces the published one after two agreeing frames', async () => {
  const f1 = titles('Mystic Punch', 'Final Form', 'Clown College');
  const f2 = titles('Zealot', 'Final Form', null);
  const { w, st } = setup({ frames: [f1, f1, f2, f2] });
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(st.offers.length, 2);
  assert.equal(st.offers[1].cards[0].name, 'Zealot');
  assert.equal(st.offers[1].cards[2].verdict, 'unread');
});

test('two frames without a match clear the offer; one does not', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f, EMPTY, f, EMPTY, EMPTY] });
  await w.tick(); await w.tick();
  assert.equal(st.offers.length, 1);
  await w.tick(); assert.equal(st.offers.length, 1, 'single empty frame ignored');
  await w.tick(); assert.equal(st.offers.length, 1, 'same offer again, no republish');
  await w.tick(); await w.tick();
  assert.equal(st.offers.at(-1), null);
});

test('capture failure records one error per distinct message and status lastError', async () => {
  const bad = { ok: false, error: 'timeout', lines: [] };
  const { w, st } = setup({ frames: [bad, bad, { ok: false, error: 'worker exited (1)', lines: [] }] });
  await w.tick(); await w.tick(); await w.tick();
  assert.deepEqual(st.errors, ['ocr: capture failed: timeout', 'ocr: capture failed: worker exited (1)']);
  assert.equal(st.statuses.at(-1).lastError, 'worker exited (1)');
});

test('cadence: idle delay until an offer is published, then active delay', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, timers, queue } = setup({ frames: [] });
  w.start();
  assert.equal(timers[0].ms, 1500);
  queue.push(f, f);
  await w.tick(); await w.tick();
  await timers[0].fn();            // scheduled tick runs and reschedules
  assert.equal(timers.at(-1).ms, 500);
  w.stop();
});

test('captureOnce returns capture, match and advice without publishing', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st, captures } = setup({ frames: [f] });
  const r = await w.captureOnce({ region: 'full' });
  assert.equal(captures[0].region, 'full');
  assert.equal(r.capture.ok, true);
  assert.equal(r.match.matched, 3);
  assert.equal(r.advice.pickSlot, 'left');
  assert.equal(r.savedTo, null);
  assert.deepEqual(st.offers, []);
});

test('captureOnce({save:true}) always saves, regardless of autoDump: one PNG path, one mkdir, one JSON sidecar sharing its basename', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const fs = fakeFs();
  const { w } = setup({ frames: [f], debugDir: 'data/debug', fs, path, autoDump: false });
  const r = await w.captureOnce({ save: true });
  assert.ok(r.savedTo.endsWith('.png'));
  assert.equal(fs.mkdirCalls.length, 1);
  assert.equal(fs.writeFileCalls.length, 1);
  assert.equal(fs.writeFileCalls[0].path, r.savedTo.replace(/\.png$/, '.json'));
});

test('autoDump:false: a published offer does not auto-dump a debug file', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const fs = fakeFs();
  const { w, st } = setup({ frames: [f, f], debugDir: 'data/debug', fs, path, autoDump: false });
  await w.tick(); await w.tick();
  assert.equal(st.offers.length, 1);
  assert.equal(fs.writeFileCalls.length, 0);
});

test('autoDump:true, in-game tick with no offer match still writes one tick-*.json', async () => {
  const fs = fakeFs();
  const { w } = setup({ debugDir: 'data/debug', fs, path, autoDump: true, now: () => 42 });
  await w.tick();
  assert.equal(fs.writeFileCalls.length, 1);
  const call = fs.writeFileCalls[0];
  assert.ok(call.path.endsWith(`tick-42.json`));
  const dump = JSON.parse(call.data);
  assert.deepEqual(Object.keys(dump).sort(), ['capture', 'match']);
  assert.deepEqual(dump.capture, EMPTY);
  assert.equal(dump.match, null);
});

test('autoDump:false: an in-game tick writes no tick-*.json', async () => {
  const fs = fakeFs();
  const { w } = setup({ debugDir: 'data/debug', fs, path, autoDump: false });
  await w.tick();
  assert.equal(fs.writeFileCalls.length, 0);
});

test('maxTickDumps caps tick-*.json files, removing the oldest by name', async () => {
  const fs = fakeFs({ readdirResult: ['tick-100.json', 'tick-200.json', 'tick-300.json', 'offer-999.json'] });
  const { w } = setup({ debugDir: 'data/debug', fs, path, autoDump: true, maxTickDumps: 2, now: () => 400 });
  await w.tick();
  await flush();
  assert.equal(fs.rmCalls.length, 2);
  assert.ok(fs.rmCalls[0].endsWith('tick-100.json'));
});

test('phase leaving ingame clears a published offer on the next tick', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f] });
  await w.tick(); await w.tick();
  st.game = { phase: 'none', level: null, championId: 157 };
  await w.tick();
  assert.equal(st.offers.at(-1), null);
});

test('augment index memo: a fresh empty extra array each call reuses the same index', () => {
  const memo = createAugmentIndexMemo();
  const a = memo(champData, []);
  const b = memo(champData, []);
  assert.equal(a, b);
});

test('augment index memo: different champData rebuilds the index', () => {
  const memo = createAugmentIndexMemo();
  const other = { champion: { id: 1 }, augments: { all: [], stages: { 1: [], 2: [], 3: [], 4: [] } } };
  const a = memo(champData, []);
  const b = memo(other, []);
  assert.notEqual(a, b);
});

test('augment index memo: an extra list of different length rebuilds the index', () => {
  const memo = createAugmentIndexMemo();
  const a = memo(champData, []);
  const b = memo(champData, [{ id: 99, name: 'Extra Augment', rarity: 'gold' }]);
  assert.notEqual(a, b);
});


test('debug retains distinct offer-like misses with their same-frame PNG and HDR metadata', async () => {
  const color = { backend: 'dxgi', hdr: true, pixelFormat: 'R16G16B16A16_FLOAT', toneMap: 'reinhard-srgb', warning: null };
  const miss = { ...titles('Unknown First', 'Unknown Second', 'Unknown Third'), color,
    lines: ['Unknown First', 'Unknown Second', 'Unknown Third'].map((text, i) => ({ text, x: 1180 + i * 490, y: 581, w: 180, h: 24 })) };
  const fs = fakeFs();
  let ts = 10;
  const { w, st, captures } = setup({ frames: [miss, miss], debugDir: 'data/debug', fs, path, autoDump: true, now: () => ts++ });
  await w.tick(); await w.tick(); await flush();
  assert.ok(captures[0].saveTo.endsWith('.png'));
  const samples = fs.writeFileCalls.filter(c => path.basename(c.path).startsWith('sample-'));
  assert.equal(samples.length, 1, 'unchanged title screen is retained once');
  const sample = JSON.parse(samples[0].data);
  assert.equal(sample.match, null);
  assert.deepEqual(sample.capture.color, color);
  assert.equal(fs.copyFileCalls[0].from, captures[0].saveTo, 'retains the analyzed frame, not another capture');
  assert.equal(st.statuses.at(-1).hdr, true);
});

test('debug retention removes PNG companions together with old JSON records', async () => {
  const fs = fakeFs({ readdirResult: ['tick-100.json', 'tick-100.png', 'tick-200.json', 'tick-200.png', 'sample-100.json', 'sample-100.png'] });
  const { w } = setup({ debugDir: 'data/debug', fs, path, autoDump: true, maxTickDumps: 1, now: () => 300 });
  await w.tick(); await flush();
  assert.ok(fs.rmCalls.some(p => p.endsWith('tick-100.png')));
  assert.ok(!fs.rmCalls.some(p => p.includes('sample-100')));
});

test('failure to retain a sample does not skip rolling debug cleanup', async () => {
  const fs = fakeFs({ readdirResult: ['tick-100.json', 'tick-200.json'] });
  fs.copyFile = async () => { throw new Error('sample copy failed'); };
  const { w } = setup({ frames: [titles('Mystic Punch', 'Final Form', 'Clown College')], debugDir: 'data/debug', fs, path, autoDump: true, maxTickDumps: 1 });
  await w.tick();
  assert.ok(fs.rmCalls.some(p => p.endsWith('tick-100.json')));
});

test('orphan PNGs left by interrupted debug writes are included in retention', async () => {
  const fs = fakeFs({ readdirResult: ['tick-100.png', 'tick-200.json', 'tick-200.png', 'sample-100.png'] });
  const { w } = setup({ debugDir: 'data/debug', fs, path, autoDump: true, maxTickDumps: 1 });
  await w.tick();
  assert.ok(fs.rmCalls.some(p => p.endsWith('tick-100.png')));
  assert.ok(!fs.rmCalls.some(p => p.includes('sample-100')));
});

test('a failed debug PNG save still publishes the captured offer', async () => {
  const f = { ...titles('Mystic Punch', 'Final Form', 'Clown College'), saveError: 'disk full' };
  const fs = fakeFs();
  const { w, st } = setup({ frames: [f, f], debugDir: 'data/debug', fs, path, autoDump: true });
  await w.tick(); await w.tick();
  assert.equal(st.offers.length, 1);
  assert.equal(fs.copyFileCalls.length, 0, 'do not copy a PNG that failed to save');
  assert.equal(JSON.parse(fs.writeFileCalls[0].data).capture.saveError, 'disk full');
});

test('explicit capture save reports a failed PNG instead of returning a nonexistent saved path', async () => {
  const f = { ...titles('Mystic Punch', 'Final Form', 'Clown College'), saveError: 'disk full' };
  const { w } = setup({ frames: [f], debugDir: 'data/debug', fs: fakeFs(), path });
  await assert.rejects(w.captureOnce({ save: true }), /Screenshot save failed: disk full/);
});
