# ARAM Mayhem Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local Node server + browser page that auto-detects the League champion (LCU in champ select, Live Client Data in game) and shows stage-aware ARAM Mayhem augment rankings and a high-win-rate build from aramkit JSON, with aramgg API as fallback.

**Architecture:** Pure-function core (`normalize`, `rank`) fed by thin I/O adapters (`aramkit`, `aramgg`, `lcu`, `liveclient`) that all take injected `fetch`/`getJson`/`fs`/`now`. A `repository` chains cache → primary → fallback → stale. An `AppState` store merges game state + data into one JSON payload served by a `node:http` server to a static page that polls every 2 s.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node:test` + `node:assert/strict`, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-09-25-aram-mayhem-overlay-design.md`

## Global Constraints

- Node `>=22`, `"type": "module"`, no runtime dependencies, no dev dependencies.
- Tests: `node:test` + `node:assert/strict`. Test files live under `test/` mirroring `src/`, named `*.test.js`. `npm test` runs `node --test "test/**/*.test.js"`.
- Every I/O module takes injected `fetch` / `getJson` / `fs` / `now` / `sleep` with production defaults. Tests never touch network, disk, or real clock.
- All rates are 0–1 decimals in code; the UI formats to percent.
- Server binds `127.0.0.1` only. Default port `3777`.
- Self-signed TLS is accepted **only** for `127.0.0.1` requests via the scoped `httpsGetJson` helper; never set `NODE_TLS_REJECT_UNAUTHORIZED`.
- Champion ids are Riot numeric ids (Yasuo = 157, Wukong = 62). Champion `riotId` is the internal name (`MonkeyKing`).
- Rarity strings: `prismatic` | `gold` | `silver` | `unknown`. Tier strings: `S A B C D` or `null`.
- Stage from level: `<7 → 1`, `7–10 → 2`, `11–14 → 3`, `≥15 → 4`, non-number → `null`.
- Every commit message ends with the trailer line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (shown once in Task 1; add it to every commit).
- Fixtures in `test/fixtures/aramkit/` are real captures (2026-09-25, aramkit data 16.19). Do not edit them.
- Deviation from spec §7.6 (recorded here so nobody "fixes" it): cache keys do **not** contain the data version and there is no prune step. Freshness = TTL ok **and** cached `sourceVersion` equals the adapter's current version. Simpler, same behavior.
- Additive deviations from the spec, all used by the page: `POST /api/refresh`; `/api/champions` also returns `slug` and `icon`; `view.stageUsed` in the payload; `error` field on `GameState`.
- 2026-09-26: aramgg fallback replaced by Blitz (keyless tiers) + CommunityDragon resources.

## File Structure

```
package.json                      scripts start/test
start.cmd                         launches server with --open
README.md
src/
  main.js                         wiring only
  config.js                       env + argv → config object
  util/httpsJson.js               GET JSON over http/https, optional insecure TLS, timeout
  data/model.js                   constants, stageFromLevel, EMPTY_GAME, error classes, assertChampData
  data/champions.js               ChampionIndex (byId / byRiotId / search)
  data/cache.js                   JSON file cache with TTL, injected fs
  data/repository.js              cache → primary → fallback → stale
  data/aramkit/client.js          URL builders, throttled deduped fetchJson
  data/aramkit/normalize.js       raw aramkit → ChampData (pure)
  data/aramkit/adapter.js         version/resources caching + normalize → DataSource
  data/aramgg/client.js           keyed fetch, 429 cooldown
  data/aramgg/normalize.js        raw aramgg → ChampData (pure, defensive)
  data/aramgg/adapter.js          DataSource
  rank/augments.js                stage resolution, lift, sort, group by rarity (pure)
  rank/builds.js                  pick archetype, flatten route (pure)
  game/lockfile.js                parse/read LCU lockfile
  game/lcu.js                     LCU snapshot: phase, queueId, championId
  game/liveclient.js              Live Client snapshot: championRiotId, level, gameMode
  game/detector.js                reducer + poller → GameState
  server/state.js                 AppState store + payload builder
  server/http.js                  routes + static
public/index.html, app.js, style.css
test/helpers/memfs.js, fixtures.js
test/fixtures/aramkit/*.json      real
test/fixtures/liveclient/allgamedata.json   hand-written
test/fixtures/aramgg/champion-157.sample.json  hand-written, UNVERIFIED shape
```

---

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `src/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig({ env, argv }) → { port, pollMs, cacheDir, cacheTtlMs, lockfilePath, aramggApiKey, primarySource, open }` and `parseArgs(argv) → object`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "aram-mayhem-overlay",
  "version": "0.1.0",
  "private": true,
  "description": "Local ARAM Mayhem augment + build overlay page for League of Legends",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/main.js",
    "test": "node --test \"test/**/*.test.js\""
  }
}
```

- [ ] **Step 2: Write the failing test** `test/config.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseArgs, DEFAULTS } from '../src/config.js';

test('defaults when nothing given', () => {
  const c = loadConfig({ env: {}, argv: [] });
  assert.equal(c.port, 3777);
  assert.equal(c.pollMs, 2000);
  assert.equal(c.cacheTtlMs, 24 * 3600 * 1000);
  assert.equal(c.aramggApiKey, null);
  assert.equal(c.primarySource, 'aramkit');
  assert.equal(c.open, false);
  assert.match(c.lockfilePath, /lockfile$/);
  assert.equal(c.cacheDir, DEFAULTS.cacheDir);
});

test('env overrides defaults', () => {
  const c = loadConfig({ env: { PORT: '4000', POLL_MS: '500', CACHE_TTL_H: '2', ARAMGG_API_KEY: 'hx_live_x', PRIMARY_SOURCE: 'aramgg', LOL_LOCKFILE: 'D:\\lol\\lockfile', CACHE_DIR: 'tmp/c' }, argv: [] });
  assert.equal(c.port, 4000);
  assert.equal(c.pollMs, 500);
  assert.equal(c.cacheTtlMs, 2 * 3600 * 1000);
  assert.equal(c.aramggApiKey, 'hx_live_x');
  assert.equal(c.primarySource, 'aramgg');
  assert.equal(c.lockfilePath, 'D:\\lol\\lockfile');
  assert.equal(c.cacheDir, 'tmp/c');
});

test('argv beats env, both forms', () => {
  const c = loadConfig({ env: { PORT: '4000' }, argv: ['--port=5000', '--poll-ms', '750', '--open'] });
  assert.equal(c.port, 5000);
  assert.equal(c.pollMs, 750);
  assert.equal(c.open, true);
});

test('parseArgs handles = and space and bare flags', () => {
  assert.deepEqual(parseArgs(['--a=1', '--b', '2', '--c', '--d=x=y']), { a: '1', b: '2', c: 'true', d: 'x=y' });
});

