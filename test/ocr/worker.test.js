import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOcrWorker } from '../../src/ocr/worker.js';

// Fake powershell child: replies to each stdin line via `respond(req) -> reply object | undefined`.
function fakeSpawnFactory({ respond, readyLine = { ok: true, ready: true, lang: 'en-US' }, exitOnSpawn = false } = {}) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 1)); };
    child.stdin = { write: (s) => { const req = JSON.parse(s); const reply = respond(req, child); if (reply !== undefined) setImmediate(() => child.stdout.emit('data', JSON.stringify(reply) + '\n')); } };
    children.push(child);
    setImmediate(() => { if (readyLine) child.stdout.emit('data', JSON.stringify(readyLine) + '\n'); if (exitOnSpawn) child.emit('exit', 1); });
    return child;
  };
  return { spawn, children };
}

test('non-windows: unavailable, capture resolves ok:false without spawning', async () => {
  const { spawn, children } = fakeSpawnFactory({ respond: () => ({}) });
  const w = createOcrWorker({ spawn, platform: 'linux' });
  assert.equal(w.isAvailable(), false);
  const r = await w.capture();
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, []);
  assert.equal(children.length, 0);
});

test('capture sends the protocol command and normalizes the reply', async () => {
  let seen;
  const { spawn, children } = fakeSpawnFactory({ respond: (req) => { seen = req; return { ok: true, w: 3440, h: 1440, window: true, ms: 210, lines: [{ text: 'Mystic Punch', x: '1400', y: 600, w: 200, h: 34 }] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32', scriptPath: 'X:\\worker.ps1' });
  const r = await w.capture({ region: 'full', saveTo: 'C:\\t.png' });
  assert.deepEqual(seen, { cmd: 'capture', region: 'full', saveTo: 'C:\\t.png' });
  assert.equal(r.ok, true);
  assert.equal(r.w, 3440);
  assert.deepEqual(r.lines, [{ text: 'Mystic Punch', x: 1400, y: 600, w: 200, h: 34 }]);
  assert.equal(children.length, 1, 'one child reused');
  assert.equal(w.isAvailable(), true);
});

test('a single object reply for lines is wrapped in an array; default region is band', async () => {
  let seen;
  const { spawn } = fakeSpawnFactory({ respond: (req) => { seen = req; return { ok: true, w: 1, h: 1, ms: 1, lines: { text: 'A', x: 1, y: 2, w: 3, h: 4 } }; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  const r = await w.capture();
  assert.equal(seen.region, 'band');
  assert.equal(seen.saveTo, null);
  assert.equal(r.lines.length, 1);
});

test('requests are serialized: second capture waits for the first reply', async () => {
  const order = [];
  const { spawn } = fakeSpawnFactory({ respond: (req) => { order.push('req'); return { ok: true, w: 1, h: 1, ms: 1, lines: [] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  const [a, b] = await Promise.all([w.capture(), w.capture()]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(order, ['req', 'req']);
});

test('timeout kills the child, resolves ok:false, and the next call respawns', async () => {
  let calls = 0;
  const { spawn, children } = fakeSpawnFactory({ respond: () => { calls++; return calls === 1 ? undefined : { ok: true, w: 1, h: 1, ms: 1, lines: [] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32', timeoutMs: 20 });
  const r1 = await w.capture();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /timeout/);
  assert.equal(children[0].killed, true);
  const r2 = await w.capture();
  assert.equal(r2.ok, true);
  assert.equal(children.length, 2);
  assert.equal(w.lastError(), 'worker timeout');
});

test('respawn budget: after maxRespawns within the window the worker disables itself', async () => {
  const { spawn, children } = fakeSpawnFactory({ respond: () => ({}), readyLine: null, exitOnSpawn: true });
  let t = 0;
  const w = createOcrWorker({ spawn, platform: 'win32', maxRespawns: 3, respawnWindowMs: 1000, now: () => t, timeoutMs: 50 });
  for (let i = 0; i < 4; i++) await w.capture();
  assert.equal(children.length, 3);
  assert.equal(w.isAvailable(), false);
  assert.match(w.lastError(), /too often/);
  t = 5000; // window elapsed does not revive a dead worker
  await w.capture();
  assert.equal(children.length, 3);
});

test('ready:false from the script marks the worker dead', async () => {
  const { spawn } = fakeSpawnFactory({ respond: () => ({}), readyLine: { ok: false, ready: false, error: 'no OCR language pack installed' } });
  const w = createOcrWorker({ spawn, platform: 'win32', timeoutMs: 30 });
  const r = await w.capture();
  assert.equal(r.ok, false);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.isAvailable(), false);
  assert.match(w.lastError(), /language pack/);
});

test('stop() sends quit and kills; ping works', async () => {
  const seen = [];
  const { spawn, children } = fakeSpawnFactory({ respond: (req) => { seen.push(req.cmd); return req.cmd === 'ping' ? { ok: true, pong: true } : undefined; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  assert.equal((await w.ping()).pong, true);
  w.stop();
  assert.ok(seen.includes('quit'));
  assert.equal(children[0].killed, true);
});

test('stdin write failure discards the child; next request spawns a new one', async () => {
  const children = [];
  let spawnCount = 0;
  const spawn = () => {
    spawnCount += 1;
    const idx = spawnCount;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 1)); };
    child.stdin = {
      write: (s) => {
        if (idx === 1) throw new Error('EPIPE: write after end');
        JSON.parse(s);
        setImmediate(() => child.stdout.emit('data', JSON.stringify({ ok: true, w: 1, h: 1, ms: 1, lines: [] }) + '\n'));
      },
    };
    children.push(child);
    setImmediate(() => child.stdout.emit('data', JSON.stringify({ ok: true, ready: true, lang: 'en-US' }) + '\n'));
    return child;
  };
  const w = createOcrWorker({ spawn, platform: 'win32' });
  const r1 = await w.capture();
  assert.equal(r1.ok, false);
  const r2 = await w.capture();
  assert.equal(r2.ok, true);
  assert.equal(children.length, 2);
});

test('spawn throwing resolves ok:false and counts toward the budget', async () => {
  const spawn = () => { throw new Error('spawn ENOENT'); };
  const w = createOcrWorker({ spawn, platform: 'win32', maxRespawns: 2 });
  const r1 = await w.capture();
  assert.equal(r1.ok, false);
  const r2 = await w.capture();
  assert.equal(r2.ok, false);
  const r3 = await w.capture();
  assert.equal(r3.ok, false);
  assert.equal(w.isAvailable(), false);
});

test('stop() settles an in-flight request immediately', async () => {
  const { spawn } = fakeSpawnFactory({ respond: () => undefined });
  const w = createOcrWorker({ spawn, platform: 'win32', timeoutMs: 500 });
  const started = Date.now();
  const pending = w.capture();
  setImmediate(() => w.stop());
  const r = await pending;
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'stopped');
  assert.ok(elapsed < 200, `expected < 200ms, got ${elapsed}ms`);
});
