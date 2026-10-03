# Auto-Import (Summoner Spells + Item Sets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whenever the held champion changes in ARAM Mayhem champ select, set the League client's summoner spells to the champion's best pair and upsert an `AMO · <champion>` item set built from the overlay's context-adjusted build; refresh the item set once in game when enemies are known.

**Architecture:** A pure planner turns `pickBuild` output into `{ spells, itemSet }` plus a fingerprint. A thin LCU writer performs the only two client writes (PATCH my-selection, GET/PUT item sets with a merge that touches only AMO sets). An importer loop mirrors the OCR watcher: it polls the app state once a second, acts on fingerprint changes, and pushes status into the state for a header chip and a toggle route.

**Tech Stack:** Node ≥ 22 ESM, zero dependencies, `node:test` + `node:assert/strict`, plain HTML/CSS/JS front end.

**Spec:** `docs/superpowers/specs/2026-10-03-auto-import-design.md`

## Global Constraints

- Zero runtime dependencies; Node ≥ 22; ESM; `npm test` (`node --test "test/**/*.test.js"`) stays green after every task.
- The ONLY LCU writes in the codebase are `PATCH /lol-champ-select/v1/session/my-selection` (spells, champ select only) and `PUT /lol-item-sets/v1/item-sets/{summonerId}/sets` (item sets). Nothing else is ever written to the client.
- Item sets: one per champion titled `AMO · <name>` with `uid` `amo-<id>`; the merge replaces only the set with the same title or uid, keeps every other set by reference, and never deletes anything. The PUT body is the GET body with only `itemSets` and `timestamp` replaced. Never PUT without a successful GET first.
- Item ids inside item sets are strings; `count` is 1; blocks carry `hideIfSummonerSpell: ''` and `showIfSummonerSpell: ''`.
- Writes happen only on a fingerprint change; a failed write leaves the fingerprint unset so the next change retries; no timer-based retries.
- Config: `importEnabled` default `true` (`--import`, `IMPORT_ENABLED`), `importDebug` default `false` (`--import-debug`, `IMPORT_DEBUG`).
- Every write and failure is logged on one line prefixed `[import]`.
- Existing patterns to mirror: `src/ocr/watcher.js` (loop, `status()`, `start/stop/setEnabled`), `src/server/state.js` `EMPTY_OCR`/`setOcrStatus`, `src/server/http.js` `POST /api/ocr`, `src/config.js` `pick` + `bool`, `public/app.js` `renderOcrChip`.
- Commit after every task; every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Git on this machine warns LF→CRLF; use `git -c core.safecrlf=false commit …` if blocked.
- Fixture facts: `test/fixtures/aramkit/champion-details-157-all.json` (Yasuo) → best summoners `[4, 32]` (Flash, Mark); `pickBuild(real)` → starter `[1038]`, boots `3006`, core `[3032, 123430, 6333]`, later `[3153, 3031, 3065, 6665, 3033, 3143]`.

---

### Task 1: `spellIds` on the build + pure planner

**Files:**
- Modify: `src/rank/builds.js` (`pickBuild` → `primary.spellIds`)
- Create: `src/import/plan.js`
- Test: `test/rank/builds.test.js`, `test/import/plan.test.js`