test('invalid numbers and sources throw', () => {
  assert.throws(() => loadConfig({ env: { PORT: 'abc' }, argv: [] }), /Invalid port/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--port=0'] }), /Invalid port/);
  assert.throws(() => loadConfig({ env: { PRIMARY_SOURCE: 'opgg' }, argv: [] }), /Invalid primary source/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL, `Cannot find module '.../src/config.js'`

- [ ] **Step 4: Write `src/config.js`**

```js
import path from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 3777,
  pollMs: 2000,
  cacheDir: path.join('data', 'cache'),
  cacheTtlMs: 24 * 60 * 60 * 1000,
  lockfilePath: 'C:\\Riot Games\\League of Legends\\lockfile',
  aramggApiKey: null,
  primarySource: 'aramkit',
  open: false,
});

// --key=value | --key value | --key   (bare flag → 'true')
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = 'true';
  }
  return out;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

export function loadConfig({ env = {}, argv = [] } = {}) {
  const args = parseArgs(argv);
  const pick = (argKey, envKey) => (args[argKey] !== undefined ? args[argKey] : env[envKey]);
  const c = { ...DEFAULTS };

  const port = pick('port', 'PORT');
  if (port !== undefined) c.port = positiveInt(port, 'port');
  const poll = pick('poll-ms', 'POLL_MS');
  if (poll !== undefined) c.pollMs = positiveInt(poll, 'poll-ms');
  const ttl = pick('cache-ttl-h', 'CACHE_TTL_H');
  if (ttl !== undefined) c.cacheTtlMs = positiveInt(ttl, 'cache-ttl-h') * 3600 * 1000;
  const dir = pick('cache-dir', 'CACHE_DIR');
  if (dir !== undefined) c.cacheDir = dir;
  const lock = pick('lockfile', 'LOL_LOCKFILE');
  if (lock !== undefined) c.lockfilePath = lock;
  const key = pick('aramgg-key', 'ARAMGG_API_KEY');
  if (key) c.aramggApiKey = key;
  const src = pick('primary', 'PRIMARY_SOURCE');
  if (src !== undefined) {
    if (!['aramkit', 'aramgg'].includes(src)) throw new Error(`Invalid primary source: ${src}`);
    c.primarySource = src;
  }
  if (args.open === 'true') c.open = true;
  return c;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/config.test.js`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add package.json src/config.js test/config.test.js
git commit -m "feat: scaffold package and config loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Disk cache with injected fs

**Files:**
- Create: `test/helpers/memfs.js`, `src/data/cache.js`, `test/data/cache.test.js`

**Interfaces:**
- Produces: `createCache({ dir, ttlMs, fs?, now? }) → { get(keyArray) → { value, fetchedAt, fresh } | null, set(keyArray, value), filePath(keyArray) }`.
- Produces test helper: `createMemFs(initial?) → { files: Map, readFile, writeFile, mkdir, rm }` (promise API, forward-slash keys).

- [ ] **Step 1: Write the memfs helper** `test/helpers/memfs.js`

```js
// In-memory stand-in for node:fs/promises. Keys are forward-slash paths.
export function createMemFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const norm = (p) => String(p).replace(/\\/g, '/');
  return {
    files,
    async readFile(p) {
      const k = norm(p);
      if (!files.has(k)) { const e = new Error(`ENOENT: no such file ${k}`); e.code = 'ENOENT'; throw e; }
      return files.get(k);
    },
    async writeFile(p, data) { files.set(norm(p), String(data)); },
    async mkdir() {},
    async rm(p) { files.delete(norm(p)); },
  };
}
```

- [ ] **Step 2: Write the failing test** `test/data/cache.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../../src/data/cache.js';
import { createMemFs } from '../helpers/memfs.js';

function setup(ttlMs = 1000) {
  let t = 10_000;
  const fs = createMemFs();
  const cache = createCache({ dir: 'c', ttlMs, fs, now: () => t });
  return { fs, cache, tick: (ms) => { t += ms; } };
}

test('miss returns null', async () => {
  const { cache } = setup();
  assert.equal(await cache.get(['aramkit', 'all', 'champ-157']), null);
});

test('set then get is fresh and round-trips value', async () => {
  const { cache } = setup();
  await cache.set(['aramkit', 'all', 'champ-157'], { a: 1 });
  const hit = await cache.get(['aramkit', 'all', 'champ-157']);
  assert.deepEqual(hit.value, { a: 1 });
  assert.equal(hit.fetchedAt, 10_000);
  assert.equal(hit.fresh, true);
});

test('expired entry is returned with fresh=false', async () => {
  const { cache, tick } = setup(1000);
  await cache.set(['k'], 1);
  tick(1000);
  assert.equal((await cache.get(['k'])).fresh, false);
});

test('corrupt file is deleted and treated as miss', async () => {
  const { cache, fs } = setup();
  const p = cache.filePath(['k']).replace(/\\/g, '/');
  fs.files.set(p, '{not json');
  assert.equal(await cache.get(['k']), null);
  assert.equal(fs.files.has(p), false);
});

test('wrong shape is a miss', async () => {
  const { cache, fs } = setup();
  fs.files.set(cache.filePath(['k']).replace(/\\/g, '/'), JSON.stringify({ nope: 1 }));
  assert.equal(await cache.get(['k']), null);
});

test('key segments are sanitised into the path', () => {
  const { cache } = setup();
  assert.match(cache.filePath(['a/b', 'c d']).replace(/\\/g, '/'), /^c\/a_b\/c_d\.json$/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/data/cache.test.js`
Expected: FAIL, cannot find `src/data/cache.js`.

- [ ] **Step 4: Write `src/data/cache.js`**

```js
import path from 'node:path';
import { promises as nodeFs } from 'node:fs';

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

export function createCache({ dir, ttlMs, fs = nodeFs, now = Date.now }) {
  const filePath = (key) => path.join(dir, ...key.map(safe)) + '.json';

  async function remove(p) {
    try { await fs.rm(p, { force: true }); } catch { /* ignore */ }
  }

  async function get(key) {
    const p = filePath(key);
    let text;
    try { text = await fs.readFile(p, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { await remove(p); return null; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fetchedAt !== 'number' || !('value' in parsed)) {
      await remove(p);
      return null;
    }
    return { value: parsed.value, fetchedAt: parsed.fetchedAt, fresh: now() - parsed.fetchedAt < ttlMs };
  }

  async function set(key, value) {
    const p = filePath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ fetchedAt: now(), value }), 'utf8');
  }

  return { get, set, filePath };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/data/cache.test.js`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add src/data/cache.js test/data/cache.test.js test/helpers/memfs.js
git commit -m "feat: json file cache with ttl and injected fs"
```

---

### Task 3: Model constants + champion index + fixtures helper

**Files:**
- Create: `src/data/model.js`, `src/data/champions.js`, `test/helpers/fixtures.js`, `test/data/model.test.js`, `test/data/champions.test.js`

**Interfaces:**
- Produces `model.js`: `RARITIES`, `STAGES`, `TIER_ORDER`, `EMPTY_GAME`, `stageFromLevel(level)`, `assertChampData(d)`, classes `NormalizeError`, `HttpError(status, url)`, `DataUnavailable(errors)`.
- Produces `champions.js`: `createChampionIndex(resourceObj) → { size, byId(id), byRiotId(riotId), search(q, limit=10), all() }` where entries are `{ id, riotId, name, slug, icon }`.
- Produces helper: `fixture(...segments) → parsed JSON`, `aramkitResources() → { champions, augments, items, spells, archetypes }`.

- [ ] **Step 1: Write fixtures helper** `test/helpers/fixtures.js`

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(...segments) {
  return JSON.parse(readFileSync(path.join(root, ...segments), 'utf8'));
}

export function aramkitResources() {
  return {
    champions: fixture('aramkit', 'resources-champions.json'),
    augments: fixture('aramkit', 'resources-augments.json'),
    items: fixture('aramkit', 'resources-items.json'),
    spells: fixture('aramkit', 'resources-summoner-spells.json'),
    archetypes: fixture('aramkit', 'resources-archetypes.json'),
  };
}
```

- [ ] **Step 2: Write failing tests**

`test/data/model.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageFromLevel, assertChampData, NormalizeError, HttpError, DataUnavailable, EMPTY_GAME } from '../../src/data/model.js';

test('stageFromLevel boundaries', () => {
  assert.equal(stageFromLevel(1), 1);
  assert.equal(stageFromLevel(6), 1);
  assert.equal(stageFromLevel(7), 2);
  assert.equal(stageFromLevel(10), 2);
  assert.equal(stageFromLevel(11), 3);
  assert.equal(stageFromLevel(14), 3);
  assert.equal(stageFromLevel(15), 4);
  assert.equal(stageFromLevel(18), 4);
  assert.equal(stageFromLevel(null), null);
  assert.equal(stageFromLevel(0), null);
  assert.equal(stageFromLevel('7'), null);
});

test('assertChampData rejects bad shapes', () => {
  assert.throws(() => assertChampData(null), NormalizeError);
  assert.throws(() => assertChampData({ champion: {} }), /champion\.id/);
  assert.throws(() => assertChampData({ champion: { id: 1 }, augments: { all: [] } }), /no augments/);
  const ok = { champion: { id: 1 }, augments: { all: [{ id: 5 }] } };
  assert.equal(assertChampData(ok), ok);
});

test('error classes carry data', () => {
  const h = new HttpError(404, 'http://x');
  assert.equal(h.status, 404);
  assert.match(h.message, /404/);
  const d = new DataUnavailable([new Error('a'), new Error('b')]);
  assert.equal(d.errors.length, 2);
  assert.match(d.message, /a; b/);
});

test('EMPTY_GAME is frozen with phase none', () => {
  assert.equal(EMPTY_GAME.phase, 'none');
  assert.equal(Object.isFrozen(EMPTY_GAME), true);
});
```

`test/data/champions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));

test('size and byId', () => {
  assert.equal(index.size, 173);
  assert.equal(index.byId(157).name, 'Yasuo');
  assert.equal(index.byId('157').riotId, 'Yasuo');
  assert.equal(index.byId(999999), null);
});

test('byRiotId is case-insensitive and maps Wukong', () => {
  assert.equal(index.byRiotId('monkeyking').id, 62);
  assert.equal(index.byRiotId('MonkeyKing').name, 'Wukong');
  assert.equal(index.byRiotId(null), null);
  assert.equal(index.byRiotId('Nope'), null);
});

test('search is prefix on name, riotId, slug', () => {
  assert.ok(index.search('ya').some((c) => c.name === 'Yasuo'));
  assert.ok(index.search('monkey').some((c) => c.name === 'Wukong'));
  assert.ok(index.search('wuk').some((c) => c.name === 'Wukong'));
  assert.deepEqual(index.search(''), []);
  assert.equal(index.search('a', 3).length, 3);
});

test('empty resource gives empty index', () => {
  const e = createChampionIndex({});
  assert.equal(e.size, 0);
  assert.equal(e.byId(1), null);
  assert.deepEqual(e.all(), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/data/model.test.js test/data/champions.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/data/model.js`**

```js
export const RARITIES = Object.freeze(['prismatic', 'gold', 'silver']);
export const STAGES = Object.freeze([1, 2, 3, 4]);
export const TIER_ORDER = Object.freeze({ S: 0, A: 1, B: 2, C: 3, D: 4 });

export const EMPTY_GAME = Object.freeze({
  phase: 'none',          // none | champselect | loading | ingame
  queueId: null,
  championId: null,
  riotId: null,           // champion internal name, e.g. MonkeyKing
  level: null,
  stage: null,
  gameMode: null,
  lcuConnected: false,
  liveConnected: false,
  error: null,
  updatedAt: 0,
});

export function stageFromLevel(level) {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return null;
  if (level < 7) return 1;
  if (level < 11) return 2;
  if (level < 15) return 3;
  return 4;
}

export class NormalizeError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'NormalizeError'; Object.assign(this, extra); }
}

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} for ${url}`); this.name = 'HttpError'; this.status = status; this.url = url; }
}

export class DataUnavailable extends Error {
  constructor(errors = []) {
    super(`No data source available: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'DataUnavailable';
    this.errors = errors;
  }
}

export function assertChampData(d) {
  if (!d || typeof d !== 'object') throw new NormalizeError('ChampData missing');
  if (!d.champion || !Number.isInteger(d.champion.id)) throw new NormalizeError('ChampData.champion.id missing');
  if (!d.augments || !Array.isArray(d.augments.all) || d.augments.all.length === 0) throw new NormalizeError('ChampData has no augments');
  return d;
}
```

- [ ] **Step 5: Write `src/data/champions.js`**

```js
// Champion lookup built from aramkit resources/champions.json ({ "157": { slug, riotId, name, icon } }).
export function createChampionIndex(resource = {}) {
  const list = Object.entries(resource ?? {})
    .map(([id, c]) => ({ id: Number(id), riotId: c?.riotId, name: c?.name ?? c?.riotId, slug: c?.slug ?? '', icon: c?.icon ?? null }))
    .filter((c) => Number.isInteger(c.id) && typeof c.riotId === 'string')
    .sort((a, b) => a.name.localeCompare(b.name));
  const byIdMap = new Map(list.map((c) => [c.id, c]));
  const byRiotMap = new Map(list.map((c) => [c.riotId.toLowerCase(), c]));
  return {
    size: list.length,
    byId: (id) => byIdMap.get(Number(id)) ?? null,
    byRiotId: (riotId) => (riotId ? byRiotMap.get(String(riotId).toLowerCase()) ?? null : null),
    search(q, limit = 10) {
      const s = String(q ?? '').trim().toLowerCase();
      if (!s) return [];
      return list
        .filter((c) => c.name.toLowerCase().startsWith(s) || c.riotId.toLowerCase().startsWith(s) || c.slug.startsWith(s))
        .slice(0, limit);
    },
    all: () => list.slice(),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/data/model.test.js test/data/champions.test.js`
Expected: 8 passing.

- [ ] **Step 7: Commit**

```bash
git add src/data/model.js src/data/champions.js test/helpers/fixtures.js test/data/model.test.js test/data/champions.test.js
git commit -m "feat: model constants, error classes, champion index"
```

---

### Task 4: aramkit client (URL builders, throttled + deduped fetch)

**Files:**
- Create: `src/data/aramkit/client.js`, `test/data/aramkit/client.test.js`

**Interfaces:**
- Consumes: `HttpError` from `src/data/model.js`.
- Produces: `ARAMKIT_BASE`, `VERSIONS_URL`, `aramkitUrls(entry) → { champion(id, bracket), resource(name), icon(path) }`, `pickLatest(versionsJson) → entry`, `createAramkitClient({ fetch?, now?, sleep?, minIntervalMs?, userAgent? }) → { fetchJson(url), versions(), latestVersion(), champion(id, bracket, entry), resource(name, entry) }`.
- A version *entry* is one element of `versions.json.versions`: `{ version, dataPath, resourcePath, dataDate }`.

- [ ] **Step 1: Write the failing test** `test/data/aramkit/client.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aramkitUrls, pickLatest, createAramkitClient, VERSIONS_URL } from '../../../src/data/aramkit/client.js';
import { HttpError } from '../../../src/data/model.js';
import { fixture } from '../../helpers/fixtures.js';

const versions = fixture('aramkit', 'versions.json');
const entry = pickLatest(versions);

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => hit };
  };
  return { fetch, calls };
}

test('pickLatest returns the entry matching latest', () => {
  assert.equal(entry.version, '16.19');
  assert.equal(entry.dataPath, 'data/16.19-20260924-6f95ad08cfe5');
  assert.throws(() => pickLatest({ versions: [] }), /no versions/);
});

test('url builders', () => {
  const u = aramkitUrls(entry);
  assert.equal(u.champion(157, 'all'), 'https://data.aramkit.com/data/16.19-20260924-6f95ad08cfe5/stats/all/champion-details/157.json');
  assert.equal(u.champion(62, 'high'), 'https://data.aramkit.com/data/16.19-20260924-6f95ad08cfe5/stats/high/champion-details/62.json');
  assert.equal(u.resource('champions'), 'https://data.aramkit.com/resources/16.19-0971924da1f4/en-US/resources/champions.json');
  assert.equal(u.icon('assets/x.webp'), 'https://data.aramkit.com/assets/x.webp');
  assert.equal(u.icon(null), null);
  assert.throws(() => aramkitUrls({}), /dataPath/);
});

test('latestVersion fetches versions.json', async () => {
  const { fetch, calls } = fakeFetch({ [VERSIONS_URL]: versions });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  const e = await client.latestVersion();
  assert.equal(e.version, '16.19');
  assert.deepEqual(calls, [VERSIONS_URL]);
});

test('non-200 throws HttpError with status', async () => {
  const { fetch } = fakeFetch({});
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.champion(1, 'all', entry), (e) => e instanceof HttpError && e.status === 404);
});

test('throttles consecutive requests by minIntervalMs', async () => {
  let t = 0;
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const url1 = aramkitUrls(entry).resource('items');
  const url2 = aramkitUrls(entry).resource('augments');
  const { fetch } = fakeFetch({ [url1]: { a: 1 }, [url2]: { b: 2 } });
  const client = createAramkitClient({ fetch, now: () => t, sleep, minIntervalMs: 500 });
  await client.resource('items', entry);
  await client.resource('augments', entry);
  assert.deepEqual(sleeps, [500]);
});

test('sends a user-agent header', async () => {
  let seen;
  const fetch = async (url, init) => { seen = init.headers; return { status: 200, json: async () => ({}) }; };
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await client.fetchJson('https://data.aramkit.com/x.json');
  assert.match(seen['user-agent'], /aram-mayhem-overlay/);
});

test('dedupes concurrent requests for the same url', async () => {
  const url = aramkitUrls(entry).champion(157, 'all');
  const { fetch, calls } = fakeFetch({ [url]: { ok: 1 } });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  const [a, b] = await Promise.all([client.champion(157, 'all', entry), client.champion(157, 'all', entry)]);
  assert.deepEqual(a, { ok: 1 });
  assert.deepEqual(b, { ok: 1 });
  assert.equal(calls.length, 1);
});

test('a failed request does not block the next one', async () => {
  const url = aramkitUrls(entry).resource('items');
  const { fetch } = fakeFetch({ [url]: { a: 1 } });
  const client = createAramkitClient({ fetch, minIntervalMs: 0 });
  await assert.rejects(client.fetchJson('https://data.aramkit.com/missing.json'));
  assert.deepEqual(await client.resource('items', entry), { a: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data/aramkit/client.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/data/aramkit/client.js`**

```js
import { HttpError } from '../model.js';

export const ARAMKIT_BASE = 'https://data.aramkit.com';
export const VERSIONS_URL = `${ARAMKIT_BASE}/data/versions.json`;
export const RESOURCE_NAMES = Object.freeze(['champions', 'augments', 'items', 'summoner-spells', 'archetypes']);

export function aramkitUrls(entry) {
  if (!entry || !entry.dataPath || !entry.resourcePath) throw new Error('aramkit version entry missing dataPath/resourcePath');
  return {
    champion: (id, bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-details/${id}.json`,
    resource: (name) => `${ARAMKIT_BASE}/${entry.resourcePath}/en-US/resources/${name}.json`,
    icon: (p) => (p ? `${ARAMKIT_BASE}/${p}` : null),
  };
}

export function pickLatest(versions) {
  const list = versions && Array.isArray(versions.versions) ? versions.versions : [];
  if (list.length === 0) throw new Error('aramkit versions.json has no versions');
  return list.find((v) => v.version === versions.latest) ?? list[0];
}

export function createAramkitClient({
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIntervalMs = 500,
  userAgent = 'aram-mayhem-overlay/0.1 (personal tool)',
} = {}) {
  let lastAt = -Infinity;
  let chain = Promise.resolve();
  const inflight = new Map();

  function fetchJson(url) {
    if (inflight.has(url)) return inflight.get(url);
    const run = chain.catch(() => {}).then(async () => {
      const wait = lastAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' } });
      if (res.status !== 200) throw new HttpError(res.status, url);
      return res.json();
    });
    chain = run;
    const tracked = run.finally(() => inflight.delete(url));
    inflight.set(url, tracked);
    return tracked;
  }

  return {
    fetchJson,
    versions: () => fetchJson(VERSIONS_URL),
    latestVersion: async () => pickLatest(await fetchJson(VERSIONS_URL)),
    champion: (id, bracket, entry) => fetchJson(aramkitUrls(entry).champion(id, bracket)),
    resource: (name, entry) => fetchJson(aramkitUrls(entry).resource(name)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data/aramkit/client.test.js`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/data/aramkit/client.js test/data/aramkit/client.test.js
git commit -m "feat: aramkit client with url builders, throttle, dedupe"
```

---

### Task 5: aramkit normalizer (pure) against real fixture

**Files:**
- Create: `src/data/aramkit/normalize.js`, `test/data/aramkit/normalize.test.js`

**Interfaces:**
- Consumes: `NormalizeError`, `STAGES` from model; fixture helpers.
- Produces: `normalizeAramkit(raw, resources, meta) → ChampData` where `resources = { champions, augments, items, spells, archetypes }` (raw resource objects keyed by id) and `meta = { version, dataDate, bracket, fetchedAt, iconBase }`.
- `ChampData` shape (used by every later task):

```js
{
  source: 'aramkit', sourceVersion: '16.19', dataDate: '2026-09-24', fetchedAt: 123, bracket: 'all',
  champion: { id, riotId, name, tier, rank, winRate, pickRate, games, icon },
  augments: { all: AugmentRow[], stages: { 1: AugmentRow[], 2: [...], 3: [...], 4: [...] } },
  build: { archetypes: Archetype[] },
  summoners: [{ spellIds: [4, 32], names: ['Flash', 'Mark'], winRate, pickRate, games }],
  skills: [{ order: 'E>Q>W', winRate, pickRate, games }],
}
AugmentRow = { id, name, rarity, tier, rank, winRate, pickRate, games, globalWinRate, icon }
Archetype  = { key, name, winRate, pickRate, games, core: Item[], starters: [{ items: Item[], winRate, pickRate, games }],
               boots: [{ item: Item, winRate, pickRate, games }], later: [{ item: Item, winRate, pickRate, games }],
               routeWinRate, routePickRate, routeGames }
Item = { id, name, icon }
```

- [ ] **Step 1: Write the failing test** `test/data/aramkit/normalize.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAramkit } from '../../../src/data/aramkit/normalize.js';
import { NormalizeError } from '../../../src/data/model.js';
import { fixture, aramkitResources } from '../../helpers/fixtures.js';

const raw = fixture('aramkit', 'champion-details-157-all.json');
const resources = aramkitResources();
const meta = { version: '16.19', dataDate: '2026-09-24', bracket: 'all', fetchedAt: 42, iconBase: 'https://data.aramkit.com/' };
const data = normalizeAramkit(raw, resources, meta);

test('meta and champion', () => {
  assert.equal(data.source, 'aramkit');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.dataDate, '2026-09-24');
  assert.equal(data.fetchedAt, 42);
  assert.equal(data.bracket, 'all');
  assert.deepEqual(data.champion, {
    id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: 1,
    winRate: 0.5764, pickRate: 0.1083, games: 804398,
    icon: 'https://data.aramkit.com/assets/champion/157-617df344cd83.webp',
  });
});

test('augments.all joined with names, rarity, icon', () => {
  assert.equal(data.augments.all.length, 126);
  const mp = data.augments.all.find((a) => a.id === 1058);
  assert.deepEqual(mp, {
    id: 1058, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1,
    winRate: 0.6517, pickRate: 0.1477, games: 112923, globalWinRate: 0.5128,
    icon: 'https://data.aramkit.com/assets/augment/1058-9450203898b2.webp',
  });
  const rarities = new Set(data.augments.all.map((a) => a.rarity));
  assert.deepEqual([...rarities].sort(), ['gold', 'prismatic', 'silver']);
});

test('stages 1-4 present with per-stage rows', () => {
  assert.deepEqual([1, 2, 3, 4].map((s) => data.augments.stages[s].length), [115, 123, 111, 109]);
  const first = data.augments.stages[1][0];
  assert.equal(first.id, 2009);
  assert.equal(first.name, 'Zealot');
  assert.equal(first.winRate, 0.68);
});

test('archetypes flattened from top profile top route', () => {
  const keys = data.build.archetypes.map((a) => a.key);
  assert.deepEqual(keys, ['crit', 'bruiser', 'ad', 'on_hit']);
  const crit = data.build.archetypes[0];
  assert.equal(crit.name, 'Crit');
  assert.equal(crit.winRate, 0.6011);
  assert.equal(crit.pickRate, 0.5979);
  assert.equal(crit.games, 300925);
  assert.deepEqual(crit.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.equal(crit.core[0].name, 'Yun Tal Wildarrows');
  assert.equal(crit.core[1].name, 'Rite of Ruin');
  assert.match(crit.core[0].icon, /^https:\/\/data\.aramkit\.com\/assets\/item\/3032-/);
  assert.deepEqual(crit.starters[0].items.map((i) => i.id), [1038]);
  assert.equal(crit.starters[0].pickRate, 0.5027);
  assert.equal(crit.boots[0].item.id, 3006);
  assert.equal(crit.boots[0].item.name, "Berserker's Greaves");
  assert.ok(crit.boots.every((b) => b.item.id !== 0), 'No Boots (id 0) is dropped');
  assert.deepEqual(crit.later.map((l) => l.item.id), [3153, 3031, 3065, 6665, 3033, 3143]);
  assert.equal(crit.routeWinRate, 0.657);
  assert.equal(crit.routeGames, 19097);
});

test('summoners and skills', () => {
  assert.deepEqual(data.summoners[0], { spellIds: [4, 32], names: ['Flash', 'Mark'], winRate: 0.5783, pickRate: 0.9149, games: 735948 });
  assert.deepEqual(data.skills[0], { order: 'E>Q>W', winRate: 0.6119, pickRate: 0.1979, games: 151461 });
});

test('unknown resource ids degrade to placeholders', () => {
  const d = normalizeAramkit(raw, { champions: {}, augments: {}, items: {}, spells: {}, archetypes: {} }, meta);
  assert.equal(d.champion.name, '#157');
  assert.equal(d.champion.riotId, null);
  const mp = d.augments.all.find((a) => a.id === 1058);
  assert.equal(mp.name, '#1058');
  assert.equal(mp.rarity, 'unknown');
  assert.equal(mp.icon, null);
  assert.equal(d.build.archetypes[0].name, 'crit');
  assert.equal(d.build.archetypes[0].core[0].name, '#3032');
  assert.deepEqual(d.summoners[0].names, ['#4', '#32']);
});

test('missing champion or empty augments throws NormalizeError', () => {
  assert.throws(() => normalizeAramkit({}, resources, meta), NormalizeError);
  assert.throws(() => normalizeAramkit({ champion: { id: 1 }, augments: { all: [] } }, resources, meta), /augments\.all empty/);
});

test('missing optional sections give empty arrays', () => {
  const d = normalizeAramkit({ champion: { id: 1, stats: {} }, augments: { all: [{ id: 1058, winRate: 0.5 }] } }, resources, meta);
  assert.deepEqual(d.build.archetypes, []);
  assert.deepEqual(d.summoners, []);
  assert.deepEqual(d.skills, []);
  assert.deepEqual(d.augments.stages, { 1: [], 2: [], 3: [], 4: [] });
  assert.equal(d.augments.all[0].games, 0);
  assert.equal(d.augments.all[0].globalWinRate, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data/aramkit/normalize.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/data/aramkit/normalize.js`**

```js
import { NormalizeError, STAGES } from '../model.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const byPickDesc = (a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0);

export function normalizeAramkit(raw, resources, meta) {
  const { champions = {}, augments = {}, items = {}, spells = {}, archetypes = {} } = resources ?? {};
  const iconBase = meta?.iconBase ?? 'https://data.aramkit.com/';
  const icon = (p) => (p ? iconBase + p : null);

  const champRaw = raw?.champion;
  if (!champRaw || !Number.isInteger(champRaw.id)) throw new NormalizeError('aramkit: champion.id missing');
  const allRaw = raw?.augments?.all;
  if (!Array.isArray(allRaw) || allRaw.length === 0) throw new NormalizeError('aramkit: augments.all empty', { championId: champRaw.id });

  const champRes = champions[champRaw.id] ?? {};
  const stat = (s) => ({ winRate: num(s?.winRate), pickRate: num(s?.pickRate), games: s?.sampleCount ?? 0 });
  const item = (ref) => {
    const id = ref?.id;
    const r = items[id];
    return { id, name: r?.name ?? `#${id}`, icon: icon(r?.icon) };
  };
  const augRow = (a) => {
    const r = augments[a.id];
    return {
      id: a.id, name: r?.name ?? `#${a.id}`, rarity: r?.rarity ?? 'unknown',
      tier: a.tier ?? null, rank: a.rank ?? null,
      winRate: num(a.winRate), pickRate: num(a.pickRate), games: a.sampleCount ?? 0,
      globalWinRate: num(a.augmentWinRate), icon: icon(r?.icon),
    };
  };

  const stages = {};
  for (const s of STAGES) stages[s] = (raw.augments.stages?.[s] ?? []).map(augRow);

  const archetypeRows = [];
  for (const a of raw.builds?.filtered?.archetypes ?? []) {
    const route = a.profiles?.[0]?.routes?.[0];
    if (!route || !Array.isArray(route.purchaseOrder)) continue;
    archetypeRows.push({
      key: a.key,
      name: archetypes[a.key]?.name ?? a.key,
      winRate: num(a.winRate), pickRate: num(a.pickRate), games: a.sampleCount ?? 0,
      core: route.purchaseOrder.map(item),
      starters: (route.starters ?? []).map((s) => ({ items: (s.items ?? []).map(item), ...stat(s) })).sort(byPickDesc),
      boots: (route.boots ?? []).filter((b) => b.item && b.item.id).map((b) => ({ item: item(b.item), ...stat(b) })).sort(byPickDesc),
      later: (route.laterItems ?? []).slice().sort(byPickDesc).slice(0, 6).map((l) => ({ item: item(l.item), ...stat(l) })),
      routeWinRate: num(route.winRate), routePickRate: num(route.pickRate), routeGames: route.sampleCount ?? 0,
    });
  }

  return {
    source: 'aramkit',
    sourceVersion: meta.version,
    dataDate: meta.dataDate ?? null,
    fetchedAt: meta.fetchedAt,
    bracket: meta.bracket,
    champion: {
      id: champRaw.id,
      riotId: champRes.riotId ?? null,
      name: champRes.name ?? `#${champRaw.id}`,
      tier: champRaw.tier ?? null,
      rank: champRaw.rank ?? null,
      winRate: num(champRaw.stats?.winRate),
      pickRate: num(champRaw.stats?.pickRate),
      games: champRaw.stats?.sampleCount ?? 0,
      icon: icon(champRes.icon),
    },
    augments: { all: allRaw.map(augRow), stages },
    build: { archetypes: archetypeRows },
    summoners: (raw.summoners ?? []).map((s) => {
      const ids = (s.spells ?? []).map((x) => x.id);
      return { spellIds: ids, names: ids.map((id) => spells[id]?.name ?? `#${id}`), ...stat(s) };
    }),
    skills: (raw.skills ?? []).map((s) => ({ order: s.order, ...stat(s) })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data/aramkit/normalize.test.js`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/data/aramkit/normalize.js test/data/aramkit/normalize.test.js
git commit -m "feat: aramkit normalizer to ChampData"
```

---

### Task 6: aramkit adapter (version + resources caching)

**Files:**
- Create: `src/data/aramkit/adapter.js`, `test/data/aramkit/adapter.test.js`

**Interfaces:**
- Consumes: client from Task 4 (`latestVersion()`, `champion(id, bracket, entry)`, `resource(name, entry)`), cache from Task 2, `normalizeAramkit`, `createChampionIndex`.
- Produces the **DataSource interface** every adapter implements:

```js
{ name: string, enabled: boolean,
  supportsBracket(bracket) → boolean, supportsStages() → boolean,
  async version() → string,                 // current data version
  async champion(id, bracket) → ChampData }
```
  plus aramkit extras `versionEntry()`, `resources()`, `championIndex()`.

- [ ] **Step 1: Write the failing test** `test/data/aramkit/adapter.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramkitAdapter } from '../../../src/data/aramkit/adapter.js';
import { createCache } from '../../../src/data/cache.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture, aramkitResources } from '../../helpers/fixtures.js';

const versions = fixture('aramkit', 'versions.json');
const champ157 = fixture('aramkit', 'champion-details-157-all.json');
const res = aramkitResources();
const RESOURCE_FILES = { champions: res.champions, augments: res.augments, items: res.items, 'summoner-spells': res.spells, archetypes: res.archetypes };

function fakeClient() {
  const calls = { latestVersion: 0, champion: [], resource: [] };
  return {
    calls,
    async latestVersion() { calls.latestVersion++; return versions.versions[0]; },
    async champion(id, bracket) { calls.champion.push([id, bracket]); if (id !== 157) throw new Error('no such champ'); return champ157; },
    async resource(name) { calls.resource.push(name); return RESOURCE_FILES[name]; },
  };
}

function setup({ fs = createMemFs(), t = 1_000_000 } = {}) {
  const clock = { t };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const client = fakeClient();
  const adapter = createAramkitAdapter({ client, cache, now: () => clock.t });
  return { adapter, client, cache, fs, clock };
}

test('interface flags', () => {
  const { adapter } = setup();
  assert.equal(adapter.name, 'aramkit');
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.supportsBracket('all'), true);
  assert.equal(adapter.supportsBracket('high'), true);
  assert.equal(adapter.supportsBracket('mid'), false);
  assert.equal(adapter.supportsStages(), true);
});

test('version comes from latest entry and is cached for 6h', async () => {
  const { adapter, client, clock } = setup();
  assert.equal(await adapter.version(), '16.19');
  assert.equal(await adapter.version(), '16.19');
  assert.equal(client.calls.latestVersion, 1);
  clock.t += 6 * 3600_000;
  await adapter.version();
  assert.equal(client.calls.latestVersion, 2);
});

test('champion fetches resources once and normalizes', async () => {
  const { adapter, client } = setup();
  const data = await adapter.champion(157, 'all');
  assert.equal(data.champion.name, 'Yasuo');
  assert.equal(data.bracket, 'all');
  assert.equal(data.sourceVersion, '16.19');
  assert.equal(data.fetchedAt, 1_000_000);
  assert.equal(client.calls.resource.length, 5);
  await adapter.champion(157, 'high');
  assert.equal(client.calls.resource.length, 5, 'resources reused in memory');
  assert.deepEqual(client.calls.champion, [[157, 'all'], [157, 'high']]);
});

test('resources are read from disk cache by a fresh adapter when resourcePath matches', async () => {
  const fs = createMemFs();
  const a = setup({ fs });
  await a.adapter.champion(157, 'all');
  const b = setup({ fs });
  await b.adapter.champion(157, 'all');
  assert.equal(b.client.calls.resource.length, 0);
});

test('championIndex is built from resources', async () => {
  const { adapter } = setup();
  const index = await adapter.championIndex();
  assert.equal(index.byRiotId('monkeyking').id, 62);
});

test('client errors propagate', async () => {
  const { adapter } = setup();
  await assert.rejects(adapter.champion(1, 'all'), /no such champ/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data/aramkit/adapter.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/data/aramkit/adapter.js`**

```js
import { createChampionIndex } from '../champions.js';
import { normalizeAramkit } from './normalize.js';
import { ARAMKIT_BASE } from './client.js';

// ChampData resource field → aramkit resource file name
const RESOURCE_FIELDS = Object.freeze({
  champions: 'champions',
  augments: 'augments',
  items: 'items',
  spells: 'summoner-spells',
  archetypes: 'archetypes',
});

export function createAramkitAdapter({ client, cache, now = Date.now, versionTtlMs = 6 * 3600 * 1000 }) {
  let entry = null;
  let entryAt = -Infinity;
  let entryPromise = null;
  let resourcesMemo = null; // { resourcePath, data }

  function versionEntry() {
    if (entry && now() - entryAt < versionTtlMs) return Promise.resolve(entry);
    if (!entryPromise) {
      entryPromise = client.latestVersion()
        .then((e) => { entry = e; entryAt = now(); return e; })
        .finally(() => { entryPromise = null; });
    }
    return entryPromise;
  }

  async function resources() {
    const e = await versionEntry();
    if (resourcesMemo && resourcesMemo.resourcePath === e.resourcePath) return resourcesMemo.data;
    const data = {};
    for (const [field, name] of Object.entries(RESOURCE_FIELDS)) {
      const key = ['aramkit', 'resources', name];
      const hit = await cache.get(key);
      if (hit && hit.value && hit.value.resourcePath === e.resourcePath) { data[field] = hit.value.data; continue; }
      const fetched = await client.resource(name, e);
      await cache.set(key, { resourcePath: e.resourcePath, data: fetched });
      data[field] = fetched;
    }
    resourcesMemo = { resourcePath: e.resourcePath, data };
    return data;
  }

  return {
    name: 'aramkit',
    enabled: true,
    supportsBracket: (b) => b === 'all' || b === 'high',
    supportsStages: () => true,
    version: async () => (await versionEntry()).version,
    versionEntry,
    resources,
    async champion(id, bracket) {
      const e = await versionEntry();
      const [raw, res] = await Promise.all([client.champion(id, bracket, e), resources()]);
      return normalizeAramkit(raw, res, {
        version: e.version, dataDate: e.dataDate ?? null, bracket, fetchedAt: now(), iconBase: `${ARAMKIT_BASE}/`,
      });
    },
    async championIndex() {
      return createChampionIndex((await resources()).champions);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data/aramkit/adapter.test.js`
Expected: 6 passing.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: all passing.

```bash
git add src/data/aramkit/adapter.js test/data/aramkit/adapter.test.js
git commit -m "feat: aramkit adapter with version and resource caching"
```

---

### Task 7: Augment ranking (pure)

**Files:**
- Create: `src/rank/augments.js`, `test/rank/augments.test.js`

**Interfaces:**
- Consumes: `RARITIES`, `TIER_ORDER`, `stageFromLevel` from model; `ChampData` from Task 5.
- Produces: `resolveStage(champData, { stage, level }) → 1|2|3|4|'all'`, `compareRows(a, b)`, `shapeAugments(champData, { stage = 'auto', level = null, minGames = 200 }) → { stageUsed, columns: { prismatic: Row[], gold: Row[], silver: Row[] }, unknown: Row[] }` where `Row = AugmentRow & { lift: number|null, lowSample: boolean }`.
- `stage` option accepts `'auto'`, `'all'`, or `1..4` (number or numeric string).

- [ ] **Step 1: Write the failing test** `test/rank/augments.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeAugments, resolveStage, compareRows } from '../../src/rank/augments.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const real = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });

const row = (over) => ({ id: 1, name: 'x', rarity: 'gold', tier: 'B', rank: 1, winRate: 0.5, pickRate: 0.1, games: 1000, globalWinRate: 0.5, icon: null, ...over });
const synthetic = (all, stages = {}) => ({ champion: { id: 1, winRate: 0.5 }, augments: { all, stages: { 1: [], 2: [], 3: [], 4: [], ...stages } } });

test('resolveStage: auto uses level, falls back to all when stage empty', () => {
  assert.equal(resolveStage(real, { stage: 'auto', level: 7 }), 2);
  assert.equal(resolveStage(real, { stage: 'auto', level: null }), 'all');
  assert.equal(resolveStage(real, { stage: 3 }), 3);
  assert.equal(resolveStage(real, { stage: '4' }), 4);
  assert.equal(resolveStage(real, { stage: 'all', level: 15 }), 'all');
  assert.equal(resolveStage(real, { stage: 9 }), 'all');
  assert.equal(resolveStage(synthetic([row()]), { stage: 2 }), 'all');
});

test('groups by rarity, unknown separate, stageUsed reported', () => {
  const out = shapeAugments(real, { stage: 'auto', level: 1 });
  assert.equal(out.stageUsed, 1);
  assert.equal(out.columns.prismatic.length + out.columns.gold.length + out.columns.silver.length + out.unknown.length, 115);
  assert.deepEqual(out.unknown, []);
  const all = shapeAugments(real, { stage: 'all' });
  assert.equal(all.stageUsed, 'all');
  const mp = all.columns.prismatic.find((r) => r.id === 1058);
  assert.ok(Math.abs(mp.lift - (0.6517 - 0.5128)) < 1e-9);
  assert.equal(mp.lowSample, false);
});

test('sort: tier first, then winRate, then games; low sample last', () => {
  const rows = [
    row({ id: 1, tier: 'A', winRate: 0.60 }),
    row({ id: 2, tier: 'S', winRate: 0.55 }),
    row({ id: 3, tier: 'S', winRate: 0.58 }),
    row({ id: 4, tier: 'S', winRate: 0.70, games: 50 }),
    row({ id: 5, tier: null, winRate: 0.90 }),
    row({ id: 6, tier: 'S', winRate: 0.58, games: 5000 }),
  ];
  const out = shapeAugments(synthetic(rows), { stage: 'all', minGames: 200 });
  assert.deepEqual(out.columns.gold.map((r) => r.id), [6, 3, 2, 1, 5, 4]);
  assert.equal(out.columns.gold.at(-1).lowSample, true);
});

test('lift is null without globalWinRate; unknown rarity goes to unknown', () => {
  const out = shapeAugments(synthetic([row({ globalWinRate: null }), row({ id: 9, rarity: 'unknown' })]), { stage: 'all' });
  assert.equal(out.columns.gold[0].lift, null);
  assert.equal(out.unknown.length, 1);
});

test('compareRows is a valid comparator for equal rows', () => {
  assert.equal(compareRows(row(), row()), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rank/augments.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/rank/augments.js`**

```js
import { RARITIES, TIER_ORDER, stageFromLevel } from '../data/model.js';

export function resolveStage(champData, { stage = 'auto', level = null } = {}) {
  const wanted = stage === 'auto' ? stageFromLevel(level) : stage;
  if (wanted === null || wanted === undefined || wanted === 'all') return 'all';
  const n = Number(wanted);
  if (![1, 2, 3, 4].includes(n)) return 'all';
  const rows = champData?.augments?.stages?.[n];
  return Array.isArray(rows) && rows.length > 0 ? n : 'all';
}

const tierRank = (t) => (t != null && Object.prototype.hasOwnProperty.call(TIER_ORDER, t) ? TIER_ORDER[t] : 99);

export function compareRows(a, b) {
  if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
  const ta = tierRank(a.tier);
  const tb = tierRank(b.tier);
  if (ta !== tb) return ta - tb;
  const wa = a.winRate ?? -1;
  const wb = b.winRate ?? -1;
  if (wa !== wb) return wb - wa;
  return (b.games ?? 0) - (a.games ?? 0);
}

export function shapeAugments(champData, { stage = 'auto', level = null, minGames = 200 } = {}) {
  const stageUsed = resolveStage(champData, { stage, level });
  const rows = stageUsed === 'all' ? champData.augments.all : champData.augments.stages[stageUsed];
  const columns = Object.fromEntries(RARITIES.map((r) => [r, []]));
  const unknown = [];
  for (const r of rows) {
    const lift = r.globalWinRate == null || r.winRate == null ? null : r.winRate - r.globalWinRate;
    const shaped = { ...r, lift, lowSample: (r.games ?? 0) < minGames };
    (columns[shaped.rarity] ?? unknown).push(shaped);
  }
  for (const r of RARITIES) columns[r].sort(compareRows);
  unknown.sort(compareRows);
  return { stageUsed, columns, unknown };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rank/augments.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/rank/augments.js test/rank/augments.test.js
git commit -m "feat: augment stage resolution, lift and ranking"
```

---

### Task 8: Build selection (pure)

**Files:**
- Create: `src/rank/builds.js`, `test/rank/builds.test.js`

**Interfaces:**
- Consumes: `ChampData.build.archetypes`, `summoners`, `skills` from Task 5.
- Produces: `pickBuild(champData, { minPick = 0.05 }) → null | { primary: { key, name, winRate, pickRate, games, starter: Item[], boots: Item|null, core: Item[], later: Item[], spells: string[], skillOrder: string|null, routeWinRate, routeGames }, alternatives: [{ key, name, winRate, pickRate, games }] }`.

- [ ] **Step 1: Write the failing test** `test/rank/builds.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBuild } from '../../src/rank/builds.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const real = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });

test('real data: crit is primary, route flattened, spells and skills chosen by WR with pick filter', () => {
  const b = pickBuild(real);
  assert.equal(b.primary.key, 'crit');
  assert.equal(b.primary.name, 'Crit');
  assert.equal(b.primary.winRate, 0.6011);
  assert.deepEqual(b.primary.starter.map((i) => i.id), [1038]);
  assert.equal(b.primary.boots.id, 3006);
  assert.deepEqual(b.primary.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.deepEqual(b.primary.later.map((i) => i.id), [3153, 3031, 3065, 6665, 3033, 3143]);
  assert.deepEqual(b.primary.spells, ['Flash', 'Mark']);
  assert.equal(b.primary.skillOrder, 'E>Q>W');
  assert.equal(b.primary.routeWinRate, 0.657);
  assert.deepEqual(b.alternatives.map((a) => a.key), ['bruiser', 'ad', 'on_hit']);
});

const arch = (over) => ({ key: 'k', name: 'K', winRate: 0.5, pickRate: 0.5, games: 100, core: [], starters: [], boots: [], later: [], routeWinRate: 0.5, routePickRate: 0.5, routeGames: 10, ...over });

test('no archetype passes pick filter → all considered', () => {
  const d = { build: { archetypes: [arch({ key: 'a', pickRate: 0.01, winRate: 0.6 }), arch({ key: 'b', pickRate: 0.02, winRate: 0.7 })] }, summoners: [], skills: [] };
  const b = pickBuild(d);
  assert.equal(b.primary.key, 'b');
  assert.deepEqual(b.primary.spells, []);
  assert.equal(b.primary.skillOrder, null);
  assert.equal(b.primary.boots, null);
});

test('ties broken by games', () => {
  const d = { build: { archetypes: [arch({ key: 'a', games: 10 }), arch({ key: 'b', games: 20 })] }, summoners: [], skills: [] };
  assert.equal(pickBuild(d).primary.key, 'b');
});

test('empty archetypes → null', () => {
  assert.equal(pickBuild({ build: { archetypes: [] }, summoners: [], skills: [] }), null);
  assert.equal(pickBuild({}), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rank/builds.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/rank/builds.js`**

```js
// Highest win rate among entries with pickRate >= minPick; if none qualify, among all.
function best(list, minPick) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const qualified = list.filter((x) => (x.pickRate ?? 0) >= minPick);
  const pool = qualified.length ? qualified : list;
  return pool.slice().sort((a, b) => ((b.winRate ?? -1) - (a.winRate ?? -1)) || ((b.games ?? 0) - (a.games ?? 0)))[0];
}

export function pickBuild(champData, { minPick = 0.05 } = {}) {
  const archetypes = champData?.build?.archetypes ?? [];
  if (archetypes.length === 0) return null;
  const primary = best(archetypes, minPick);
  const spells = best(champData.summoners, minPick);
  const skill = best(champData.skills, minPick);
  return {
    primary: {
      key: primary.key,
      name: primary.name,
      winRate: primary.winRate,
      pickRate: primary.pickRate,
      games: primary.games,
      starter: primary.starters[0]?.items ?? [],
      boots: primary.boots[0]?.item ?? null,
      core: primary.core,
      later: primary.later.map((l) => l.item),
      spells: spells?.names ?? [],
      skillOrder: skill?.order ?? null,
      routeWinRate: primary.routeWinRate,
      routeGames: primary.routeGames,
    },
    alternatives: archetypes
      .filter((a) => a !== primary)
      .map((a) => ({ key: a.key, name: a.name, winRate: a.winRate, pickRate: a.pickRate, games: a.games })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rank/builds.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/rank/builds.js test/rank/builds.test.js
git commit -m "feat: build archetype selection and route flattening"
```

---

### Task 9: Repository (cache → primary → fallback → stale)

**Files:**
- Create: `src/data/repository.js`, `test/data/repository.test.js`

**Interfaces:**
- Consumes: DataSource interface (Task 6), cache (Task 2), `DataUnavailable` (Task 3).
- Produces: `createRepository({ primary, fallback = null, cache }) → { getChamp(id, bracket = 'all', { force = false }) → { data: ChampData, stale: boolean, source: string, errors?: Error[] } }`. Throws `DataUnavailable` when nothing works.

- [ ] **Step 1: Write the failing test** `test/data/repository.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../../src/data/repository.js';
import { createCache } from '../../src/data/cache.js';
import { DataUnavailable } from '../../src/data/model.js';
import { createMemFs } from '../helpers/memfs.js';

function fakeAdapter(name, { enabled = true, version = 'v1', brackets = ['all', 'high'], fail = false, delayMs = 0 } = {}) {
  const calls = [];
  return {
    name, enabled, calls,
    supportsBracket: (b) => brackets.includes(b),
    supportsStages: () => true,
    async version() { if (fail === 'version') throw new Error('version down'); return version; },
    async champion(id, bracket) {
      calls.push([id, bracket]);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail === true) throw new Error(`${name} down`);
      return { source: name, sourceVersion: version, bracket, champion: { id }, augments: { all: [{ id: 1 }], stages: {} } };
    },
  };
}

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const fs = createMemFs();
  const cache = createCache({ dir: 'c', ttlMs: 1000, fs, now: () => clock.t });
  const primary = opts.primary ?? fakeAdapter('aramkit');
  const fallback = opts.fallback === undefined ? fakeAdapter('aramgg', { brackets: ['all'] }) : opts.fallback;
  return { repo: createRepository({ primary, fallback, cache }), primary, fallback, cache, clock };
}

test('primary hit is cached; second call does not refetch', async () => {
  const { repo, primary } = setup();
  const r1 = await repo.getChamp(157, 'all');
  assert.equal(r1.source, 'aramkit');
  assert.equal(r1.stale, false);
  const r2 = await repo.getChamp(157, 'all');
  assert.equal(r2.data.champion.id, 157);
  assert.equal(primary.calls.length, 1);
});

test('force bypasses cache', async () => {
  const { repo, primary } = setup();
  await repo.getChamp(157, 'all');
  await repo.getChamp(157, 'all', { force: true });
  assert.equal(primary.calls.length, 2);
});

test('expired cache refetches; version mismatch refetches', async () => {
  const { repo, primary, clock } = setup();
  await repo.getChamp(157, 'all');
  clock.t += 1000;
  await repo.getChamp(157, 'all');
  assert.equal(primary.calls.length, 2);
});

test('primary failure → fallback, bracket downgraded to all', async () => {
  const { repo, fallback } = setup({ primary: fakeAdapter('aramkit', { fail: true }) });
  const r = await repo.getChamp(157, 'high');
  assert.equal(r.source, 'aramgg');
  assert.deepEqual(fallback.calls, [[157, 'all']]);
  assert.equal(r.data.bracket, 'all');
});

test('primary version failure → fallback', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: 'version' }) });
  assert.equal((await repo.getChamp(157, 'all')).source, 'aramgg');
});

test('disabled fallback is skipped', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: true }), fallback: fakeAdapter('aramgg', { enabled: false }) });
  await assert.rejects(repo.getChamp(157, 'all'), DataUnavailable);
});

test('both fail with stale cache → stale result with errors', async () => {
  const primary = fakeAdapter('aramkit');
  const { repo, clock } = setup({ primary, fallback: null });
  await repo.getChamp(157, 'all');
  primary.champion = async () => { throw new Error('aramkit down'); };
  clock.t += 5000;
  const r = await repo.getChamp(157, 'all');
  assert.equal(r.stale, true);
  assert.equal(r.source, 'aramkit');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /aramkit: aramkit down/);
});

test('both fail without cache → DataUnavailable listing both', async () => {
  const { repo } = setup({ primary: fakeAdapter('aramkit', { fail: true }), fallback: fakeAdapter('aramgg', { fail: true }) });
  await assert.rejects(repo.getChamp(157, 'all'), (e) => e instanceof DataUnavailable && e.errors.length === 2);
});

test('concurrent calls for same champ share one fetch', async () => {
  const { repo, primary } = setup({ primary: fakeAdapter('aramkit', { delayMs: 5 }) });
  await Promise.all([repo.getChamp(157, 'all'), repo.getChamp(157, 'all')]);
  assert.equal(primary.calls.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data/repository.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/data/repository.js`**

```js
import { DataUnavailable } from './model.js';

function tagged(adapter, e) {
  const err = new Error(`${adapter.name}: ${e && e.message ? e.message : String(e)}`);
  err.cause = e;
  return err;
}

export function createRepository({ primary, fallback = null, cache }) {
  const inflight = new Map();

  function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function getChamp(id, bracket = 'all', { force = false } = {}) {
    const errors = [];
    const stale = [];
    for (const adapter of [primary, fallback]) {
      if (!adapter || !adapter.enabled) continue;
      const b = adapter.supportsBracket(bracket) ? bracket : 'all';
      const key = [adapter.name, b, `champ-${id}`];
      const cached = force ? null : await cache.get(key);

      let version = null;
      try { version = await adapter.version(); }
      catch (e) { errors.push(tagged(adapter, e)); }

      if (cached && cached.fresh && version && cached.value.sourceVersion === version) {
        return { data: cached.value, stale: false, source: adapter.name };
      }
      if (version) {
        try {
          const data = await dedupe(key.join('/'), () => adapter.champion(id, b));
          await cache.set(key, data);
          return { data, stale: false, source: adapter.name };
        } catch (e) { errors.push(tagged(adapter, e)); }
      }
      if (cached) stale.push({ data: cached.value, stale: true, source: adapter.name });
    }
    if (stale.length) return { ...stale[0], errors };
    throw new DataUnavailable(errors);
  }

  return { getChamp };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data/repository.test.js`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/data/repository.js test/data/repository.test.js
git commit -m "feat: repository chaining cache, primary, fallback, stale"
```

---

### Task 10: AppState store + payload builder

**Files:**
- Create: `src/server/state.js`, `test/server/state.test.js`

**Interfaces:**
- Consumes: `shapeAugments` (Task 7), `pickBuild` (Task 8), repository `getChamp` (Task 9), `EMPTY_GAME` (Task 3).
- Produces: `buildPayload({ game, loading, champData, view, source, stale, errors })` and
  `createAppState({ repository, now?, maxErrors = 10, log? }) → { getGame, getView, setGame(gameState), setView({ stage?, bracket? }), refresh(), pushError(scope, message), snapshot(), preview(id, { bracket, stage, force }) }`.
- `setGame`/`setView`/`refresh` return a promise that resolves when any triggered load finishes (callers may ignore it).
- Payload shape (what `/api/state` and `/api/champ/:id` return):

```js
{ game: GameState, loading: boolean,
  champ: { ...champData.champion, source } | null,
  view: { stage: 'auto'|'all'|1..4, bracket: 'all'|'high', stageUsed: 1..4|'all'|null },
  augments: { columns, unknown } | null,
  build: pickBuild(...) | null,
  meta: { source, version, dataDate, fetchedAt, bracket, stale } | null,
  errors: [{ scope, message, at }] }
```

- [ ] **Step 1: Write the failing test** `test/server/state.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server/state.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/state.js`**

```js
import { EMPTY_GAME } from '../data/model.js';
import { shapeAugments } from '../rank/augments.js';
import { pickBuild } from '../rank/builds.js';

export function buildPayload({ game, loading, champData, view, source, stale, errors }) {
  const augments = champData ? shapeAugments(champData, { stage: view.stage, level: game.level }) : null;
  return {
    game,
    loading,
    champ: champData ? { ...champData.champion, source } : null,
    view: { stage: view.stage, bracket: view.bracket, stageUsed: augments ? augments.stageUsed : null },
    augments: augments ? { columns: augments.columns, unknown: augments.unknown } : null,
    build: champData ? pickBuild(champData) : null,
    meta: champData
      ? { source, version: champData.sourceVersion, dataDate: champData.dataDate, fetchedAt: champData.fetchedAt, bracket: champData.bracket, stale: !!stale }
      : null,
    errors,
  };
}

export function createAppState({ repository, now = Date.now, maxErrors = 10, log = () => {} }) {
  let game = { ...EMPTY_GAME };
  const view = { stage: 'auto', bracket: 'all' };
  let current = null; // { id, bracket, data, source, stale }
  let loading = false;
  let loadSeq = 0;
  const errors = [];

  function pushError(scope, message) {
    errors.unshift({ scope, message, at: now() });
    errors.splice(maxErrors);
    log(`[${scope}] ${message}`);
  }

  async function load(id, bracket, { force = false } = {}) {
    const seq = ++loadSeq;
    loading = true;
    try {
      const r = await repository.getChamp(id, bracket, { force });
      if (seq !== loadSeq) return; // superseded by a newer request
      current = { id, bracket, data: r.data, source: r.source, stale: r.stale };
      for (const e of r.errors ?? []) pushError('data', e.message);
    } catch (e) {
      if (seq === loadSeq) { current = null; pushError('data', e.message); }
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function ensureLoaded({ force = false } = {}) {
    const id = game.championId;
    if (!id) return Promise.resolve();
    if (!force && current && current.id === id && current.bracket === view.bracket) return Promise.resolve();
    return load(id, view.bracket, { force });
  }

  return {
    getGame: () => game,
    getView: () => ({ ...view }),
    pushError,
    setGame(next) {
      const prevError = game.error;
      game = { ...next };
      if (next.error && next.error !== prevError) pushError('game', next.error);
      return ensureLoaded();
    },
    setView(patch = {}) {
      if (patch.stage !== undefined) view.stage = patch.stage;
      if (patch.bracket !== undefined) view.bracket = patch.bracket;
      return ensureLoaded();
    },
    refresh: () => ensureLoaded({ force: true }),
    snapshot() {
      const matches = current && current.id === game.championId;
      return buildPayload({
        game, loading,
        champData: matches ? current.data : null,
        view,
        source: matches ? current.source : null,
        stale: matches ? current.stale : false,
        errors: errors.slice(),
      });
    },
    async preview(id, { bracket = 'all', stage = 'auto', force = false } = {}) {
      const r = await repository.getChamp(id, bracket, { force });
      return buildPayload({ game, loading: false, champData: r.data, view: { stage, bracket }, source: r.source, stale: r.stale, errors: (r.errors ?? []).map((e) => ({ scope: 'data', message: e.message, at: now() })) });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server/state.test.js`
Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.js test/server/state.test.js
git commit -m "feat: app state store and api payload builder"
```

---

### Task 11: HTTP server, static page, first runnable `main.js`

After this task the app runs and the search box works without League running.

**Files:**
- Create: `src/server/http.js`, `test/server/http.test.js`, `public/index.html`, `public/style.css`, `public/app.js`, `src/main.js`

**Interfaces:**
- Consumes: AppState (Task 10), ChampionIndex (Task 3).
- Produces: `parseView(query) → { stage?, bracket? }` (throws on invalid), `createServer({ state, champIndex, publicDir }) → http.Server` (not listening).
- Routes: `GET /`, `/index.html`, `/app.js`, `/style.css`; `GET /api/state`; `GET /api/champions?q=`; `GET /api/champ/:id?bracket=&stage=&force=1`; `POST /api/view` `{ stage?, bracket? }`; `POST /api/refresh`. Errors: 400 `{ error }` for bad input, 503 for `DataUnavailable`, 404 otherwise.

- [ ] **Step 1: Write the failing test** `test/server/http.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server/http.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/server/http.js`**

```js
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseView(q) {
  const out = {};
  if (q.stage !== undefined) {
    const s = String(q.stage);
    if (s === 'auto' || s === 'all') out.stage = s;
    else if (['1', '2', '3', '4'].includes(s)) out.stage = Number(s);
    else throw new Error(`invalid stage: ${s}`);
  }
  if (q.bracket !== undefined) {
    if (!['all', 'high'].includes(q.bracket)) throw new Error(`invalid bracket: ${q.bracket}`);
    out.bracket = q.bracket;
  }
  return out;
}

export function createServer({ state, champIndex, publicDir }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = Object.fromEntries(url.searchParams);
      const p = url.pathname;

      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, await fs.readFile(path.join(publicDir, file)), type);
      }
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, state.snapshot());
      if (req.method === 'GET' && p === '/api/champions') return send(res, 200, champIndex.search(q.q ?? '', 10));

      const m = p.match(/^\/api\/champ\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const view = parseView(q);
        const payload = await state.preview(Number(m[1]), { bracket: view.bracket ?? 'all', stage: view.stage ?? 'auto', force: q.force === '1' });
        return send(res, 200, payload);
      }
      if (req.method === 'POST' && p === '/api/view') {
        const body = JSON.parse((await readBody(req)) || '{}');
        await state.setView(parseView(body));
        return send(res, 200, state.snapshot());
      }
      if (req.method === 'POST' && p === '/api/refresh') {
        await state.refresh();
        return send(res, 200, state.snapshot());
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e && e.name === 'DataUnavailable' ? 503 : 400;
      return send(res, status, { error: e && e.message ? e.message : String(e) });
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server/http.test.js`
Expected: 6 passing.

- [ ] **Step 5: Write `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ARAM Mayhem Overlay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header id="header">
    <div class="row">
      <img id="champ-icon" alt="" hidden>
      <div id="champ-title">Waiting for League…</div>
      <div id="game-info"></div>
      <div class="spacer"></div>
      <div class="search">
        <input id="search" type="search" placeholder="Search champion…" autocomplete="off">
        <ul id="search-results" hidden></ul>
      </div>
      <button id="live-btn" hidden title="Back to detected champion">Live</button>
      <button id="refresh-btn" title="Re-fetch data">↻</button>
    </div>
    <div class="row controls">
      <span>Stage:</span>
      <div class="tabs" id="stage-tabs">
        <button data-stage="auto">Auto</button>
        <button data-stage="all">All</button>
        <button data-stage="1">1</button>
        <button data-stage="2">2</button>
        <button data-stage="3">3</button>
        <button data-stage="4">4</button>
      </div>
      <span>Bracket:</span>
      <div class="tabs" id="bracket-tabs">
        <button data-bracket="all">All</button>
        <button data-bracket="high">High MMR</button>
      </div>
      <div class="spacer"></div>
      <div id="meta"></div>
    </div>
    <div id="banner" hidden></div>
  </header>
  <main id="main">
    <section class="col" id="col-prismatic"><h2 class="prismatic">Prismatic</h2><div class="rows"></div></section>
    <section class="col" id="col-gold"><h2 class="gold">Gold</h2><div class="rows"></div></section>
    <section class="col" id="col-silver"><h2 class="silver">Silver</h2><div class="rows"></div></section>
    <section class="col build" id="col-build"><h2>Build</h2><div id="build"></div></section>
  </main>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 6: Write `public/style.css`**

```css
:root {
  --bg: #0f1216; --panel: #171b21; --panel2: #1e242c; --text: #e8ecf1; --muted: #8a94a3;
  --prismatic: #7fe3ff; --gold: #f2c14e; --silver: #c3ccd6;
  --good: #4fd18b; --bad: #f06a6a; --warn: #f2c14e;
  --tier-S: #ff5c8a; --tier-A: #f2a14e; --tier-B: #e6d35a; --tier-C: #7cc6ff; --tier-D: #8a94a3;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.35 system-ui, "Segoe UI", sans-serif; }
button { font: inherit; color: inherit; background: var(--panel2); border: 1px solid #2c343f; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button.active { background: #2f5cff; border-color: #2f5cff; }
input { font: inherit; color: inherit; background: var(--panel2); border: 1px solid #2c343f; border-radius: 6px; padding: 6px 10px; width: 220px; }
#header { position: sticky; top: 0; background: var(--panel); padding: 10px 14px; border-bottom: 1px solid #2c343f; z-index: 2; }
.row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.controls { margin-top: 8px; color: var(--muted); }
.spacer { flex: 1; }
.tabs { display: flex; gap: 4px; }
#champ-icon { width: 44px; height: 44px; border-radius: 8px; }
#champ-title { font-size: 22px; font-weight: 700; }
#game-info, #meta { color: var(--muted); font-size: 14px; }
.search { position: relative; }
#search-results { position: absolute; top: 100%; left: 0; margin: 4px 0 0; padding: 4px; list-style: none; background: var(--panel2); border: 1px solid #2c343f; border-radius: 6px; min-width: 220px; z-index: 3; }
#search-results li { padding: 6px 10px; cursor: pointer; border-radius: 4px; }
#search-results li:hover { background: #2f5cff; }
#banner { margin-top: 8px; padding: 6px 10px; border-radius: 6px; background: #4a1f1f; color: #ffb3b3; font-size: 14px; }
#banner.warn { background: #4a3a1f; color: #ffe2a8; }
#main { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 12px 14px; }
@media (max-width: 1100px) { #main { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.col { background: var(--panel); border-radius: 10px; padding: 8px 10px; min-height: 200px; }
.col h2 { margin: 2px 0 8px; font-size: 18px; }
h2.prismatic { color: var(--prismatic); } h2.gold { color: var(--gold); } h2.silver { color: var(--silver); }
.aug { display: grid; grid-template-columns: 34px 1fr auto; gap: 8px; align-items: center; padding: 5px 6px; border-radius: 6px; }
.aug:nth-child(odd) { background: var(--panel2); }
.aug.low { opacity: 0.45; }
.aug img { width: 30px; height: 30px; border-radius: 6px; }
.aug .name { font-weight: 600; display: flex; gap: 6px; align-items: center; }
.aug .games { color: var(--muted); font-size: 12px; }
.aug .stats { text-align: right; white-space: nowrap; }
.aug .wr { font-weight: 700; }
.lift { font-size: 13px; }
.lift.pos { color: var(--good); } .lift.neg { color: var(--bad); }
.tier { display: inline-block; min-width: 20px; text-align: center; font-size: 12px; font-weight: 800; border-radius: 4px; padding: 1px 4px; background: #2c343f; }
.tier.S { color: var(--tier-S); } .tier.A { color: var(--tier-A); } .tier.B { color: var(--tier-B); } .tier.C { color: var(--tier-C); } .tier.D { color: var(--tier-D); }
.build dl { margin: 0; }
.build dt { color: var(--muted); font-size: 13px; margin-top: 8px; }
.build dd { margin: 2px 0 0; }
.items { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.item { display: inline-flex; align-items: center; gap: 4px; background: var(--panel2); border-radius: 6px; padding: 2px 6px; }
.item img { width: 24px; height: 24px; border-radius: 4px; }
.arrow { color: var(--muted); }
.alts { margin-top: 10px; color: var(--muted); font-size: 14px; }
.alts summary { cursor: pointer; }
.muted { color: var(--muted); }
```

- [ ] **Step 7: Write `public/app.js`**

```js
const POLL_MS = 2000;
const noIcons = new URLSearchParams(location.search).has('noicons');
const $ = (s) => document.querySelector(s);

let preview = null;          // { id, stage, bracket } when browsing a champion manually
let lastRendered = '';
let lastLiveChampionId = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
const signed = (v) => (v == null ? '' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1));
const kfmt = (n) => (n == null ? '' : n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const img = (src, cls = '') => (src && !noIcons ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '');

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function setBanner(text, kind = '') {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.className = kind;
}

async function tick() {
  try {
    const state = await api('/api/state');
    const liveId = state.game.championId;
    if (preview && liveId && liveId !== lastLiveChampionId) preview = null; // new game detected → back to live
    lastLiveChampionId = liveId;
    const payload = preview
      ? await api(`/api/champ/${preview.id}?stage=${preview.stage}&bracket=${preview.bracket}`)
      : state;
    const json = JSON.stringify(payload);
    if (json !== lastRendered) { lastRendered = json; render(payload, state); }
  } catch (e) {
    setBanner(`Server unreachable: ${e.message}`);
  }
}

function render(p, state) {
  $('#live-btn').hidden = !preview;
  const g = p.game;
  const c = p.champ;
  const icon = $('#champ-icon');
  if (c && c.icon && !noIcons) { icon.src = c.icon; icon.hidden = false; } else icon.hidden = true;
  $('#champ-title').innerHTML = c
    ? `${esc(c.name)} <span class="tier ${esc(c.tier ?? '')}">${esc(c.tier ?? '?')}</span> <span class="muted">${pct(c.winRate)} WR · ${kfmt(c.games)} games</span>`
    : (g.lcuConnected || g.liveConnected ? 'Waiting for champion…' : 'Waiting for League…');
  const phase = { none: 'Not in game', champselect: 'Champ select', loading: 'Loading screen', ingame: 'In game' }[g.phase] ?? g.phase;
  const queue = g.queueId === 2400 ? 'ARAM Mayhem' : g.queueId === 2450 ? 'Mayhem Classic' : g.queueId ? `queue ${g.queueId}` : '';
  $('#game-info').textContent = [preview ? 'Preview' : phase, queue, g.gameMode, g.level ? `lvl ${g.level}` : ''].filter(Boolean).join(' · ');

  const view = p.view;
  for (const b of document.querySelectorAll('#stage-tabs button')) {
    const s = b.dataset.stage;
    b.classList.toggle('active', String(view.stage) === s);
    b.textContent = s === 'auto' ? `Auto${view.stage === 'auto' && view.stageUsed ? ` (${view.stageUsed})` : ''}` : s === 'all' ? 'All' : s;
  }
  for (const b of document.querySelectorAll('#bracket-tabs button')) b.classList.toggle('active', view.bracket === b.dataset.bracket);

  const m = p.meta;
  $('#meta').textContent = m ? `${m.source} ${m.version} · data ${m.dataDate ?? '?'} · fetched ${ago(m.fetchedAt)}${m.stale ? ' · STALE' : ''}${p.loading ? ' · loading…' : ''}` : (p.loading ? 'loading…' : '');

  const err = p.errors?.[0];
  if (m && m.stale) setBanner(`Showing stale data: ${err ? err.message : 'sources unreachable'}`, 'warn');
  else if (err && !c) setBanner(`${err.scope}: ${err.message}`);
  else setBanner('');

  for (const r of ['prismatic', 'gold', 'silver']) {
    const rows = p.augments ? p.augments.columns[r] : [];
    $(`#col-${r} .rows`).innerHTML = rows.map(renderAugment).join('') || '<div class="muted">–</div>';
  }
  $('#build').innerHTML = renderBuild(p.build);
}

function renderAugment(a) {
  const lift = a.lift == null ? '' : `<span class="lift ${a.lift >= 0 ? 'pos' : 'neg'}">${signed(a.lift)}</span>`;
  return `<div class="aug${a.lowSample ? ' low' : ''}" title="${esc(a.name)} · pick ${pct(a.pickRate)}">
    ${img(a.icon)}
    <div><div class="name"><span class="tier ${esc(a.tier ?? '')}">${esc(a.tier ?? '·')}</span>${esc(a.name)}</div><div class="games">${kfmt(a.games)} games · pick ${pct(a.pickRate)}</div></div>
    <div class="stats"><div class="wr">${pct(a.winRate)}</div>${lift}</div>
  </div>`;
}

const itemList = (items, sep = '') => items.map((i) => `<span class="item">${img(i.icon)}${esc(i.name)}</span>`).join(sep ? `<span class="arrow">${sep}</span>` : '');

function renderBuild(b) {
  if (!b) return '<div class="muted">–</div>';
  const p = b.primary;
  const alts = b.alternatives.length
    ? `<details class="alts"><summary>Other builds (${b.alternatives.length})</summary>${b.alternatives.map((a) => `<div>${esc(a.name)} · ${pct(a.winRate)} WR · ${pct(a.pickRate, 0)} pick · ${kfmt(a.games)}</div>`).join('')}</details>`
    : '';
  return `<div><strong>${esc(p.name)}</strong> <span class="muted">${pct(p.winRate)} WR · ${pct(p.pickRate, 0)} pick · ${kfmt(p.games)} games</span></div>
  <dl>
    <dt>Start</dt><dd class="items">${itemList(p.starter) || '–'}</dd>
    <dt>Boots</dt><dd class="items">${p.boots ? itemList([p.boots]) : '–'}</dd>
    <dt>Core (route ${pct(p.routeWinRate)} WR)</dt><dd class="items">${itemList(p.core, '›') || '–'}</dd>
    <dt>Later</dt><dd class="items">${itemList(p.later) || '–'}</dd>
    <dt>Spells</dt><dd>${esc(p.spells.join(' + ')) || '–'}</dd>
    <dt>Skills</dt><dd>${esc(p.skillOrder ?? '–')}</dd>
  </dl>${alts}`;
}

// ---- controls ----
async function setView(patch) {
  if (preview) { Object.assign(preview, patch); }
  else await api('/api/view', { method: 'POST', body: JSON.stringify(patch) });
  lastRendered = '';
  tick();
}
$('#stage-tabs').addEventListener('click', (e) => { const s = e.target.dataset?.stage; if (s) setView({ stage: s }); });
$('#bracket-tabs').addEventListener('click', (e) => { const b = e.target.dataset?.bracket; if (b) setView({ bracket: b }); });
$('#refresh-btn').addEventListener('click', async () => {
  try {
    if (preview) await api(`/api/champ/${preview.id}?force=1&stage=${preview.stage}&bracket=${preview.bracket}`);
    else await api('/api/refresh', { method: 'POST', body: '{}' });
  } catch (e) { setBanner(e.message); }
  lastRendered = ''; tick();
});
$('#live-btn').addEventListener('click', () => { preview = null; lastRendered = ''; tick(); });

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const list = $('#search-results');
  if (!q) { list.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const results = await api(`/api/champions?q=${encodeURIComponent(q)}`);
    list.innerHTML = results.map((c) => `<li data-id="${c.id}">${esc(c.name)}</li>`).join('');
    list.hidden = results.length === 0;
  }, 200);
});
$('#search-results').addEventListener('click', (e) => {
  const id = e.target.dataset?.id;
  if (!id) return;
  const current = document.querySelector('#bracket-tabs .active')?.dataset.bracket ?? 'all';
  preview = { id: Number(id), stage: 'all', bracket: current };
  $('#search').value = '';
  $('#search-results').hidden = true;
  lastRendered = '';
  tick();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#search-results').hidden = true; });

tick();
setInterval(tick, POLL_MS);
```

- [ ] **Step 8: Write the first `src/main.js`** (data + server only; game detection is added in Task 16)

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createCache } from './data/cache.js';
import { createAramkitClient } from './data/aramkit/client.js';
import { createAramkitAdapter } from './data/aramkit/adapter.js';
import { createRepository } from './data/repository.js';
import { createChampionIndex } from './data/champions.js';
import { createAppState } from './server/state.js';
import { createServer } from './server/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cfg = loadConfig({ env, argv });
  const cache = createCache({ dir: cfg.cacheDir, ttlMs: cfg.cacheTtlMs });
  const aramkit = createAramkitAdapter({ client: createAramkitClient(), cache });
  const repository = createRepository({ primary: aramkit, fallback: null, cache });

  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    champIndex = createChampionIndex({});
    log(`WARN champion index unavailable: ${e.message}`);
  }

  const state = createAppState({ repository, log });
  if (champIndex.size === 0) state.pushError('startup', 'champion index unavailable; search and detection disabled until aramkit is reachable');

  const server = createServer({ state, champIndex, publicDir: path.join(here, '..', 'public') });
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const url = `http://localhost:${cfg.port}`;
  log(`overlay: ${url}`);
  if (cfg.open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return { server, stop: () => server.close() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 9: Smoke test by hand**

Run: `node src/main.js --port 3777`
Expected log: `champion index: 173 champions (aramkit 16.19)` then `overlay: http://localhost:3777`.
Open the URL, type `yas` in search, click Yasuo. Expect three augment columns with Mystic Punch at the top of Prismatic and a Crit build. Click stage tabs and bracket toggle; both re-render. `Ctrl+C` to stop.

- [ ] **Step 10: Commit**

```bash
git add src/server/http.js test/server/http.test.js public/ src/main.js
git commit -m "feat: http api, static page, runnable server with champion search"
```

---

### Task 12: `httpsGetJson` helper (insecure TLS scoped to localhost)

**Files:**
- Create: `src/util/httpsJson.js`, `test/util/httpsJson.test.js`

**Interfaces:**
- Produces: `httpsGetJson(url, { headers = {}, timeoutMs = 1500, rejectUnauthorized = false }) → Promise<{ status, body }>`. `body` is parsed JSON, or the raw text if not JSON, or `null` if empty. Rejects on connection error or timeout. Works for `http:` too (used by tests).

- [ ] **Step 1: Write the failing test** `test/util/httpsJson.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/util/httpsJson.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/util/httpsJson.js`**

```js
import http from 'node:http';
import https from 'node:https';

// GET a JSON document. rejectUnauthorized=false is intended ONLY for 127.0.0.1
// (League client / Live Client Data use self-signed certificates).
export function httpsGetJson(url, { headers = {}, timeoutMs = 1500, rejectUnauthorized = false } = {}) {
  const mod = url.startsWith('http:') ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', headers, rejectUnauthorized, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (text.length) { try { body = JSON.parse(text); } catch { body = text; } }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/util/httpsJson.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/util/httpsJson.js test/util/httpsJson.test.js
git commit -m "feat: httpsGetJson helper with timeout and scoped insecure tls"
```

---

### Task 13: LCU lockfile

**Files:**
- Create: `src/game/lockfile.js`, `test/game/lockfile.test.js`

**Interfaces:**
- Produces: `parseLockfile(text) → { name, pid, port, password, protocol }` (throws `malformed lockfile`), `readLockfile(filePath, { fs }) → parsed | null` (null when file missing, unreadable, or empty).

- [ ] **Step 1: Write the failing test** `test/game/lockfile.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile, readLockfile } from '../../src/game/lockfile.js';
import { createMemFs } from '../helpers/memfs.js';

test('parses the five colon-separated fields', () => {
  assert.deepEqual(parseLockfile('LeagueClient:1234:52345:abcDEF-xyz:https\n'), { name: 'LeagueClient', pid: 1234, port: 52345, password: 'abcDEF-xyz', protocol: 'https' });
});

test('rejects malformed content', () => {
  assert.throws(() => parseLockfile('garbage'), /malformed/);
  assert.throws(() => parseLockfile('LeagueClient:1:notaport:pw:https'), /malformed/);
  assert.throws(() => parseLockfile('LeagueClient:1:1000::https'), /malformed/);
});

test('readLockfile returns null when missing, empty, or unreadable', async () => {
  assert.equal(await readLockfile('C:/x/lockfile', { fs: createMemFs() }), null);
  assert.equal(await readLockfile('C:/x/lockfile', { fs: createMemFs({ 'C:/x/lockfile': '   ' }) }), null);
  const busy = { readFile: async () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } };
  assert.equal(await readLockfile('C:/x/lockfile', { fs: busy }), null);
});

test('readLockfile parses an existing file', async () => {
  const fs = createMemFs({ 'C:/Riot Games/League of Legends/lockfile': 'LeagueClient:9:60000:pw:https' });
  const lock = await readLockfile('C:\\Riot Games\\League of Legends\\lockfile', { fs });
  assert.equal(lock.port, 60000);
  assert.equal(lock.password, 'pw');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game/lockfile.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/lockfile.js`**

```js
// Lockfile format: LeagueClient:PID:PORT:PASSWORD:PROTOCOL
export function parseLockfile(text) {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length < 5) throw new Error('malformed lockfile');
  const [name, pid, port, password, protocol] = parts;
  const portN = Number(port);
  if (!Number.isInteger(portN) || portN <= 0 || !password) throw new Error('malformed lockfile');
  return { name, pid: Number(pid), port: portN, password, protocol };
}

// null = client not running (or file transiently unreadable). Never throws.
export async function readLockfile(filePath, { fs }) {
  let text;
  try { text = await fs.readFile(filePath, 'utf8'); } catch { return null; }
  if (!String(text).trim()) return null;
  try { return parseLockfile(text); } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/game/lockfile.test.js`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/game/lockfile.js test/game/lockfile.test.js
git commit -m "feat: lcu lockfile parsing"
```

---

### Task 14: Live Client Data snapshot

**Files:**
- Create: `src/game/liveclient.js`, `test/game/liveclient.test.js`, `test/fixtures/liveclient/allgamedata.json`

**Interfaces:**
- Consumes: `httpsGetJson`-shaped `getJson(url, opts) → { status, body }`.
- Produces: `LIVE_URL`, `stripChampionPrefix(raw)`, `extractActive(allgamedata) → { championRiotId, championName, level, gameMode } | null`, `createLiveClient({ getJson, url?, timeoutMs? }) → { snapshot() → { connected: true, championRiotId, championName, level, gameMode } | { connected: false } }`.

- [ ] **Step 1: Write the fixture** `test/fixtures/liveclient/allgamedata.json` (hand-written, minimal subset of the Riot Live Client Data shape)

```json
{
  "activePlayer": { "riotId": "Boyd#NA1", "riotIdGameName": "Boyd", "riotIdTagLine": "NA1", "summonerName": "Boyd", "level": 7, "currentGold": 1234.5 },
  "allPlayers": [
    { "riotId": "Other#NA1", "summonerName": "Other", "championName": "Annie", "rawChampionName": "game_character_displayname_Annie", "team": "ORDER", "level": 6 },
    { "riotId": "Boyd#NA1", "summonerName": "Boyd", "championName": "Wukong", "rawChampionName": "game_character_displayname_MonkeyKing", "team": "ORDER", "level": 7 }
  ],
  "gameData": { "gameMode": "ARAM", "gameTime": 412.7, "mapName": "Map12", "mapNumber": 12, "mapTerrain": "Default" }
}
```

- [ ] **Step 2: Write the failing test** `test/game/liveclient.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripChampionPrefix, extractActive, createLiveClient, LIVE_URL } from '../../src/game/liveclient.js';
import { fixture } from '../helpers/fixtures.js';

const data = fixture('liveclient', 'allgamedata.json');

test('stripChampionPrefix', () => {
  assert.equal(stripChampionPrefix('game_character_displayname_MonkeyKing'), 'MonkeyKing');
  assert.equal(stripChampionPrefix('Yasuo'), 'Yasuo');
  assert.equal(stripChampionPrefix(null), null);
});

test('extractActive matches by riotId', () => {
  assert.deepEqual(extractActive(data), { championRiotId: 'MonkeyKing', championName: 'Wukong', level: 7, gameMode: 'ARAM' });
});

test('extractActive falls back to summonerName and tolerates missing fields', () => {
  const d = JSON.parse(JSON.stringify(data));
  delete d.activePlayer.riotId;
  delete d.allPlayers[1].riotId;
  delete d.activePlayer.level;
  delete d.gameData;
  assert.deepEqual(extractActive(d), { championRiotId: 'MonkeyKing', championName: 'Wukong', level: null, gameMode: null });
  assert.equal(extractActive({}), null);
  assert.equal(extractActive({ activePlayer: { riotId: 'x' }, allPlayers: [] }), null);
});

test('snapshot connected', async () => {
  const calls = [];
  const live = createLiveClient({ getJson: async (url, opts) => { calls.push([url, opts]); return { status: 200, body: data }; } });
  const s = await live.snapshot();
  assert.equal(s.connected, true);
  assert.equal(s.championRiotId, 'MonkeyKing');
  assert.equal(s.level, 7);
  assert.equal(calls[0][0], LIVE_URL);
  assert.equal(calls[0][1].rejectUnauthorized, false);
});

test('snapshot disconnected on error, non-200, or no active player', async () => {
  assert.deepEqual(await createLiveClient({ getJson: async () => { throw new Error('ECONNREFUSED'); } }).snapshot(), { connected: false });
  assert.deepEqual(await createLiveClient({ getJson: async () => ({ status: 404, body: null }) }).snapshot(), { connected: false });
  assert.deepEqual(await createLiveClient({ getJson: async () => ({ status: 200, body: {} }) }).snapshot(), { connected: false });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/game/liveclient.test.js`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/game/liveclient.js`**

```js
export const LIVE_URL = 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const PREFIX = 'game_character_displayname_';

export function stripChampionPrefix(raw) {
  if (typeof raw !== 'string') return null;
  return raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
}

export function extractActive(data) {
  const ap = data?.activePlayer;
  const players = data?.allPlayers;
  if (!ap || !Array.isArray(players)) return null;
  const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
  const byRiot = ap.riotId ? players.find((p) => lower(p?.riotId) === lower(ap.riotId)) : null;
  const bySummoner = ap.summonerName ? players.find((p) => lower(p?.summonerName) === lower(ap.summonerName)) : null;
  const me = byRiot ?? bySummoner;
  if (!me) return null;
  return {
    championRiotId: stripChampionPrefix(me.rawChampionName) ?? me.championName ?? null,
    championName: me.championName ?? null,
    level: typeof ap.level === 'number' && Number.isFinite(ap.level) ? ap.level : null,
    gameMode: data?.gameData?.gameMode ?? null,
  };
}

export function createLiveClient({ getJson, url = LIVE_URL, timeoutMs = 1500 }) {
  return {
    async snapshot() {
      try {
        const { status, body } = await getJson(url, { timeoutMs, rejectUnauthorized: false });
        if (status !== 200) return { connected: false };
        const active = extractActive(body);
        return active ? { connected: true, ...active } : { connected: false };
      } catch {
        return { connected: false };
      }
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/game/liveclient.test.js`
Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add src/game/liveclient.js test/game/liveclient.test.js test/fixtures/liveclient/allgamedata.json
git commit -m "feat: live client data snapshot"
```

---

### Task 15: LCU snapshot (phase, queue, champ-select pick)

**Files:**
- Create: `src/game/lcu.js`, `test/game/lcu.test.js`

**Interfaces:**
- Consumes: `readLockfile` thunk (`() → Promise<lock|null>`), `getJson`.
- Produces: `pickedChampion(champSelectSession) → number | null`, `createLcuClient({ readLockfile, getJson, timeoutMs? }) → { snapshot() → { connected: true, phase, queueId, championId } | { connected: false } }`.
- LCU endpoints: `GET /lol-gameflow/v1/gameflow-phase` (JSON string), `GET /lol-gameflow/v1/session` (`gameData.queue.id`), `GET /lol-champ-select/v1/session` (`localPlayerCellId`, `myTeam[{cellId, championId}]`). Auth: `Basic base64("riot:" + password)`.

- [ ] **Step 1: Write the failing test** `test/game/lcu.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLcuClient, pickedChampion } from '../../src/game/lcu.js';

const lock = { port: 55555, password: 'secret' };
function fakeGetJson(routes) {
  const calls = [];
  return {
    calls,
    getJson: async (url, opts) => {
      calls.push([url, opts]);
      const p = new URL(url).pathname;
      if (!(p in routes)) return { status: 404, body: null };
      const v = routes[p];
      if (v instanceof Error) throw v;
      return { status: 200, body: v };
    },
  };
}

test('pickedChampion reads my cell', () => {
  const cs = { localPlayerCellId: 2, myTeam: [{ cellId: 1, championId: 1 }, { cellId: 2, championId: 157 }] };
  assert.equal(pickedChampion(cs), 157);
  assert.equal(pickedChampion({ localPlayerCellId: 2, myTeam: [{ cellId: 2, championId: 0 }] }), null);
  assert.equal(pickedChampion({}), null);
});

test('no lockfile → disconnected, no requests', async () => {
  const { getJson, calls } = fakeGetJson({});
  const lcu = createLcuClient({ readLockfile: async () => null, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: false });
  assert.equal(calls.length, 0);
});

test('champ select: phase, queue, picked champion; auth header and insecure tls', async () => {
  const { getJson, calls } = fakeGetJson({
    '/lol-gameflow/v1/gameflow-phase': 'ChampSelect',
    '/lol-gameflow/v1/session': { gameData: { queue: { id: 2400 } } },
    '/lol-champ-select/v1/session': { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 62 }] },
  });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 62 });
  assert.match(calls[0][0], /^https:\/\/127\.0\.0\.1:55555\//);
  assert.equal(calls[0][1].headers.authorization, 'Basic ' + Buffer.from('riot:secret').toString('base64'));
  assert.equal(calls[0][1].rejectUnauthorized, false);
});

test('in progress: no champ-select call; session failure leaves queue null', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'InProgress' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'InProgress', queueId: null, championId: null });
  assert.ok(!calls.some(([u]) => u.includes('champ-select')));
});

test('phase None skips session lookup', async () => {
  const { getJson, calls } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'None' });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: true, phase: 'None', queueId: null, championId: null });
  assert.equal(calls.length, 1);
});

test('phase request failure → disconnected', async () => {
  const { getJson } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': new Error('ECONNREFUSED') });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  assert.deepEqual(await lcu.snapshot(), { connected: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game/lcu.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/lcu.js`**

```js
export function pickedChampion(cs) {
  const me = (cs?.myTeam ?? []).find((p) => p && p.cellId === cs.localPlayerCellId);
  const id = me?.championId;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createLcuClient({ readLockfile, getJson, timeoutMs = 1500 }) {
  async function request(lock, path) {
    const { status, body } = await getJson(`https://127.0.0.1:${lock.port}${path}`, {
      headers: { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' },
      timeoutMs,
      rejectUnauthorized: false,
    });
    if (status !== 200) throw new Error(`LCU ${status} ${path}`);
    return body;
  }

  return {
    async snapshot() {
      let lock = null;
      try { lock = await readLockfile(); } catch { lock = null; }
      if (!lock) return { connected: false };
      try {
        const phase = String(await request(lock, '/lol-gameflow/v1/gameflow-phase'));
        let queueId = null;
        let championId = null;
        if (phase !== 'None') {
          try {
            const session = await request(lock, '/lol-gameflow/v1/session');
            const id = session?.gameData?.queue?.id;
            queueId = Number.isInteger(id) ? id : null;
          } catch { /* queue unknown */ }
        }
        if (phase === 'ChampSelect') {
          try { championId = pickedChampion(await request(lock, '/lol-champ-select/v1/session')); }
          catch { /* not picked yet */ }
        }
        return { connected: true, phase, queueId, championId };
      } catch {
        return { connected: false };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/game/lcu.test.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/game/lcu.js test/game/lcu.test.js
git commit -m "feat: lcu snapshot for phase, queue and champ select pick"
```

---

### Task 16: Detector (reducer + poller) and wiring into `main.js`

**Files:**
- Create: `src/game/detector.js`, `test/game/detector.test.js`
- Modify: `src/main.js` (replace whole file with the version below)

**Interfaces:**
- Consumes: `EMPTY_GAME`, `stageFromLevel` (Task 3), ChampionIndex, LCU + Live snapshots (Tasks 14–15), `state.setGame` (Task 10).
- Produces: `reduceGameState(prev, { lcu, live }, champIndex, now) → GameState`, `sameState(a, b)`, `createDetector({ lcu, live, champIndex, onChange, pollMs?, now?, initial? }) → { tick(), start(), stop(), getState() }`.

- [ ] **Step 1: Write the failing test** `test/game/detector.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceGameState, sameState, createDetector } from '../../src/game/detector.js';
import { EMPTY_GAME } from '../../src/data/model.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const now = () => 99;
const OFF = { connected: false };
const reduce = (prev, snaps) => reduceGameState(prev, snaps, index, now);

test('nothing connected → none, previous champion retained, level cleared', () => {
  const prev = { ...EMPTY_GAME, phase: 'ingame', championId: 157, riotId: 'Yasuo', level: 9, stage: 2, queueId: 2400 };
  const s = reduce(prev, { lcu: OFF, live: OFF });
  assert.equal(s.phase, 'none');
  assert.equal(s.championId, 157);
  assert.equal(s.level, null);
  assert.equal(s.stage, null);
  assert.equal(s.queueId, null);
  assert.equal(s.lcuConnected, false);
  assert.equal(s.updatedAt, 99);
});

test('live connected → ingame with champion, level, stage, gameMode', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'InProgress', queueId: 2400, championId: null }, live: { connected: true, championRiotId: 'MonkeyKing', championName: 'Wukong', level: 11, gameMode: 'ARAM' } });
  assert.equal(s.phase, 'ingame');
  assert.equal(s.championId, 62);
  assert.equal(s.riotId, 'MonkeyKing');
  assert.equal(s.level, 11);
  assert.equal(s.stage, 3);
  assert.equal(s.gameMode, 'ARAM');
  assert.equal(s.queueId, 2400);
  assert.equal(s.liveConnected, true);
});

test('live unknown champion → error and null championId', () => {
  const s = reduce(EMPTY_GAME, { lcu: OFF, live: { connected: true, championRiotId: 'NewChamp', level: 1, gameMode: 'ARAM' } });
  assert.equal(s.championId, null);
  assert.match(s.error, /unknown champion "NewChamp"/);
});

test('champ select with pick → champselect', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2450, championId: 157 }, live: OFF });
  assert.equal(s.phase, 'champselect');
  assert.equal(s.championId, 157);
  assert.equal(s.riotId, 'Yasuo');
  assert.equal(s.queueId, 2450);
});

test('champ select without pick → none but queue kept', () => {
  const s = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2400, championId: null }, live: OFF });
  assert.equal(s.phase, 'none');
  assert.equal(s.queueId, 2400);
});

