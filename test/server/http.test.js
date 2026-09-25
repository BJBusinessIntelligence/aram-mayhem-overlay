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

test('parseView', () => {
  assert.deepEqual(parseView({ stage: '3' }), { stage: 3 });
  assert.deepEqual(parseView({ stage: 'auto', bracket: 'all' }), { stage: 'auto', bracket: 'all' });
  assert.deepEqual(parseView({}), {});
  assert.throws(() => parseView({ stage: '5' }), /invalid stage/);
  assert.throws(() => parseView({ bracket: 'x' }), /invalid bracket/);
});