**Interfaces:**
- Produces `build.primary.spellIds: number[]` (the chosen summoner row's `spellIds`, `[]` when none).
- Produces from `plan.js`: `HEALTH_POTION = 2003`, `AMO_PREFIX = 'AMO · '`,
  `planImport({ champ, build, enemies = 0 }) → { spells: { ids: number[], names: string[] } | null, itemSet: ItemSet | null }`,
  `fingerprint(plan, phase) → string`.
  `ItemSet = { title, type: 'custom', map: 'any', mode: 'any', associatedChampions: [id], associatedMaps: [], sortrank: 0, startedFrom: 'blank', preferredItemSlots: [], uid: 'amo-<id>', blocks: [{ type, items: [{ id: '3031', count: 1 }], hideIfSummonerSpell: '', showIfSummonerSpell: '' }] }`.

- [ ] **Step 1: Failing test for `spellIds`**

Append to `test/rank/builds.test.js` (`real` exists):

```js
test('primary carries the chosen summoner spell ids next to their names', () => {
  const b = pickBuild(real);
  assert.deepEqual(b.primary.spellIds, [4, 32]);
  assert.deepEqual(b.primary.spells, ['Flash', 'Mark']);
  const none = pickBuild({ build: { archetypes: [arch({ key: 'a' })] }, summoners: [], skills: [] });
  assert.deepEqual(none.primary.spellIds, []);
});
```

Run: `node --test test/rank/builds.test.js` → FAIL (`spellIds` undefined).

- [ ] **Step 2: Implement**

In `src/rank/builds.js` `pickBuild`, next to `spells: spells?.names ?? [],` add `spellIds: spells?.spellIds ?? [],`.

Run: `node --test test/rank/builds.test.js` → PASS.

- [ ] **Step 3: Failing planner tests**

Create `test/import/plan.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, fingerprint, HEALTH_POTION, AMO_PREFIX } from '../../src/import/plan.js';
import { pickBuild } from '../../src/rank/builds.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const data = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const build = pickBuild(data);
const ids = (block) => block.items.map((i) => i.id);

test('plans spells and an AMO item set from the real Yasuo build', () => {
  const p = planImport({ champ: data.champion, build });
  assert.deepEqual(p.spells, { ids: [4, 32], names: ['Flash', 'Mark'] });
  const s = p.itemSet;
  assert.equal(s.title, `${AMO_PREFIX}Yasuo`);
  assert.equal(s.uid, 'amo-157');
  assert.deepEqual(s.associatedChampions, [157]);
  assert.equal(s.type, 'custom'); assert.equal(s.map, 'any'); assert.equal(s.mode, 'any');
  assert.deepEqual(s.associatedMaps, []); assert.equal(s.sortrank, 0); assert.equal(s.startedFrom, 'blank'); assert.deepEqual(s.preferredItemSlots, []);
  assert.deepEqual(s.blocks.map((b) => b.type), ['Start', 'Boots', 'Core (in order)', 'Later']);
  assert.deepEqual(ids(s.blocks[0]), ['1038', String(HEALTH_POTION)]);
  assert.deepEqual(ids(s.blocks[1]), ['3006']);
  assert.deepEqual(ids(s.blocks[2]), ['3032', '123430', '6333']);
  assert.deepEqual(ids(s.blocks[3]), ['3153', '3031', '3065', '6665', '3033', '3143']);
  for (const b of s.blocks) { assert.equal(b.hideIfSummonerSpell, ''); assert.equal(b.showIfSummonerSpell, ''); for (const i of b.items) { assert.equal(typeof i.id, 'string'); assert.equal(i.count, 1); } }
});

test('situational block only when enemies are known; duplicates removed within a block', () => {
  const sit = { ...build, situational: [{ item: { id: 3075, name: 'Thornmail' } }, { item: { id: 3075, name: 'Thornmail' } }, { item: { id: 3047, name: 'Steelcaps' } }] };
  const none = planImport({ champ: data.champion, build: sit, enemies: 0 });
  assert.ok(!none.itemSet.blocks.some((b) => b.type.startsWith('Situational')));
  const some = planImport({ champ: data.champion, build: sit, enemies: 5 });
  const last = some.itemSet.blocks.at(-1);
  assert.equal(last.type, 'Situational vs 5 enemies');
  assert.deepEqual(ids(last), ['3075', '3047']);
});

test('no primary → no spells and no item set; one spell id → no spells', () => {
  assert.deepEqual(planImport({ champ: data.champion, build: null }), { spells: null, itemSet: null });
  const one = planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, spellIds: [4] } } });
  assert.equal(one.spells, null);
  assert.ok(one.itemSet);
});

test('fingerprint changes with phase, spells or any block item and not otherwise', () => {
  const a = planImport({ champ: data.champion, build });
  const f = fingerprint(a, 'champselect');
  assert.equal(fingerprint(planImport({ champ: data.champion, build }), 'champselect'), f);
  assert.notEqual(fingerprint(a, 'ingame'), f);
  assert.notEqual(fingerprint(planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, spellIds: [4, 6] } } }), 'champselect'), f);
  assert.notEqual(fingerprint(planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, later: [] } } }), 'champselect'), f);
  assert.equal(typeof fingerprint({ spells: null, itemSet: null }, 'ingame'), 'string');
});
```

Run: `node --test test/import/plan.test.js` → FAIL (module missing).

- [ ] **Step 4: Create `src/import/plan.js`**

```js
// Turns a pickBuild() result into what the League client accepts: a summoner spell pair and one
// item set per champion. Pure; the importer decides when to write and the writer talks to the LCU.
export const HEALTH_POTION = 2003;
export const AMO_PREFIX = 'AMO · ';

const validId = (id) => Number.isInteger(id) && id > 0;

function block(type, items) {
  const ids = [...new Set((items ?? []).map((i) => i && i.id).filter(validId))];
  if (ids.length === 0) return null;
  return { type, items: ids.map((id) => ({ id: String(id), count: 1 })), hideIfSummonerSpell: '', showIfSummonerSpell: '' };
}

export function planImport({ champ, build, enemies = 0 }) {
  const p = build?.primary;
  if (!champ || !p) return { spells: null, itemSet: null };
  const spells = Array.isArray(p.spellIds) && p.spellIds.length === 2 && p.spellIds.every(validId)
    ? { ids: p.spellIds.slice(), names: Array.isArray(p.spells) ? p.spells.slice() : [] }
    : null;
  const blocks = [
    block('Start', [...(p.starter ?? []), { id: HEALTH_POTION }]),
    block('Boots', p.boots ? [p.boots] : []),
    block('Core (in order)', p.core ?? []),
    block('Later', p.later ?? []),
    enemies > 0 ? block(`Situational vs ${enemies} enemies`, (build.situational ?? []).map((s) => s.item)) : null,
  ].filter(Boolean);
  const itemSet = {
    title: `${AMO_PREFIX}${champ.name}`, type: 'custom', map: 'any', mode: 'any',
    associatedChampions: [champ.id], associatedMaps: [], sortrank: 0, startedFrom: 'blank', preferredItemSlots: [],
    uid: `amo-${champ.id}`, blocks,
  };
  return { spells, itemSet };
}

export function fingerprint(plan, phase) {
  const spells = plan?.spells ? plan.spells.ids.join('+') : '-';
  const blocks = (plan?.itemSet?.blocks ?? []).map((b) => `${b.type}:${b.items.map((i) => i.id).join(',')}`).join(';');
  return `${phase}|${spells}|${blocks}`;
}
```

Run: `node --test test/import/plan.test.js` → PASS. Run `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rank/builds.js src/import/plan.js test/rank/builds.test.js test/import/plan.test.js
git commit -m "feat(import): spell ids on the build and a pure spells/item-set planner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `httpsSendJson` + LCU writer

**Files:**
- Modify: `src/util/httpsJson.js` (add `httpsSendJson`)
- Create: `src/game/lcuWriter.js`
- Test: `test/util/httpsJson.test.js`, `test/game/lcuWriter.test.js`

**Interfaces:**
- `httpsSendJson(url, { method = 'POST', body = null, headers = {}, timeoutMs = 3000, rejectUnauthorized = false }) → Promise<{ status, body }>` (JSON-encodes `body`, sets `content-type: application/json`; same parsing as `httpsGetJson`; rejects on timeout/network error).
- `mergeItemSets(existing, itemSet) → ItemSet[]` (pure, exported): replaces the entry whose `title === itemSet.title` or `uid === itemSet.uid`, else appends; other entries kept by reference.
- `createLcuWriter({ readLockfile, getJson, sendJson, now = Date.now, log = () => {}, debugDump = null }) → { summoner(), setSpells(ids), upsertItemSet(itemSet) }`; each resolves `{ ok: boolean, status: number, error?: string }` and never throws. `debugDump({ get, put })` is called (when provided) with the raw GET body and the PUT body.

- [ ] **Step 1: Failing `httpsSendJson` test**

Append to `test/util/httpsJson.test.js`. Extend the test server with an echo route placed before the 404 branch:

```js
  else if (req.url === '/echo') { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString() || 'null') })); }); }