test('loading: InProgress without live keeps champion from champ select', () => {
  const prev = reduce(EMPTY_GAME, { lcu: { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 157 }, live: OFF });
  const s = reduce(prev, { lcu: { connected: true, phase: 'InProgress', queueId: null, championId: null }, live: OFF });
  assert.equal(s.phase, 'loading');
  assert.equal(s.championId, 157);
  assert.equal(s.queueId, 2400, 'queue retained while not none');
});

test('sameState ignores updatedAt', () => {
  assert.equal(sameState({ ...EMPTY_GAME, updatedAt: 1 }, { ...EMPTY_GAME, updatedAt: 2 }), true);
  assert.equal(sameState({ ...EMPTY_GAME }, { ...EMPTY_GAME, level: 3 }), false);
});

test('detector tick calls onChange only when state changes', async () => {
  const changes = [];
  let liveSnap = { connected: true, championRiotId: 'Yasuo', level: 3, gameMode: 'ARAM' };
  const det = createDetector({ lcu: { snapshot: async () => OFF }, live: { snapshot: async () => liveSnap }, champIndex: index, onChange: (s) => changes.push(s), now });
  await det.tick();
  await det.tick();
  assert.equal(changes.length, 1);
  liveSnap = { ...liveSnap, level: 7 };
  await det.tick();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].stage, 2);
  assert.equal(det.getState().level, 7);
});

