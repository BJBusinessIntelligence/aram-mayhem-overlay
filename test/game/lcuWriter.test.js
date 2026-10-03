import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLcuWriter, mergeItemSets } from '../../src/game/lcuWriter.js';

const lock = { port: 55555, password: 'secret' };
const amo = (id, name) => ({ title: `AMO · ${name}`, uid: `amo-${id}`, type: 'custom', map: 'any', mode: 'any', associatedChampions: [id], associatedMaps: [], sortrank: 0, startedFrom: 'blank', preferredItemSlots: [], blocks: [] });
const foreign = { title: 'My Lux build', uid: 'user-1', blocks: [], associatedChampions: [99] };

function fakeHttp({ sets = { accountId: 42, itemSets: [], timestamp: 1 }, summoner = { summonerId: 7, accountId: 42 }, failGet = false, putStatus = 201, patchStatus = 204 } = {}) {
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => {
      const p = new URL(url).pathname; calls.push(['GET', p, opts]);
      if (p === '/lol-summoner/v1/current-summoner') return { status: 200, body: summoner };
      if (p === '/lol-item-sets/v1/item-sets/7/sets') return failGet ? { status: 500, body: 'boom' } : { status: 200, body: sets };
      return { status: 404, body: null };
    },
    sendJson: async (url, opts) => {
      const p = new URL(url).pathname; calls.push([opts.method, p, opts]);
      if (p === '/lol-champ-select/v1/session/my-selection') return { status: patchStatus, body: null };
      if (p === '/lol-item-sets/v1/item-sets/7/sets') return { status: putStatus, body: null };
      return { status: 404, body: null };
    },
  };
}

test('mergeItemSets replaces the same-title or same-uid set, keeps others by reference, appends when missing', () => {
  const old = amo(157, 'Yasuo'); const other = amo(99, 'Lux'); const fresh = { ...amo(157, 'Yasuo'), blocks: [{ type: 'Start', items: [] }] };
  const merged = mergeItemSets([foreign, old, other], fresh);
  assert.deepEqual(merged.map((s) => s.title), ['My Lux build', 'AMO · Yasuo', 'AMO · Lux']);
  assert.equal(merged[0], foreign); assert.equal(merged[2], other); assert.equal(merged[1], fresh);
  assert.equal(mergeItemSets([foreign], fresh).length, 2);
  assert.equal(mergeItemSets([{ ...old, title: 'renamed', uid: 'amo-157' }], fresh)[0], fresh, 'uid match also replaces');
  const untitled = { blocks: [] };
  const appended = mergeItemSets([untitled, foreign], { uid: 'amo-1', blocks: [] });
  assert.equal(appended.length, 3, 'an untitled incoming set must not match an untitled existing one');
  assert.equal(appended[0], untitled);
});

test('setSpells PATCHes my-selection with auth and insecure tls', async () => {
  const h = fakeHttp();
  const w = createLcuWriter({ readLockfile: async () => lock, getJson: h.getJson, sendJson: h.sendJson });
  const r = await w.setSpells([4, 32]);
  assert.deepEqual(r, { ok: true, status: 204 });
  const [method, p, opts] = h.calls.find((c) => c[0] === 'PATCH');
  assert.equal(p, '/lol-champ-select/v1/session/my-selection');
  assert.deepEqual(opts.body, { spell1Id: 4, spell2Id: 32 });
  assert.equal(opts.headers.authorization, 'Basic ' + Buffer.from('riot:secret').toString('base64'));
  assert.equal(opts.rejectUnauthorized, false);
});

test('upsertItemSet: GET, merge, PUT the GET body with new itemSets and timestamp; summoner cached', async () => {
  const h = fakeHttp({ sets: { accountId: 42, itemSets: [foreign, amo(157, 'Yasuo')], timestamp: 1, extra: 'keep-me' } });
  const dumps = [];
  const w = createLcuWriter({ readLockfile: async () => lock, getJson: h.getJson, sendJson: h.sendJson, now: () => 999, debugDump: (d) => dumps.push(d) });
  const fresh = { ...amo(157, 'Yasuo'), blocks: [{ type: 'Core (in order)', items: [{ id: '3031', count: 1 }] }] };
  const r = await w.upsertItemSet(fresh);
  assert.deepEqual(r, { ok: true, status: 201 });
  const put = h.calls.find((c) => c[0] === 'PUT');
  assert.equal(put[1], '/lol-item-sets/v1/item-sets/7/sets');
  assert.equal(put[2].body.accountId, 42); assert.equal(put[2].body.extra, 'keep-me'); assert.equal(put[2].body.timestamp, 999);
  assert.deepEqual(put[2].body.itemSets.map((s) => s.title), ['My Lux build', 'AMO · Yasuo']);
  assert.equal(put[2].body.itemSets[1], fresh);
  assert.equal(dumps.length, 1); assert.ok(dumps[0].get && dumps[0].put);
  await w.upsertItemSet(fresh);
  assert.equal(h.calls.filter((c) => c[1] === '/lol-summoner/v1/current-summoner').length, 1, 'summoner looked up once per lockfile');
});

test('failures: no lockfile, GET failure (no PUT), non-2xx PATCH/PUT → ok:false with status', async () => {
  const none = createLcuWriter({ readLockfile: async () => null, getJson: fakeHttp().getJson, sendJson: fakeHttp().sendJson });
  assert.equal((await none.setSpells([4, 32])).ok, false);
  assert.match((await none.upsertItemSet(amo(1, 'Annie'))).error, /client not running/);
  const bad = fakeHttp({ failGet: true });
  const w = createLcuWriter({ readLockfile: async () => lock, getJson: bad.getJson, sendJson: bad.sendJson });
  const r = await w.upsertItemSet(amo(1, 'Annie'));
  assert.equal(r.ok, false); assert.equal(r.status, 500);
  assert.ok(!bad.calls.some((c) => c[0] === 'PUT'), 'never PUT without a good GET');
  const rej = fakeHttp({ patchStatus: 400, putStatus: 500 });
  const w2 = createLcuWriter({ readLockfile: async () => lock, getJson: rej.getJson, sendJson: rej.sendJson });
  assert.deepEqual(await w2.setSpells([4, 32]), { ok: false, status: 400, error: 'HTTP 400' });
  assert.equal((await w2.upsertItemSet(amo(1, 'Annie'))).status, 500);
  const thrower = createLcuWriter({ readLockfile: async () => lock, getJson: async () => { throw new Error('ECONNRESET'); }, sendJson: async () => { throw new Error('ECONNRESET'); } });
  assert.match((await thrower.setSpells([4, 32])).error, /ECONNRESET/);
  const stringThrower = createLcuWriter({ readLockfile: async () => lock, getJson: fakeHttp().getJson, sendJson: async () => { throw 'boom'; } });
  assert.equal((await stringThrower.setSpells([4, 32])).error, 'boom', 'non-Error throws are stringified, not read as .message');
  const arrGet = fakeHttp({ sets: [] });
  const w3 = createLcuWriter({ readLockfile: async () => lock, getJson: arrGet.getJson, sendJson: arrGet.sendJson });
  assert.equal((await w3.upsertItemSet(amo(1, 'Annie'))).ok, false, 'an array GET body is not a valid item-sets document');
  assert.ok(!arrGet.calls.some((c) => c[0] === 'PUT'), 'never PUT after an array GET body');
});