```

and import `httpsSendJson`:

```js
test('httpsSendJson sends the method and a JSON body', async () => {
  const r = await httpsSendJson(`${base}/echo`, { method: 'PATCH', body: { spell1Id: 4, spell2Id: 32 }, headers: { authorization: 'Basic abc' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { method: 'PATCH', type: 'application/json', body: { spell1Id: 4, spell2Id: 32 } });
  assert.equal((await httpsSendJson(`${base}/missing`, { method: 'PUT', body: {} })).status, 404);
  await assert.rejects(httpsSendJson(`${base}/slow`, { method: 'PUT', body: {}, timeoutMs: 50 }), /timeout/);
});
```

Run: `node --test test/util/httpsJson.test.js` → FAIL (not exported).

- [ ] **Step 2: Implement `httpsSendJson`**

In `src/util/httpsJson.js`, refactor the request body of `httpsGetJson` into a shared `request(url, { method, payload, headers, timeoutMs, rejectUnauthorized })` and add:

```js
// Send a JSON body (PATCH/PUT/POST) and parse the JSON reply. Same TLS caveat as httpsGetJson.
export function httpsSendJson(url, { method = 'POST', body = null, headers = {}, timeoutMs = 3000, rejectUnauthorized = false } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return request(url, { method, payload, headers: { 'content-type': 'application/json', ...headers }, timeoutMs, rejectUnauthorized });
}
```

where `request` writes `payload` with `req.write(payload)` before `req.end()` when present. `httpsGetJson` becomes `request(url, { method: 'GET', payload: null, headers, timeoutMs, rejectUnauthorized })`.

Run: `node --test test/util/httpsJson.test.js` → PASS.

- [ ] **Step 3: Failing writer tests**

Create `test/game/lcuWriter.test.js`:

```js
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
});
```

Run: `node --test test/game/lcuWriter.test.js` → FAIL (module missing).

- [ ] **Step 4: Create `src/game/lcuWriter.js`**

```js
// The only module that writes to the League client. Two operations, both idempotent:
// summoner spells (champ select only) and one item set per champion (merged into the user's list).
export function mergeItemSets(existing, itemSet) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const i = list.findIndex((s) => s && (s.title === itemSet.title || (s.uid && s.uid === itemSet.uid)));
  if (i === -1) list.push(itemSet); else list[i] = itemSet;
  return list;
}