test('detector swallows onChange errors and keeps state', async () => {
  const det = createDetector({ lcu: { snapshot: async () => OFF }, live: { snapshot: async () => ({ connected: true, championRiotId: 'Yasuo', level: 1 }) }, champIndex: index, onChange: async () => { throw new Error('boom'); }, now });
  await det.tick();
  assert.equal(det.getState().championId, 157);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/game/detector.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/game/detector.js`**

```js
import { EMPTY_GAME, stageFromLevel } from '../data/model.js';

export function reduceGameState(prev, { lcu, live }, champIndex, now = Date.now) {
  const next = { ...prev, lcuConnected: !!lcu?.connected, liveConnected: !!live?.connected, error: null, updatedAt: now() };

  if (live?.connected) {
    next.phase = 'ingame';
    next.level = live.level ?? null;
    next.stage = stageFromLevel(live.level);
    next.gameMode = live.gameMode ?? null;
    next.riotId = live.championRiotId ?? null;
    const champ = champIndex.byRiotId(live.championRiotId);
    if (champ) next.championId = champ.id;
    else { next.championId = null; next.error = `unknown champion "${live.championRiotId}"`; }
  } else if (lcu?.connected && lcu.phase === 'ChampSelect' && lcu.championId) {
    next.phase = 'champselect';
    next.championId = lcu.championId;
    next.riotId = champIndex.byId(lcu.championId)?.riotId ?? null;
    next.level = null; next.stage = null; next.gameMode = null;
  } else if (lcu?.connected && (lcu.phase === 'InProgress' || lcu.phase === 'Reconnect')) {
    next.phase = 'loading';
    next.level = null; next.stage = null;
  } else {
    next.phase = 'none';
    next.level = null; next.stage = null;
  }

  if (lcu?.connected && lcu.queueId != null) next.queueId = lcu.queueId;
  else if (next.phase === 'none') next.queueId = null;
  return next;
}

const COMPARE = ['phase', 'queueId', 'championId', 'riotId', 'level', 'stage', 'gameMode', 'lcuConnected', 'liveConnected', 'error'];
export function sameState(a, b) {
  return COMPARE.every((k) => a?.[k] === b?.[k]);
}

export function createDetector({ lcu, live, champIndex, onChange, pollMs = 2000, now = Date.now, initial = EMPTY_GAME }) {
  let state = { ...initial };
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return state;
    busy = true;
    try {
      const [l, v] = await Promise.all([lcu.snapshot(), live.snapshot()]);
      const next = reduceGameState(state, { lcu: l, live: v }, champIndex, now);
      const changed = !sameState(state, next);
      state = next;
      if (changed) { try { await onChange(next); } catch { /* reported by the store */ } }
      return state;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, pollMs); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    getState: () => state,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/game/detector.test.js`
Expected: 9 passing.

- [ ] **Step 5: Replace `src/main.js` with the wired version**

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createCache } from './data/cache.js';
import { createAramkitClient } from './data/aramkit/client.js';
import { createAramkitAdapter } from './data/aramkit/adapter.js';
import { createRepository } from './data/repository.js';
import { createChampionIndex } from './data/champions.js';
import { createAppState } from './server/state.js';
import { createServer } from './server/http.js';
import { httpsGetJson } from './util/httpsJson.js';
import { readLockfile } from './game/lockfile.js';
import { createLcuClient } from './game/lcu.js';
import { createLiveClient } from './game/liveclient.js';
import { createDetector } from './game/detector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cfg = loadConfig({ env, argv });
  const cache = createCache({ dir: cfg.cacheDir, ttlMs: cfg.cacheTtlMs });
  const aramkit = createAramkitAdapter({ client: createAramkitClient(), cache });
  const repository = createRepository({ primary: aramkit, fallback: null, cache });

  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    champIndex = createChampionIndex({});
    log(`WARN champion index unavailable: ${e.message}`);
  }

  const state = createAppState({ repository, log });
  if (champIndex.size === 0) state.pushError('startup', 'champion index unavailable; search and detection disabled until aramkit is reachable');

  const lcu = createLcuClient({ readLockfile: () => readLockfile(cfg.lockfilePath, { fs }), getJson: httpsGetJson });
  const live = createLiveClient({ getJson: httpsGetJson });
  const detector = createDetector({
    lcu, live, champIndex, pollMs: cfg.pollMs,
    onChange: (g) => {
      log(`game: ${g.phase} champ=${g.riotId ?? '-'} lvl=${g.level ?? '-'} queue=${g.queueId ?? '-'}${g.error ? ` error=${g.error}` : ''}`);
      return state.setGame(g);
    },
  });
  detector.start();

  const server = createServer({ state, champIndex, publicDir: path.join(here, '..', 'public') });
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const url = `http://localhost:${cfg.port}`;
  log(`overlay: ${url}`);
  if (cfg.open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return { server, detector, stop: () => { detector.stop(); server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 6: Smoke test with the League client open**

Run: `node src/main.js`
Expected: with the client at the home screen, log shows nothing new (phase none). Enter an ARAM Mayhem champ select and pick: log line `game: champselect champ=Yasuo lvl=- queue=2400` and the page switches to that champion. In game: `game: ingame champ=... lvl=3 queue=2400`, then further lines as level crosses 7/11/15 and the Auto tab shows `(2)`, `(3)`, `(4)`.

- [ ] **Step 7: Run full suite and commit**

Run: `npm test`
Expected: all passing.

```bash
git add src/game/detector.js test/game/detector.test.js src/main.js
git commit -m "feat: game detector and automatic champion wiring"
```

---

### Task 17: aramgg fallback adapter

The aramgg champion-detail response shape is documented only in prose (`docs/aramgg-api-docs.md`). The normalizer is written defensively against a hand-written sample. When a real API key exists, capture one real response into `test/fixtures/aramgg/champion-157.real.json`, add a test against it, and fix field names. Until then the adapter is disabled unless `ARAMGG_API_KEY` is set.

**Files:**
- Create: `src/data/aramgg/client.js`, `src/data/aramgg/normalize.js`, `src/data/aramgg/adapter.js`, `test/fixtures/aramgg/champion-157.sample.json`, `test/data/aramgg/client.test.js`, `test/data/aramgg/normalize.test.js`, `test/data/aramgg/adapter.test.js`
- Modify: `src/main.js` (three lines, shown below)

**Interfaces:**
- Consumes: `HttpError`, `NormalizeError`, cache, ChampionIndex, DataSource interface (Task 6).
- Produces: `ARAMGG_BASE`, `createAramggClient({ fetch?, apiKey, now?, cooldownMs?, base? }) → { config(), champion(id), augments(), items(), spells(), isCoolingDown() }`; `normalizeAramgg(envelope, resources, meta) → ChampData` with `resources = { augmentsById, itemsById }` and `meta = { version, dataDate, fetchedAt, championId, riotId, name }`; `createAramggAdapter({ client, cache, apiKey, champIndex?, now?, versionTtlMs? }) → DataSource` with `enabled = !!apiKey`, `supportsBracket(b) → b === 'all'`, `supportsStages() → false`.

- [ ] **Step 1: Write the sample fixture** `test/fixtures/aramgg/champion-157.sample.json`

```json
{
  "_note": "HAND-WRITTEN from docs/aramgg-api-docs.md prose. Field names unverified. Replace with a real capture once an API key exists.",
  "meta": { "service": "aramgg-data-api", "schemaVersion": 1, "apiVersion": "v1", "locale": "en", "gamePatch": "16.18", "apiRelease": 3, "dataVersion": "16.18.3", "generatedAt": "2026-09-21T09:31:09.379Z", "publishedAt": null, "resource": "champions/157" },
  "data": {
    "id": 157, "name": "Yasuo", "tier": "S", "iconUrl": "https://cdn.dtodo.cn/hextech/champion/157.png",
    "stats": { "rank": 1, "winRate": 0.571, "pickRate": 0.1, "games": 12345 },
    "augments": [
      { "id": 1058, "name": "Mystic Punch", "rarity": "Prismatic", "iconUrl": "https://cdn.dtodo.cn/hextech/augment/1058.png", "stats": { "rank": 1, "total": 120, "winRate": 0.64, "wins": 640, "games": 1000, "pickRate": 0.14 } },
      { "id": 2009, "name": "Zealot", "rarity": "Gold", "iconUrl": null, "stats": { "rank": 2, "total": 120, "winRate": null, "wins": null, "games": null, "pickRate": 0.01 } },
      { "id": 1077, "name": "Some Silver", "rarity": "silver", "iconUrl": null, "stats": { "rank": 3, "total": 120, "winRate": 0.5, "wins": 50, "games": 100, "pickRate": 0.02 } }
    ],
    "builds": [
      {
        "label": "Crit", "games": 5000, "wins": 3000, "pickRate": 0.6, "winRate": 0.6,
        "coreItems": [ { "id": 3032, "name": "Yun Tal Wildarrows", "iconUrl": null }, { "id": 123430, "name": "Rite of Ruin", "iconUrl": null }, { "id": 6333, "name": "Death's Dance", "iconUrl": null } ],
        "startingItems": [ { "id": 1038, "name": "B. F. Sword", "iconUrl": null } ],
        "situationalItems": [ { "id": 3031, "name": "Infinity Edge", "iconUrl": null, "pickRate": 0.3, "winRate": 0.62, "games": 900 } ],
        "summonerSpells": [ { "summonerSpellIds": [4, 32], "spells": [ { "id": 4, "name": "Flash", "iconUrl": "" }, { "id": 32, "name": "Mark", "iconUrl": "" } ], "games": 4000, "wins": 2400, "pickRate": 0.9, "winRate": 0.6 } ],
        "skillOrders": [ { "skillOrder": [3, 1, 2, 1, 1, 4], "skillKeys": ["E", "Q", "W"], "games": 1000, "wins": 600, "pickRate": 0.2, "winRate": 0.6 } ]
      },
      { "label": "Bruiser", "games": 800, "wins": 440, "pickRate": 0.1, "winRate": 0.55, "coreItems": [ { "id": 123430, "name": "Rite of Ruin", "iconUrl": null } ], "startingItems": [], "situationalItems": [], "summonerSpells": [], "skillOrders": [] }
    ]
  }
}
```

- [ ] **Step 2: Write the failing client test** `test/data/aramgg/client.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramggClient, ARAMGG_BASE } from '../../../src/data/aramgg/client.js';
import { HttpError } from '../../../src/data/model.js';

function fakeFetch(status, body = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push([url, init]); return { status, json: async () => body }; } };
}

test('config is public (no key needed)', async () => {
  const { fetch, calls } = fakeFetch(200, { dataVersion: '16.18.3' });
  const c = createAramggClient({ fetch, apiKey: null });
  assert.deepEqual(await c.config(), { dataVersion: '16.18.3' });
  assert.equal(calls[0][0], `${ARAMGG_BASE}/config.json`);
  assert.equal(calls[0][1].headers['x-api-key'], undefined);
});

test('champion needs a key and sends it', async () => {
  await assert.rejects(createAramggClient({ fetch: fakeFetch(200).fetch, apiKey: null }).champion(157), /no API key/);
  const { fetch, calls } = fakeFetch(200, { data: {} });
  await createAramggClient({ fetch, apiKey: 'hx_live_k' }).champion(157);
  assert.equal(calls[0][0], `${ARAMGG_BASE}/champions/157.json`);
  assert.equal(calls[0][1].headers['x-api-key'], 'hx_live_k');
});

test('non-200 throws HttpError; 429 starts a cooldown', async () => {
  let t = 0;
  const { fetch } = fakeFetch(429);
  const c = createAramggClient({ fetch, apiKey: 'k', now: () => t, cooldownMs: 1000 });
  await assert.rejects(c.augments(), (e) => e instanceof HttpError && e.status === 429);
  assert.equal(c.isCoolingDown(), true);
  await assert.rejects(c.items(), /cooling down/);
  t = 1000;
  assert.equal(c.isCoolingDown(), false);
  const ok = createAramggClient({ fetch: fakeFetch(404).fetch, apiKey: 'k' });
  await assert.rejects(ok.spells(), (e) => e instanceof HttpError && e.status === 404);
});
```

- [ ] **Step 3: Write `src/data/aramgg/client.js`**

```js
import { HttpError } from '../model.js';

export const ARAMGG_BASE = 'https://data.dtodo.cn/api/v1/en';

export function createAramggClient({ fetch = globalThis.fetch, apiKey = null, now = Date.now, cooldownMs = 60 * 60 * 1000, base = ARAMGG_BASE } = {}) {
  let cooldownUntil = 0;

  async function fetchJson(p, { auth = true } = {}) {
    if (auth && !apiKey) throw new Error('aramgg: no API key');
    if (auth && now() < cooldownUntil) throw new Error(`aramgg: cooling down after 429 until ${new Date(cooldownUntil).toISOString()}`);
    const headers = { accept: 'application/json' };
    if (auth) headers['x-api-key'] = apiKey;
    const res = await fetch(`${base}${p}`, { headers });
    if (res.status === 429) { cooldownUntil = now() + cooldownMs; throw new HttpError(429, p); }
    if (res.status !== 200) throw new HttpError(res.status, p);
    return res.json();
  }

  return {
    config: () => fetchJson('/config.json', { auth: false }),
    champion: (id) => fetchJson(`/champions/${id}.json`),
    augments: () => fetchJson('/augments.json'),
    items: () => fetchJson('/items.json'),
    spells: () => fetchJson('/summoner-spells.json'),
    isCoolingDown: () => now() < cooldownUntil,
  };
}
```

- [ ] **Step 4: Run client test**

Run: `node --test test/data/aramgg/client.test.js`
Expected: 3 passing.

- [ ] **Step 5: Write the failing normalizer test** `test/data/aramgg/normalize.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAramgg } from '../../../src/data/aramgg/normalize.js';
import { NormalizeError } from '../../../src/data/model.js';
import { fixture } from '../../helpers/fixtures.js';

const sample = fixture('aramgg', 'champion-157.sample.json');
const resources = { augmentsById: { 1058: { id: 1058, name: 'Mystic Punch', rarity: 'prismatic', stats: { winRate: 0.51 } } }, itemsById: {} };
const meta = { version: '16.18.3', dataDate: '2026-09-21', fetchedAt: 9, championId: 157, riotId: 'Yasuo', name: 'Yasuo' };
const d = normalizeAramgg(sample, resources, meta);

test('meta and champion', () => {
  assert.equal(d.source, 'aramgg');
  assert.equal(d.sourceVersion, '16.18.3');
  assert.equal(d.bracket, 'all');
  assert.deepEqual(d.champion, { id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: 1, winRate: 0.571, pickRate: 0.1, games: 12345, icon: 'https://cdn.dtodo.cn/hextech/champion/157.png' });
});

test('augments: sorted by rank, null stats tolerated, rarity lower-cased, global WR from resources', () => {
  assert.deepEqual(d.augments.all.map((a) => a.id), [1058, 2009, 1077]);
  const mp = d.augments.all[0];
  assert.equal(mp.rarity, 'prismatic');
  assert.equal(mp.tier, null);
  assert.equal(mp.winRate, 0.64);
  assert.equal(mp.games, 1000);
  assert.equal(mp.globalWinRate, 0.51);
  const z = d.augments.all[1];
  assert.equal(z.winRate, null);
  assert.equal(z.games, 0);
  assert.equal(z.rarity, 'gold');
  assert.equal(z.globalWinRate, null);
  assert.deepEqual(d.augments.stages, {});
});

test('builds map to archetypes; first build feeds spells and skills', () => {
  assert.deepEqual(d.build.archetypes.map((a) => a.key), ['crit', 'bruiser']);
  const crit = d.build.archetypes[0];
  assert.equal(crit.name, 'Crit');
  assert.deepEqual(crit.core.map((i) => i.id), [3032, 123430, 6333]);
  assert.deepEqual(crit.starters[0].items.map((i) => i.id), [1038]);
  assert.deepEqual(crit.boots, []);
  assert.deepEqual(crit.later.map((l) => l.item.id), [3031]);
  assert.equal(crit.routeWinRate, 0.6);
  assert.deepEqual(d.summoners[0], { spellIds: [4, 32], names: ['Flash', 'Mark'], winRate: 0.6, pickRate: 0.9, games: 4000 });
  assert.deepEqual(d.skills[0], { order: 'E>Q>W', winRate: 0.6, pickRate: 0.2, games: 1000 });
});

test('missing id or augments throws NormalizeError', () => {
  assert.throws(() => normalizeAramgg({ data: {} }, resources, { ...meta, championId: undefined }), NormalizeError);
  assert.throws(() => normalizeAramgg({ data: { id: 1, augments: [] } }, resources, meta), /augments empty/);
});
```

- [ ] **Step 6: Write `src/data/aramgg/normalize.js`**

```js
import { NormalizeError } from '../model.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rarityOf = (v) => {
  const s = String(v ?? '').toLowerCase();
  return ['prismatic', 'gold', 'silver'].find((r) => s.includes(r)) ?? 'unknown';
};
const keyOf = (label, i) => (label ? String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_') : `build_${i + 1}`);

function itemOf(ref, itemsById) {
  const id = Number(ref?.id ?? ref?.itemId ?? ref);
  const r = itemsById[id];
  return { id, name: ref?.name ?? r?.name ?? `#${id}`, icon: ref?.iconUrl ?? r?.iconUrl ?? null };
}

export function normalizeAramgg(envelope, resources, meta) {
  const d = envelope?.data ?? envelope ?? {};
  const champ = d.champion ?? d;
  const id = Number(champ?.id ?? champ?.championId ?? meta?.championId);
  if (!Number.isInteger(id)) throw new NormalizeError('aramgg: champion id missing');
  const augmentsById = resources?.augmentsById ?? {};
  const itemsById = resources?.itemsById ?? {};

  const augList = Array.isArray(d.augments) ? d.augments : [];
  if (augList.length === 0) throw new NormalizeError('aramgg: augments empty', { championId: id });
  const all = augList
    .map((a) => {
      const aid = Number(a.id ?? a.augmentId);
      const known = augmentsById[aid] ?? {};
      const st = a.stats ?? a;
      return {
        id: aid,
        name: a.name ?? known.name ?? `#${aid}`,
        rarity: rarityOf(a.rarity ?? known.rarity),
        tier: null,
        rank: num(st.rank),
        winRate: num(st.winRate),
        pickRate: num(st.pickRate),
        games: st.games ?? 0,
        globalWinRate: num(known.stats?.winRate),
        icon: a.iconUrl ?? known.iconUrl ?? null,
      };
    })
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

  const builds = Array.isArray(d.builds) ? d.builds : d.build ? [d.build] : [];
  const archetypes = builds.map((b, i) => ({
    key: keyOf(b.label, i),
    name: b.label ?? `Build ${i + 1}`,
    winRate: num(b.winRate), pickRate: num(b.pickRate), games: b.games ?? 0,
    core: (b.coreItems ?? []).map((x) => itemOf(x, itemsById)),
    starters: b.startingItems?.length ? [{ items: b.startingItems.map((x) => itemOf(x, itemsById)), winRate: num(b.winRate), pickRate: num(b.pickRate), games: b.games ?? 0 }] : [],
    boots: [],
    later: (b.situationalItems ?? []).slice(0, 6).map((x) => ({ item: itemOf(x, itemsById), winRate: num(x.winRate), pickRate: num(x.pickRate), games: x.games ?? 0 })),
    routeWinRate: num(b.winRate), routePickRate: num(b.pickRate), routeGames: b.games ?? 0,
  }));

  const b0 = builds[0] ?? {};
  const stats = champ.stats ?? {};
  return {
    source: 'aramgg',
    sourceVersion: meta.version,
    dataDate: meta.dataDate ?? null,
    fetchedAt: meta.fetchedAt,
    bracket: 'all',
    champion: {
      id,
      riotId: meta.riotId ?? null,
      name: champ.name ?? meta.name ?? `#${id}`,
      tier: champ.tier ?? null,
      rank: num(stats.rank ?? champ.rank),
      winRate: num(stats.winRate ?? champ.winRate),
      pickRate: num(stats.pickRate ?? champ.pickRate),
      games: stats.games ?? champ.games ?? 0,
      icon: champ.iconUrl ?? null,
    },
    augments: { all, stages: {} },
    build: { archetypes },
    summoners: (b0.summonerSpells ?? []).map((s) => ({
      spellIds: s.summonerSpellIds ?? (s.spells ?? []).map((x) => x.id),
      names: (s.spells ?? []).map((x) => x.name),
      winRate: num(s.winRate), pickRate: num(s.pickRate), games: s.games ?? 0,
    })),
    skills: (b0.skillOrders ?? []).map((s) => ({ order: (s.skillKeys ?? []).join('>'), winRate: num(s.winRate), pickRate: num(s.pickRate), games: s.games ?? 0 })),
  };
}
```

- [ ] **Step 7: Run normalizer test**

Run: `node --test test/data/aramgg/normalize.test.js`
Expected: 4 passing.

- [ ] **Step 8: Write the failing adapter test** `test/data/aramgg/adapter.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAramggAdapter } from '../../../src/data/aramgg/adapter.js';
import { createCache } from '../../../src/data/cache.js';
import { createChampionIndex } from '../../../src/data/champions.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture } from '../../helpers/fixtures.js';

const sample = fixture('aramgg', 'champion-157.sample.json');
const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));

function fakeClient() {
  const calls = { config: 0, champion: 0, augments: 0, items: 0 };
  return {
    calls,
    async config() { calls.config++; return { dataVersion: '16.18.3', generatedAt: '2026-09-21T09:31:09.379Z' }; },
    async champion() { calls.champion++; return sample; },
    async augments() { calls.augments++; return { data: { augments: [{ id: 1058, name: 'Mystic Punch', rarity: 'Prismatic', stats: { winRate: 0.51 } }] } }; },
    async items() { calls.items++; return { data: { items: [{ id: 3032, name: 'Yun Tal Wildarrows', iconUrl: 'https://cdn/x.png' }] } }; },
    async spells() { return { data: [] }; },
  };
}

test('disabled without key', () => {
  const a = createAramggAdapter({ client: fakeClient(), cache: createCache({ dir: 'c', ttlMs: 1, fs: createMemFs() }), apiKey: null });
  assert.equal(a.enabled, false);
  assert.equal(a.name, 'aramgg');
  assert.equal(a.supportsBracket('high'), false);
  assert.equal(a.supportsBracket('all'), true);
  assert.equal(a.supportsStages(), false);
});

test('version from config; champion normalized with resources and champ index names', async () => {
  const fs = createMemFs();
  const client = fakeClient();
  const a = createAramggAdapter({ client, cache: createCache({ dir: 'c', ttlMs: 1000, fs, now: () => 5 }), apiKey: 'k', champIndex: index, now: () => 5 });
  assert.equal(a.enabled, true);
  assert.equal(await a.version(), '16.18.3');
  const d = await a.champion(157, 'all');
  assert.equal(d.champion.riotId, 'Yasuo');
  assert.equal(d.dataDate, '2026-09-21');
  assert.equal(d.augments.all[0].globalWinRate, 0.51);
  assert.equal(d.build.archetypes[0].core[0].icon, 'https://cdn/x.png', 'resource icon fills in when the item ref has none');
  assert.equal(client.calls.config, 1);
  assert.equal(client.calls.augments, 1);
  await a.champion(157, 'all');
  assert.equal(client.calls.augments, 1, 'resources cached');
  const b = createAramggAdapter({ client: fakeClient(), cache: createCache({ dir: 'c', ttlMs: 1000, fs, now: () => 5 }), apiKey: 'k', champIndex: index });
  await b.champion(157, 'all');
  assert.equal(client.calls.augments, 1, 'second adapter reads disk cache');
});
```

- [ ] **Step 9: Write `src/data/aramgg/adapter.js`**

```js
import { normalizeAramgg } from './normalize.js';

const RESOURCES = [
  ['augmentsById', 'augments', (c) => c.augments()],
  ['itemsById', 'items', (c) => c.items()],
];

function toList(payload, name) {
  const d = payload?.data ?? payload;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.[name])) return d[name];
  return d && typeof d === 'object' ? Object.values(d) : [];
}

