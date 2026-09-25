import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpsGetJson } from '../../src/util/httpsJson.js';

const server = http.createServer((req, res) => {
  if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, auth: req.headers.authorization ?? null })); }
  else if (req.url === '/text') { res.writeHead(200); res.end('"InProgress"'); }
  else if (req.url === '/empty') { res.writeHead(204); res.end(); }
  else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 300); }
  else { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('parses json and forwards headers', async () => {
  const r = await httpsGetJson(`${base}/json`, { headers: { authorization: 'Basic abc' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, auth: 'Basic abc' });
});

test('bare json string body parses to a string', async () => {
  assert.equal((await httpsGetJson(`${base}/text`)).body, 'InProgress');
});

test('non-json body returned as text, empty as null', async () => {
  assert.equal((await httpsGetJson(`${base}/missing`)).body, 'nope');
  assert.equal((await httpsGetJson(`${base}/missing`)).status, 404);
  assert.equal((await httpsGetJson(`${base}/empty`)).body, null);
});

test('times out', async () => {
  await assert.rejects(httpsGetJson(`${base}/slow`, { timeoutMs: 50 }), /timeout/);
});

test('connection refused rejects', async () => {
  await assert.rejects(httpsGetJson('http://127.0.0.1:1/x', { timeoutMs: 500 }));
});