const ok2xx = (status) => status >= 200 && status < 300;

export function createLcuWriter({ readLockfile, getJson, sendJson, now = Date.now, log = () => {}, debugDump = null }) {
  let summonerMemo = null; // { port, summonerId, accountId }

  async function session() {
    let lock = null;
    try { lock = await readLockfile(); } catch { lock = null; }
    if (!lock) return null;
    const headers = { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' };
    const base = `https://127.0.0.1:${lock.port}`;
    return {
      get: (p) => getJson(`${base}${p}`, { headers, timeoutMs: 3000, rejectUnauthorized: false }),
      send: (method, p, body) => sendJson(`${base}${p}`, { method, body, headers, timeoutMs: 3000, rejectUnauthorized: false }),
      port: lock.port,
    };
  }

  const fail = (status, error) => ({ ok: false, status, error });

  async function summoner(s) {
    if (summonerMemo && summonerMemo.port === s.port) return summonerMemo;
    const r = await s.get('/lol-summoner/v1/current-summoner');
    if (r.status !== 200 || !r.body || !Number.isInteger(r.body.summonerId)) throw new Error(`summoner lookup failed: HTTP ${r.status}`);
    summonerMemo = { port: s.port, summonerId: r.body.summonerId, accountId: r.body.accountId ?? null };
    return summonerMemo;
  }

  return {
    async summoner() {
      try { const s = await session(); if (!s) return fail(0, 'client not running'); return { ok: true, status: 200, ...(await summoner(s)) }; }
      catch (e) { return fail(0, e.message); }
    },
    async setSpells(ids) {
      try {
        const s = await session(); if (!s) return fail(0, 'client not running');
        const r = await s.send('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: ids[0], spell2Id: ids[1] });
        return ok2xx(r.status) ? { ok: true, status: r.status } : fail(r.status, `HTTP ${r.status}`);
      } catch (e) { return fail(0, e.message); }
    },
    async upsertItemSet(itemSet) {
      try {
        const s = await session(); if (!s) return fail(0, 'client not running');
        const { summonerId } = await summoner(s);
        const path = `/lol-item-sets/v1/item-sets/${summonerId}/sets`;
        const got = await s.get(path);
        if (got.status !== 200 || !got.body || typeof got.body !== 'object') return fail(got.status, `item sets GET failed: HTTP ${got.status}`);
        const body = { ...got.body, itemSets: mergeItemSets(got.body.itemSets, itemSet), timestamp: now() };
        if (debugDump) { try { await debugDump({ get: got.body, put: body }); } catch (e) { log(`[import] debug dump failed: ${e.message}`); } }
        const put = await s.send('PUT', path, body);
        return ok2xx(put.status) ? { ok: true, status: put.status } : fail(put.status, `item sets PUT failed: HTTP ${put.status}`);
      } catch (e) { return fail(0, e.message); }
    },
  };
}
```

Run: `node --test test/game/lcuWriter.test.js` → PASS. `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/util/httpsJson.js src/game/lcuWriter.js test/util/httpsJson.test.js test/game/lcuWriter.test.js
git commit -m "feat(lcu): JSON send helper and an item-set/spell writer with AMO-only merge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Importer loop

**Files:**
- Create: `src/import/importer.js`
- Test: `test/import/importer.test.js`

**Interfaces:**
- `createImporter({ state, repository, writer, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 1000, now = Date.now, log = () => {} }) → { tick, start, stop, setEnabled, isEnabled, getStatus }`.
- Consumes from `state`: `getGame()` (needs `phase`, `lineup.held`, `lineup.enemies`), `getView()` (`bracket`), `getBuildContext()` (added in Task 4; the fake here provides it), `setImportStatus(patch)`.
- Consumes `repository.getChamp(id, bracket) → { data }`, `writer.setSpells(ids)`, `writer.upsertItemSet(itemSet)` (Task 2 contracts).
- Status shape pushed via `setImportStatus`: `{ enabled, running, lastChampion, lastSpells, lastItemSetAt, lastError }`.

- [ ] **Step 1: Failing tests**

Create `test/import/importer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImporter } from '../../src/import/importer.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const yasuo = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const champ = (id, name) => ({ ...yasuo, champion: { ...yasuo.champion, id, name } });

function setup({ phase = 'champselect', held = 157, enemies = [], enabled = true, spellsOk = true, setOk = true, failChamp = false } = {}) {
  const st = { game: { phase, championId: null, lineup: { held, bench: [], allies: [], enemies } }, view: { stage: 'auto', bracket: 'all' }, context: null, statuses: [] };
  const state = { getGame: () => st.game, getView: () => st.view, getBuildContext: () => st.context, setImportStatus: (p) => st.statuses.push(p) };
  const writes = [];
  const writer = {
    setSpells: async (ids) => { writes.push(['spells', ids]); return spellsOk ? { ok: true, status: 204 } : { ok: false, status: 400, error: 'HTTP 400' }; },
    upsertItemSet: async (s) => { writes.push(['set', s.title, s.blocks.map((b) => b.type)]); return setOk ? { ok: true, status: 201 } : { ok: false, status: 500, error: 'HTTP 500' }; },
  };
  const repository = { getChamp: async (id) => { if (failChamp) throw new Error('all sources down'); return { data: champ(id, id === 157 ? 'Yasuo' : `#${id}`), stale: false, source: 'aramkit' }; } };
  const timers = [];
  const logs = [];
  const imp = createImporter({ state, repository, writer, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {}, now: () => 1234, log: (m) => logs.push(m) });
  imp.setEnabled(enabled);
  return { imp, st, writes, timers, logs };
}

test('champ select: first tick writes spells then the item set; unchanged snapshot writes nothing more', async () => {
  const { imp, writes, st, logs } = setup();
  await imp.tick();
  assert.deepEqual(writes, [['spells', [4, 32]], ['set', 'AMO · Yasuo', ['Start', 'Boots', 'Core (in order)', 'Later']]]);
  await imp.tick();
  assert.equal(writes.length, 2);
  const last = st.statuses.at(-1);
  assert.equal(last.lastChampion, 'Yasuo'); assert.equal(last.lastSpells, 'Flash + Mark'); assert.equal(last.lastItemSetAt, 1234); assert.equal(last.lastError, null);
  assert.ok(logs.some((m) => /\[import\] spells Flash \+ Mark for Yasuo/.test(m)));
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

test('a failed write reports the error and retries on the next tick; success clears it', async () => {
  const { imp, writes, st } = setup({ spellsOk: false });
  await imp.tick();
  assert.equal(st.statuses.at(-1).lastError, 'spells: HTTP 400');
  await imp.tick();
  assert.equal(writes.filter((w) => w[0] === 'spells').length, 2, 'retried because the fingerprint was not remembered');
});

test('champion data failure is reported, never thrown', async () => {
  const { imp, st, writes } = setup({ failChamp: true });
  await imp.tick();
  assert.equal(writes.length, 0);
  assert.match(st.statuses.at(-1).lastError, /all sources down/);
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
```

Run: `node --test test/import/importer.test.js` → FAIL (module missing).

- [ ] **Step 2: Create `src/import/importer.js`**

```js
import { pickBuild } from '../rank/builds.js';
import { planImport, fingerprint } from './plan.js';

const ACTIVE = new Set(['champselect', 'ingame']);

// Polls the app state and pushes the held champion's spells and item set into the League client
// whenever the planned content changes. Mirrors the OCR watcher's loop and status pattern.
export function createImporter({ state, repository, writer, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 1000, now = Date.now, log = () => {} }) {
  let enabled = false;
  let stopped = true;
  let timer = null;
  let busy = false;
  let lastFingerprint = null;
  let last = { lastChampion: null, lastSpells: null, lastItemSetAt: null, lastError: null };

  function status(patch = {}) {
    last = { ...last, ...patch };
    state.setImportStatus({ enabled, running: !stopped && enabled, ...last });
  }

  async function tick() {
    if (busy || !enabled) return;
    const g = state.getGame();
    const held = g?.lineup?.held ?? null;
    if (!ACTIVE.has(g?.phase) || !held) return;
    busy = true;
    try {
      let data;
      try { data = (await repository.getChamp(held, state.getView().bracket)).data; }
      catch (e) { status({ lastError: e.message }); return; }
      const build = pickBuild(data, { context: state.getBuildContext() });
      const plan = planImport({ champ: data.champion, build, enemies: (g.lineup.enemies ?? []).length });
      const fp = fingerprint(plan, g.phase);
      if (fp === lastFingerprint) return;
      const name = data.champion.name;
      let allOk = true;
      if (g.phase === 'champselect' && plan.spells) {
        const r = await writer.setSpells(plan.spells.ids);
        const label = plan.spells.names.join(' + ');
        if (r.ok) { log(`[import] spells ${label} for ${name}`); status({ lastChampion: name, lastSpells: label, lastError: null }); }
        else { allOk = false; log(`[import] spells failed: ${r.error}`); status({ lastError: `spells: ${r.error}` }); }
      }
      if (plan.itemSet) {
        const r = await writer.upsertItemSet(plan.itemSet);
        if (r.ok) { log(`[import] item set ${plan.itemSet.title} (${plan.itemSet.blocks.length} blocks)`); status({ lastChampion: name, lastItemSetAt: now(), ...(allOk ? { lastError: null } : {}) }); }
        else { allOk = false; log(`[import] item set failed: ${r.error}`); status({ lastError: `item set: ${r.error}` }); }
      }
      if (allOk) lastFingerprint = fp; // a failure keeps it unset so the next tick retries
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(() => { tick().catch((e) => log(`[import] tick failed: ${e.message}`)).finally(schedule); }, intervalMs);
  }

  return {
    tick,
    start() { if (!stopped) return; stopped = false; status(); schedule(); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; status(); },
    setEnabled(v) { enabled = !!v; if (!enabled) lastFingerprint = null; status(); },
    isEnabled: () => enabled,
    getStatus: () => ({ enabled, running: !stopped && enabled, ...last }),
  };
}
```

Run: `node --test test/import/importer.test.js` → PASS. If the second test's status expectation differs because of the `lastError` merge order, fix the implementation to match the test. `npm test` → all pass.

- [ ] **Step 3: Commit**

```bash
git add src/import/importer.js test/import/importer.test.js
git commit -m "feat(import): importer loop that writes spells and item sets on fingerprint change

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: State slice, HTTP route, config, main wiring

**Files:**
- Modify: `src/server/state.js` (`EMPTY_IMPORT`, `import` in payload, `setImportStatus`, `getBuildContext`)
- Modify: `src/server/http.js` (`importer` option, `POST /api/import`)
- Modify: `src/config.js` (`importEnabled`, `importDebug`)
- Modify: `src/main.js` (writer + importer wiring, debug dump, stop)
- Test: `test/server/state.test.js`, `test/server/http.test.js`, `test/config.test.js`

**Interfaces:**
- `EMPTY_IMPORT = { enabled: false, running: false, lastChampion: null, lastSpells: null, lastItemSetAt: null, lastError: null }` exported from `state.js`; `buildPayload` gains `import = EMPTY_IMPORT`; `createAppState` gains `setImportStatus(patch)` and `getBuildContext()`.
- `createServer({ state, champIndex, publicDir, watcher = null, importer = null })`; `POST /api/import { enabled: boolean }` → 400 non-boolean, 503 without importer, 200 snapshot.
- Config keys `importEnabled` (default true) and `importDebug` (default false).

- [ ] **Step 1: Failing state tests**

Append to `test/server/state.test.js`:

```js
import { EMPTY_IMPORT } from '../../src/server/state.js';

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
```

Run → FAIL. Implement in `state.js`: `export const EMPTY_IMPORT = Object.freeze({ enabled: false, running: false, lastChampion: null, lastSpells: null, lastItemSetAt: null, lastError: null });`, `buildPayload({ …, import: importStatus = EMPTY_IMPORT })` adding `import: importStatus` to the returned object, `let importStatus = { ...EMPTY_IMPORT };` in `createAppState`, `snapshot()` passes `import: { ...importStatus }`, and on the returned object `setImportStatus(patch = {}) { importStatus = { ...importStatus, ...patch }; }` and `getBuildContext: () => buildContext`. Run → PASS.

- [ ] **Step 2: Failing http tests**

Append to `test/server/http.test.js` (the file already builds a second server with a `watcher`; add a fake importer to that server's options):

```js
const importerCalls = [];
const importer = { setEnabled: (v) => importerCalls.push(v), isEnabled: () => true, getStatus: () => ({}) };
```

Pass `importer` into the second `createServer({ … , watcher, importer })` call and add:

```js
test('POST /api/import toggles the importer; validates; 503 without one', async () => {
  const r = await post2('/api/import', { enabled: false });
  assert.equal(r.status, 200);
  assert.deepEqual(importerCalls, [false]);
  assert.equal((await post2('/api/import', { enabled: 'yes' })).status, 400);
  assert.equal((await post('/api/import', { enabled: true })).status, 503);
});
```

Run → FAIL. Implement in `http.js`: add `importer = null` to the `createServer` options and, next to the `/api/ocr` route:

```js
      if (req.method === 'POST' && p === '/api/import') {
        if (!importer) return send(res, 503, { error: 'importer not configured' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
        importer.setEnabled(body.enabled);
        return send(res, 200, state.snapshot());
      }
```

Run → PASS.

- [ ] **Step 3: Failing config tests**

Append to `test/config.test.js`:

```js
test('import flags', () => {
  assert.equal(loadConfig({}).importEnabled, true);
  assert.equal(loadConfig({ argv: ['--import=false'] }).importEnabled, false);
  assert.equal(loadConfig({ env: { IMPORT_ENABLED: 'off' } }).importEnabled, false);
  assert.equal(loadConfig({}).importDebug, false);
  assert.equal(loadConfig({ argv: ['--import-debug'] }).importDebug, true);
  assert.equal(loadConfig({ env: { IMPORT_DEBUG: '1' } }).importDebug, true);
});
```

Run → FAIL. Implement: `importEnabled: true, importDebug: false` in `DEFAULTS`; after the `rec-debug` block:

```js
  const imp = pick('import', 'IMPORT_ENABLED');
  if (imp !== undefined) c.importEnabled = bool(imp);
  const impDebug = pick('import-debug', 'IMPORT_DEBUG');
  if (impDebug !== undefined) c.importDebug = bool(impDebug);
```

Run → PASS.

- [ ] **Step 4: Wire `src/main.js`**

Imports:

```js
import { httpsGetJson, httpsSendJson } from './util/httpsJson.js';
import { createLcuWriter } from './game/lcuWriter.js';
import { createImporter } from './import/importer.js';
```

(replace the existing `httpsGetJson` import line). After the OCR watcher block:

```js
  const writer = createLcuWriter({
    readLockfile: () => readLockfile(cfg.lockfilePath, { fs }), getJson: httpsGetJson, sendJson: httpsSendJson, log,
    debugDump: cfg.importDebug ? async (d) => {
      const dir = path.join('data', 'debug'); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `item-sets-${Date.now()}.json`), JSON.stringify(d, null, 2));
    } : null,
  });
  const importer = createImporter({ state, repository, writer, log });
  importer.setEnabled(cfg.importEnabled);
  importer.start();
  log(`import: enabled=${cfg.importEnabled} debug=${cfg.importDebug}`);
```

Pass `importer` into `createServer({ …, watcher, importer })` and add `importer.stop();` to the returned `stop()`.

- [ ] **Step 5: Suite + smoke + commit**

Run `npm test` → all pass. Smoke: `node src/main.js --port 3796` for a few seconds; `curl.exe -s localhost:3796/api/state` must contain `"import":{"enabled":true,"running":true,…}`; `curl.exe -s -X POST localhost:3796/api/import -H "content-type: application/json" -d "{\"enabled\":false}"` → 200 with `"enabled":false`. Stop the server.

```bash
git add src/server/state.js src/server/http.js src/config.js src/main.js test/server/state.test.js test/server/http.test.js test/config.test.js
git commit -m "feat(server): import status slice, /api/import toggle, import flags, importer wiring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Header chip (UI)

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/style.css`

- [ ] **Step 1: Markup** — in `public/index.html` after `<span id="ocr-chip" class="chip" hidden></span>` add `<span id="import-chip" class="chip" title="Click to toggle auto-import of spells and item set" hidden></span>`.

- [ ] **Step 2: Renderer + click** — in `public/app.js` add after `renderOcrChip`:

```js
function renderImportChip(i) {
  const el = $('#import-chip');
  if (!i) { el.hidden = true; return; }
  el.hidden = false;
  el.style.cursor = 'pointer';
  if (!i.enabled) { el.textContent = 'Import off'; el.className = 'chip'; return; }
  if (i.lastError) { el.textContent = `Import: ${i.lastError}`; el.className = 'chip err'; return; }
  el.textContent = `Import on${i.lastChampion ? ` · ${i.lastChampion}` : ''}${i.lastSpells ? ` · ${i.lastSpells}` : ''}`;
  el.className = 'chip on';
}
```

Call `renderImportChip(p.import);` right after `renderOcrChip(p.ocr);` in `render()`, and in `tick()`'s else-branch (`else renderOcrChip(payload.ocr);` → `else { renderOcrChip(payload.ocr); renderImportChip(payload.import); }`). Exclude the import status from the render-skip key the same way `ocr` is: `JSON.stringify({ ...payload, ocr: undefined, import: undefined })`. Add the click handler near the other listeners:

```js
$('#import-chip').addEventListener('click', async () => {
  const cur = JSON.parse(lastRendered || '{}').import;
  try { await api('/api/import', { method: 'POST', body: JSON.stringify({ enabled: !(cur && cur.enabled) }) }); lastRendered = ''; lastRenderKey = ''; tick(); }
  catch (e) { setBanner(e.message); }
});
```

- [ ] **Step 3: Verify** — `node --check public/app.js`; serve and confirm `#import-chip` is in `/`. Commit:

```bash
git add public
git commit -m "feat(ui): auto-import header chip with click-to-toggle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README + live run

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document** — add after the recommender section:

```markdown
## Auto-import of summoner spells and item set

Whenever the champion you hold changes in champ select (opening-pick hover, lock, bench swap) the
overlay writes to the League client: your summoner spells become the champion's best pair, and an
item set named `AMO · <champion>` (Start, Boots, Core in order, Later; plus Situational once the
game starts and enemies are known) appears in the shop. One set per champion; only `AMO ·` sets are
ever replaced, your own item sets are never touched. These are the only two things the overlay
writes to the client.

Header chip: **Import on · Yasuo · Flash + Mark** (click to toggle), **Import off**, or the last error.
Start flags: `--import=false` / `IMPORT_ENABLED=false` to disable; `--import-debug` / `IMPORT_DEBUG=true`
saves the raw item-set GET/PUT bodies to `data/debug/item-sets-<ts>.json` for troubleshooting.
Runtime toggle: `POST /api/import {"enabled":false}`.
```

Add to the manual smoke checklist:

```markdown
- Auto-import: hover a champion in the opening pick → spells flip in the client within ~2 s; lock →
  console shows `[import] item set AMO · <name>`; in game the shop's item-set tab lists the set with
  a Situational block; chip click turns it off and no further writes happen.
```

- [ ] **Step 2: Suite, commit**

```bash
git add README.md
git commit -m "docs: auto-import of spells and item sets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 3: Live run (user)** — `node src/main.js --import-debug`, reload the tab, play one champ select. If the client rejects the PUT (chip shows `item set: item sets PUT failed: HTTP 4xx`), send `data/debug/item-sets-*.json`; the GET half shows the client's own set shape to copy.

---

## Self-review

- **Spec coverage:** §6.1 → T1; §6.2 → T1; §6.3 → T2; §6.4 → T3; §6.5 → T4 + T5; §7 → T4; §8 → T2 (GET-before-PUT, non-2xx), T3 (retry on change only, error status); §9 → every task; §10 milestones 1:1; §11 risks → T6 Step 3.
- **Placeholders:** none; every code step has code.
- **Type consistency:** `planImport` output and `fingerprint` (T1) are consumed identically in T3; writer result `{ ok, status, error? }` (T2) matches T3's checks; `setImportStatus` patch keys (T3) match `EMPTY_IMPORT` (T4) and the chip (T5); `getBuildContext()` returns the state's `buildContext` (T4) as T3 expects; `httpsSendJson` signature (T2) matches `main.js` wiring (T4).