export function createAramggAdapter({ client, cache, apiKey, champIndex = null, now = Date.now, versionTtlMs = 6 * 3600 * 1000 }) {
  const enabled = !!apiKey;
  let cfg = null;
  let cfgAt = -Infinity;

  async function config() {
    if (cfg && now() - cfgAt < versionTtlMs) return cfg;
    cfg = await client.config();
    cfgAt = now();
    return cfg;
  }

  async function resources(version) {
    const out = {};
    for (const [field, name, call] of RESOURCES) {
      const key = ['aramgg', 'resources', name];
      const hit = await cache.get(key);
      let list;
      if (hit && hit.value && hit.value.version === version) list = hit.value.data;
      else { list = toList(await call(client), name); await cache.set(key, { version, data: list }); }
      out[field] = Object.fromEntries(list.map((x) => [Number(x.id ?? x.augmentId ?? x.itemId), x]));
    }
    return out;
  }

  return {
    name: 'aramgg',
    enabled,
    supportsBracket: (b) => b === 'all',
    supportsStages: () => false,
    version: async () => (await config()).dataVersion,
    async champion(id) {
      const c = await config();
      const [raw, res] = await Promise.all([client.champion(id), resources(c.dataVersion)]);
      const known = champIndex ? champIndex.byId(id) : null;
      return normalizeAramgg(raw, res, {
        version: c.dataVersion,
        dataDate: typeof c.generatedAt === 'string' ? c.generatedAt.slice(0, 10) : null,
        fetchedAt: now(),
        championId: id,
        riotId: known?.riotId ?? null,
        name: known?.name ?? null,
      });
    },
  };
}
```

- [ ] **Step 10: Run adapter test**

Run: `node --test test/data/aramgg/adapter.test.js`
Expected: 2 passing.

- [ ] **Step 11: Wire into `src/main.js`**

Add imports after the aramkit adapter import:

```js
import { createAramggClient } from './data/aramgg/client.js';
import { createAramggAdapter } from './data/aramgg/adapter.js';
```

Replace the `const repository = createRepository({ primary: aramkit, fallback: null, cache });` line **and** move it below the champion-index block, so the block reads:

```js
  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    champIndex = createChampionIndex({});
    log(`WARN champion index unavailable: ${e.message}`);
  }

  const aramgg = createAramggAdapter({ client: createAramggClient({ apiKey: cfg.aramggApiKey }), cache, apiKey: cfg.aramggApiKey, champIndex });
  const [primary, fallback] = cfg.primarySource === 'aramgg' ? [aramgg, aramkit] : [aramkit, aramgg];
  const repository = createRepository({ primary, fallback, cache });
  log(`data: primary=${primary.name} fallback=${fallback.enabled ? fallback.name : 'disabled'}`);
