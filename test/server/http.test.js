import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, parseView } from '../../src/server/http.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { DataUnavailable } from '../../src/data/model.js';
import { fixture } from '../helpers/fixtures.js';

const publicDir = mkdtempSync(path.join(tmpdir(), 'amo-pub-'));
writeFileSync(path.join(publicDir, 'index.html'), '<html>ok</html>');
writeFileSync(path.join(publicDir, 'app.js'), 'console.log(1)');
writeFileSync(path.join(publicDir, 'style.css'), 'body{}');

const viewCalls = [];
let refreshCalls = 0;
const state = {
  snapshot: () => ({ game: { phase: 'none' }, loading: false, champ: null, view: { stage: 'auto', bracket: 'all', stageUsed: null }, augments: null, build: null, meta: null, errors: [] }),
  setView: async (v) => { viewCalls.push(v); },
  refresh: async () => { refreshCalls++; },
  preview: async (id, opts) => { if (id === 404) throw new DataUnavailable([new Error('x')]); return { champ: { id }, view: opts }; },
};
const champIndex = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const server = createServer({ state, champIndex, publicDir });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('static files', async () => {
  assert.equal((await get('/')).body, '<html>ok</html>');
  assert.match((await get('/')).type, /text\/html/);
  assert.match((await get('/app.js')).type, /javascript/);
  assert.match((await get('/style.css')).type, /text\/css/);
  // fetch normalizes '..' out of the path before it leaves the client, so this does not actually
  // exercise traversal; the whitelist in createServer makes traversal moot regardless.
  assert.equal((await get('/../package.json')).status, 404);
});

test('GET /api/state', async () => {
  const r = await get('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.game.phase, 'none');
});

test('GET /api/champions?q=', async () => {
  const r = await get('/api/champions?q=yas');
  assert.equal(r.body[0].name, 'Yasuo');
  assert.deepEqual((await get('/api/champions')).body, []);
});

test('GET /api/champ/:id passes view options', async () => {
  const r = await get('/api/champ/62?bracket=high&stage=2&force=1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { champ: { id: 62 }, view: { bracket: 'high', stage: 2, force: true } });
  assert.equal((await get('/api/champ/62?stage=9')).status, 400);
  assert.equal((await get('/api/champ/404')).status, 503);
  assert.equal((await get('/api/champ/abc')).status, 404);
});

test('POST /api/view and /api/refresh', async () => {
  const r = await post('/api/view', { stage: 'all', bracket: 'high' });
  assert.equal(r.status, 200);
  assert.deepEqual(viewCalls.at(-1), { stage: 'all', bracket: 'high' });
  assert.equal((await post('/api/view', { bracket: 'mid' })).status, 400);
  await post('/api/refresh', {});
  assert.equal(refreshCalls, 1);
});

const watcherCalls = [];
let captureOk = true;
const fakeWatcher = {
  captureOnce: async (o) => { watcherCalls.push(['capture', o]); return { capture: { ok: captureOk, error: captureOk ? undefined : 'boom', lines: [] }, match: null, advice: null, savedTo: o.save ? 'data/debug/x.png' : null }; },
  setEnabled: (v) => { watcherCalls.push(['enabled', v]); },
};
const server2 = createServer({ state, champIndex, publicDir, watcher: fakeWatcher });
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${server2.address().port}`;
after(() => server2.close());
const post2 = async (p, body) => { const r = await fetch(base2 + p, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('POST /api/ocr/capture and /api/ocr without a watcher → 503', async () => {
  assert.equal((await post('/api/ocr/capture', {})).status, 503);
  assert.equal((await post('/api/ocr', { enabled: true })).status, 503);
});

test('POST /api/ocr/capture forwards region and save; unknown region falls back to band', async () => {
  const ok = await post2('/api/ocr/capture', { region: 'full', save: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.savedTo, 'data/debug/x.png');
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'full', save: true }]);
  const dflt = await post2('/api/ocr/capture', {});
  assert.equal(dflt.status, 200);
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'band', save: false }]);
  await post2('/api/ocr/capture', { region: 'left', save: 'yes' });
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'band', save: false }]);
});

test('POST /api/ocr/capture maps a failed capture to 502', async () => {
  captureOk = false;
  const r = await post2('/api/ocr/capture', {});
  captureOk = true;
  assert.equal(r.status, 502);
  assert.equal(r.body.capture.error, 'boom');
});

test('POST /api/ocr toggles the watcher and validates the body', async () => {
  const r = await post2('/api/ocr', { enabled: false });
  assert.equal(r.status, 200);
  assert.deepEqual(watcherCalls.at(-1), ['enabled', false]);
  assert.equal((await post2('/api/ocr', { enabled: 'yes' })).status, 400);
});

test('parseView', () => {
  assert.deepEqual(parseView({ stage: '3' }), { stage: 3 });
  assert.deepEqual(parseView({ stage: 'auto', bracket: 'all' }), { stage: 'auto', bracket: 'all' });
  assert.deepEqual(parseView({}), {});
  assert.throws(() => parseView({ stage: '5' }), /invalid stage/);
  assert.throws(() => parseView({ bracket: 'x' }), /invalid bracket/);
});