```

`createAppState({ repository, log })` stays where it is (after this block).

- [ ] **Step 12: Run full suite, smoke, commit**

Run: `npm test` → all passing. Run: `node src/main.js` → log contains `data: primary=aramkit fallback=disabled`. With `ARAMGG_API_KEY=hx_live_... node src/main.js` → `fallback=aramgg`.

```bash
git add src/data/aramgg test/data/aramgg test/fixtures/aramgg src/main.js
git commit -m "feat: aramgg fallback adapter behind api key"
```

---

### Task 18: Launcher, README, final verification

**Files:**
- Create: `start.cmd`, `README.md`

- [ ] **Step 1: Write `start.cmd`**

```bat
@echo off
cd /d "%~dp0"
node src\main.js --open %*
```

- [ ] **Step 2: Write `README.md`**

```markdown
# ARAM Mayhem Overlay

Local page for a second monitor: detects your League of Legends champion (champ select via LCU,
in game via Live Client Data) and shows ARAM Mayhem augment win rates per rarity, auto-switched
to the current augment stage (levels 3 / 7 / 11 / 15), plus a high-win-rate build.

Data: [aramkit.com](https://aramkit.com) public JSON (primary), [aramgg.com](https://aramgg.com)
API (optional fallback, needs a free key). Not endorsed by Riot Games.

## Run

    npm test          # unit tests, no network
    start.cmd         # starts server on http://localhost:3777 and opens the page
    node src/main.js  # same without opening a browser

Keep the page on your second monitor. League may run in any display mode; this is a browser tab,
not an in-game overlay. Nothing is written to the League client.

## Options

| Env / flag | Default | Meaning |
|---|---|---|
| `PORT` / `--port` | 3777 | HTTP port (127.0.0.1 only) |
| `POLL_MS` / `--poll-ms` | 2000 | Game polling interval |
| `CACHE_DIR` / `--cache-dir` | `data/cache` | Disk cache |
| `CACHE_TTL_H` / `--cache-ttl-h` | 24 | Hours before champion data is re-fetched |
| `LOL_LOCKFILE` / `--lockfile` | `C:\Riot Games\League of Legends\lockfile` | LCU lockfile |
| `ARAMGG_API_KEY` / `--aramgg-key` | unset | Enables aramgg fallback (key from https://data.dtodo.cn/developer.html) |
| `PRIMARY_SOURCE` / `--primary` | `aramkit` | `aramkit` or `aramgg` |
| `--open` | off | Open the browser after start |
| page `?noicons=1` | | Hide item/augment icons |

## Page

- Stage tabs: Auto (from your level), All, 1–4. Bracket: All or High MMR.
- Rows: tier badge, name, win rate, lift vs the augment's global win rate, games. Rows under
  200 games are dimmed and sorted last.
- Build: best archetype by win rate with ≥5 % pick; starter, boots, core order, later items,
  spells, skill order. Other archetypes under "Other builds".
- Search box previews any champion; "Live" returns to the detected one. ↻ re-fetches.

## Manual smoke checklist

1. `node src/main.js` with League closed: page says "Waiting for League…", search works.
2. Open the client: header still idle (phase none).
3. Enter ARAM Mayhem champ select, pick: page switches to that champion, queue "ARAM Mayhem".
4. Loading screen: "Loading screen", same champion.
5. In game: level shown, Auto tab shows stage 1; passes (2) at level 7, (3) at 11, (4) at 15.
6. Toggle High MMR: header meta shows `bracket high` after a short load.
7. After the game: "Not in game", last champion still shown.

## Layout

    src/config.js       env/argv
    src/data/           cache, repository, champion index, aramkit + aramgg adapters
    src/rank/           augment ranking, build selection (pure)
    src/game/           lockfile, lcu, liveclient, detector
    src/server/         state store, http routes
    public/             page
    test/               node:test suites + fixtures (aramkit fixtures are real captures)
```

- [ ] **Step 3: Verify everything**

Run: `npm test` → all suites pass.
Run: `start.cmd` → browser opens on the page; walk the smoke checklist as far as League availability allows and note any failures as follow-up issues.

- [ ] **Step 4: Commit**

```bash
git add start.cmd README.md
git commit -m "docs: launcher and readme"
```

---

## Plan self-review notes

- Spec coverage: §5 models (T3, T5), §6 detection (T13–T16), §7 sources incl. fallback chain and cache (T2, T4–T6, T9, T17), §8 ranking (T7–T8), §9 server routes (T11, plus `/api/refresh` for the ↻ button), §10 UI (T11), §11 config (T1), §12 error handling (T9 stale/DataUnavailable, T10 error buffer, T16 unknown champion, T17 429 cooldown), §13 tests (every task), §14 milestones (task order).
- Not implemented on purpose: spec §12 "raw JSON written to `data/debug/`" on normalize failure. Errors surface in the UI banner instead; add if a real parse failure ever needs forensics.
- Naming: Live Client snapshot uses `championRiotId`; `GameState.riotId` is the same value (spec naming). Both are the champion's internal name, never the player's Riot ID.
