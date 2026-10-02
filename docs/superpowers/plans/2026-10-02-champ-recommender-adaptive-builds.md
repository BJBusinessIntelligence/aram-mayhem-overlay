# Champion Recommender + Adaptive Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank the held + bench champions during ARAM Mayhem champ select by team fit with reasons, and adapt the recommended build to the allied lineup (champ select) and to both lineups (in game).

**Architecture:** The detector gains a `lineup` (held, bench, allies, enemies) with a revision counter. A recommender service fetches aramkit rankings/averages, CommunityDragon champion playstyle data and per-champion ChampData, turns them into 0..1 trait profiles, and runs pure scoring (`src/rank/lineup.js`) and build adaptation (`src/rank/builds.js`). App state stores the result guarded by the revision; the page shows a champ-select panel and build context chips.

**Tech Stack:** Node ≥ 22 ESM, zero dependencies, `node:test` + `node:assert/strict`, plain HTML/CSS/JS front end. Fixtures under `test/fixtures/`.

**Spec:** `docs/superpowers/specs/2026-10-02-champ-recommender-adaptive-builds-design.md`

## Global Constraints

- Zero runtime dependencies; Node ≥ 22; ESM (`"type": "module"`); tests run with `npm test` (`node --test "test/**/*.test.js"`).
- Advisory only: never write to the LCU, never click or send anything to the game.
- Strictly personal use; output is comparison + reasons, never commands.
- aramkit: ≤ 15 small champion fetches per champ select, everything cached on disk per data version (existing `createCache`).
- Weights and caps live in `src/rank/weights.js`; no other magic numbers in the engine.
- Existing augment list / build display must keep working when the recommender has no data (`recommend: null`).
- All new text in English; UI follows the existing dark theme and `.chip` / `.muted` / `.tier` classes.
- Commit after every task with the message given; end every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Fixture champion ids used throughout: 157 Yasuo, 62 MonkeyKing, 1 Annie, 25 Morgana, 103 Ahri, 99 Lux, 54 Malphite, 222 Jinx (all present in `test/fixtures/aramkit/resources-champions.json`).

---

### Task 1: Lineup detection (LCU bench + allies, Live Client teams, detector lineup + rev)

**Files:**
- Modify: `src/game/lcu.js`
- Modify: `src/game/liveclient.js`
- Modify: `src/game/detector.js`
- Modify: `src/data/model.js` (EMPTY_GAME)
- Create: `scripts/lcu-dump.js`
- Create: `test/fixtures/lcu/champ-select-session.json`
- Modify: `test/fixtures/liveclient/allgamedata.json` (add three CHAOS players)
- Test: `test/game/lcu.test.js`, `test/game/liveclient.test.js`, `test/game/detector.test.js`

**Interfaces:**
- Produces `extractChampSelect(cs) → { held: number|null, bench: number[], allies: number[] }` (lcu.js). LCU `snapshot()` now returns `{ connected, phase, queueId, championId, champSelect }` where `champSelect` is that object in phase `ChampSelect`, else `null`.
- Produces `extractActive(data)` (liveclient.js) with two extra fields: `allies: string[]`, `enemies: string[]` (riotIds, self excluded from allies).
- Produces `game.lineup = { held, bench, allies, enemies }` (champion ids) and `game.lineupRev` (integer) on the detector state; `EMPTY_LINEUP` exported from `src/data/model.js`.

- [ ] **Step 1: Add the LCU fixture**

Create `test/fixtures/lcu/champ-select-session.json`:

```json
{
  "localPlayerCellId": 2,
  "benchEnabled": true,
  "benchChampions": [{ "championId": 99 }, { "championId": 54 }, { "championId": 0 }],
  "myTeam": [
    { "cellId": 0, "championId": 1 },
    { "cellId": 1, "championId": 62 },
    { "cellId": 2, "championId": 157 },
    { "cellId": 3, "championId": 25 },
    { "cellId": 4, "championId": 103 }
  ],
  "theirTeam": []
}
```

- [ ] **Step 2: Write the failing LCU tests**

Append to `test/game/lcu.test.js` (it already imports `createLcuClient`, `pickedChampion`, has `lock`, `fakeGetJson`). Add `extractChampSelect` to the import line and `fixture` from `../helpers/fixtures.js`:

```js
import { createLcuClient, pickedChampion, extractChampSelect } from '../../src/game/lcu.js';
import { fixture } from '../helpers/fixtures.js';

test('extractChampSelect: held, bench without empty slots, allies without me', () => {
  const cs = fixture('lcu', 'champ-select-session.json');
  assert.deepEqual(extractChampSelect(cs), { held: 157, bench: [99, 54], allies: [1, 62, 25, 103] });
  assert.deepEqual(extractChampSelect({}), { held: null, bench: [], allies: [] });
  assert.deepEqual(extractChampSelect({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 0 }, { cellId: 1, championId: 0 }] }), { held: null, bench: [], allies: [] });
});

test('snapshot in champ select carries champSelect; other phases carry null', async () => {
  const cs = fixture('lcu', 'champ-select-session.json');
  const { getJson } = fakeGetJson({
    '/lol-gameflow/v1/gameflow-phase': 'ChampSelect',
    '/lol-gameflow/v1/session': { gameData: { queue: { id: 2400 } } },
    '/lol-champ-select/v1/session': cs,
  });
  const lcu = createLcuClient({ readLockfile: async () => lock, getJson });
  const s = await lcu.snapshot();
  assert.equal(s.championId, 157);
  assert.deepEqual(s.champSelect, { held: 157, bench: [99, 54], allies: [1, 62, 25, 103] });
  const { getJson: g2 } = fakeGetJson({ '/lol-gameflow/v1/gameflow-phase': 'InProgress' });
  assert.equal((await createLcuClient({ readLockfile: async () => lock, getJson: g2 }).snapshot()).champSelect, null);
});
```

Also update the existing test `'champ select: phase, queue, picked champion; auth header and insecure tls'` expectation to include `champSelect: { held: 62, bench: [], allies: [] }`, and the two `InProgress` / `None` expectations to include `champSelect: null`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/game/lcu.test.js`
Expected: FAIL — `extractChampSelect` is not exported; deepEqual mismatches on `champSelect`.

- [ ] **Step 4: Implement in `src/game/lcu.js`**

Add after `pickedChampion`:

```js
const validId = (id) => Number.isInteger(id) && id > 0;

// ARAM champ select: every ally already holds a champion; the bench lists swap options.
export function extractChampSelect(cs) {
  const team = Array.isArray(cs?.myTeam) ? cs.myTeam : [];
  const me = team.find((p) => p && p.cellId === cs.localPlayerCellId);
  const held = validId(me?.championId) ? me.championId : null;
  const allies = team.filter((p) => p && p !== me && validId(p.championId)).map((p) => p.championId);
  const bench = (Array.isArray(cs?.benchChampions) ? cs.benchChampions : []).map((b) => b?.championId).filter(validId);
  return { held, bench, allies };
}
```

In `snapshot()` replace the champ-select block:

```js
        let champSelect = null;
        if (phase === 'ChampSelect') {
          try {
            const cs = await request(lock, '/lol-champ-select/v1/session');
            championId = pickedChampion(cs);
            champSelect = extractChampSelect(cs);
          } catch { /* not picked yet */ }
        }
        return { connected: true, phase, queueId, championId, champSelect };
```

- [ ] **Step 5: Run LCU tests**

Run: `node --test test/game/lcu.test.js`
Expected: PASS

- [ ] **Step 6: Extend the Live Client fixture and tests**

In `test/fixtures/liveclient/allgamedata.json`, append three players to `allPlayers` (copy the shape of the existing entries; only these fields matter):

```json
{ "team": "CHAOS", "rawChampionName": "game_character_displayname_Lux", "championName": "Lux", "riotId": "E1#NA1", "summonerName": "E1" },
{ "team": "CHAOS", "rawChampionName": "game_character_displayname_Malphite", "championName": "Malphite", "riotId": "E2#NA1", "summonerName": "E2" },
{ "team": "CHAOS", "rawChampionName": "game_character_displayname_Jinx", "championName": "Jinx", "riotId": "E3#NA1", "summonerName": "E3" }
```

In `test/game/liveclient.test.js` change the two `extractActive` expectations:

```js
test('extractActive matches by riotId and splits teams', () => {
  assert.deepEqual(extractActive(data), {
    championRiotId: 'MonkeyKing', championName: 'Wukong', level: 7, gameMode: 'ARAM',
    allies: ['Annie'], enemies: ['Lux', 'Malphite', 'Jinx'],
  });
});
```

and in the fallback test expect `allies: ['Annie'], enemies: ['Lux', 'Malphite', 'Jinx']` as well (the deleted riotId only affects matching `me`).

- [ ] **Step 7: Run to verify it fails, then implement**

Run: `node --test test/game/liveclient.test.js` → FAIL (missing `allies`/`enemies`).

In `src/game/liveclient.js`, inside `extractActive` before the `return`:

```js
  const others = players.filter((p) => p && p !== me);
  const nameOf = (p) => stripChampionPrefix(p.rawChampionName) ?? p.championName ?? null;
  const allies = others.filter((p) => p.team === me.team).map(nameOf).filter(Boolean);
  const enemies = others.filter((p) => p.team && p.team !== me.team).map(nameOf).filter(Boolean);
```

and add `allies, enemies` to the returned object.

Run: `node --test test/game/liveclient.test.js` → PASS

- [ ] **Step 8: Write the failing detector tests**

Append to `test/game/detector.test.js` (imports `reduceGameState`, `sameState`, `EMPTY_GAME`, `index`, `OFF`, `reduce` exist). Add `EMPTY_LINEUP` to the model import:

```js
import { EMPTY_GAME, EMPTY_LINEUP } from '../../src/data/model.js';

test('champ select lineup: held, bench, allies from LCU; rev bumps only on change', () => {
  const lcu = { connected: true, phase: 'ChampSelect', queueId: 2400, championId: 157, champSelect: { held: 157, bench: [99, 54], allies: [1, 62, 25, 103] } };
  const a = reduce(EMPTY_GAME, { lcu, live: OFF });
  assert.deepEqual(a.lineup, { held: 157, bench: [99, 54], allies: [1, 62, 25, 103], enemies: [] });
  assert.equal(a.lineupRev, 1);
  const b = reduce(a, { lcu, live: OFF });
  assert.equal(b.lineupRev, 1);
  const c = reduce(b, { lcu: { ...lcu, championId: 99, champSelect: { held: 99, bench: [157, 54], allies: [1, 62, 25, 103] } }, live: OFF });
  assert.equal(c.lineupRev, 2);
  assert.equal(c.lineup.held, 99);
});

test('in game lineup: allies and enemies mapped through the champion index, unknown names dropped', () => {
  const live = { connected: true, championRiotId: 'MonkeyKing', level: 3, gameMode: 'ARAM', allies: ['Annie', 'Nope'], enemies: ['Lux', 'Malphite', 'Jinx'] };
  const s = reduce(EMPTY_GAME, { lcu: OFF, live });
  assert.deepEqual(s.lineup, { held: 62, bench: [], allies: [1], enemies: [99, 54, 222] });
  assert.equal(s.lineupRev, 1);
});

test('no game → EMPTY_LINEUP; sameState sees lineup changes', () => {
  const s = reduce({ ...EMPTY_GAME, lineup: { held: 1, bench: [], allies: [], enemies: [] }, lineupRev: 3 }, { lcu: OFF, live: OFF });
  assert.deepEqual(s.lineup, EMPTY_LINEUP);
  assert.equal(s.lineupRev, 4);
  assert.equal(sameState({ ...EMPTY_GAME, lineupRev: 1 }, { ...EMPTY_GAME, lineupRev: 2 }), false);
});
```

- [ ] **Step 9: Run to verify it fails**

Run: `node --test test/game/detector.test.js`
Expected: FAIL — `EMPTY_LINEUP` undefined, `lineup` undefined.

- [ ] **Step 10: Implement model + detector**

In `src/data/model.js` add before `EMPTY_GAME`:

```js
export const EMPTY_LINEUP = Object.freeze({ held: null, bench: [], allies: [], enemies: [] });
```

and two fields inside `EMPTY_GAME`:

```js
  lineup: EMPTY_LINEUP,   // champion ids: { held, bench, allies, enemies }
  lineupRev: 0,           // bumps whenever lineup content changes
```

In `src/game/detector.js` import `EMPTY_LINEUP` and add:

```js
const lineupKey = (l) => JSON.stringify([l.held, l.bench, l.allies, l.enemies]);
const idsFromRiot = (names, champIndex) => (names ?? []).map((n) => champIndex.byRiotId(n)?.id).filter((id) => Number.isInteger(id));
```

In `reduceGameState`, build `lineup` per branch and finish with the rev:

```js
  let lineup = EMPTY_LINEUP;
  if (live?.connected) {
    // ... existing ingame assignments ...
    lineup = { held: next.championId, bench: [], allies: idsFromRiot(live.allies, champIndex), enemies: idsFromRiot(live.enemies, champIndex) };
  } else if (lcu?.connected && lcu.phase === 'ChampSelect' && lcu.championId) {
    // ... existing champselect assignments ...
    const cs = lcu.champSelect ?? {};
    lineup = { held: lcu.championId, bench: cs.bench ?? [], allies: cs.allies ?? [], enemies: [] };
  } else if (lcu?.connected && (lcu.phase === 'InProgress' || lcu.phase === 'Reconnect')) {
    // loading: keep the previous lineup (allies from champ select) until the live client appears
    lineup = prev.lineup ?? EMPTY_LINEUP;
  }
  next.lineup = lineup;
  next.lineupRev = lineupKey(lineup) === lineupKey(prev.lineup ?? EMPTY_LINEUP) ? (prev.lineupRev ?? 0) : (prev.lineupRev ?? 0) + 1;
```

Add `'lineupRev'` to the `COMPARE` array.

- [ ] **Step 11: Run the whole suite**

Run: `npm test`
Expected: all pass (existing detector tests still pass because `lineup`/`lineupRev` are additive).

- [ ] **Step 12: Add `scripts/lcu-dump.js`**

```js
// Usage: node scripts/lcu-dump.js   (run during champ select)
// Saves the raw LCU champ-select + gameflow session JSON to data/debug/ for fixtures.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { readLockfile } from '../src/game/lockfile.js';
import { httpsGetJson } from '../src/util/httpsJson.js';

const cfg = loadConfig({ env: process.env, argv: process.argv.slice(2) });
const lock = await readLockfile(cfg.lockfilePath, { fs });
if (!lock) { console.error('League client not running (no lockfile)'); process.exit(2); }
const headers = { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' };
const get = (p) => httpsGetJson(`https://127.0.0.1:${lock.port}${p}`, { headers, timeoutMs: 3000, rejectUnauthorized: false });
const out = { at: new Date().toISOString() };
for (const [k, p] of [['phase', '/lol-gameflow/v1/gameflow-phase'], ['gameflow', '/lol-gameflow/v1/session'], ['champSelect', '/lol-champ-select/v1/session']]) {
  const { status, body } = await get(p);
  out[k] = { status, body };
}
await fs.mkdir(path.join('data', 'debug'), { recursive: true });
const file = path.join('data', 'debug', `lcu-champ-select-${Date.now()}.json`);
await fs.writeFile(file, JSON.stringify(out, null, 2));
console.log('wrote', file, 'phase', out.phase.body, 'champ-select status', out.champSelect.status);
```

- [ ] **Step 13: Commit**

```bash
git add src/game src/data/model.js scripts/lcu-dump.js test/fixtures/lcu test/fixtures/liveclient test/game
git commit -m "feat(game): lineup detection with bench, allies, enemies and a revision counter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: aramkit rankings, averages, combat stats and per-item stats

**Files:**
- Modify: `src/data/aramkit/client.js` (urls + two fetchers)
- Modify: `src/data/aramkit/adapter.js` (`rankings`, `averages`)
- Modify: `src/data/aramkit/normalize.js` (`champion.combat`, `items`)
- Create: `test/fixtures/aramkit/champion-performance-averages-all.json`
- Test: `test/data/aramkit/client.test.js`, `test/data/aramkit/adapter.test.js`, `test/data/aramkit/normalize.test.js`

**Interfaces:**
- Produces `adapter.rankings(bracket) → Promise<{ version, byId: { [id]: { id, rank, tier, winRate, pickRate, games } } }>`.
- Produces `adapter.averages(bracket) → Promise<{ version, combat: Combat }>`.
- Produces on ChampData: `champion.combat: Combat | null` where `Combat = { physicalDamage, magicDamage, trueDamage, damageTaken, damageSelfMitigated, healsOnTeammates, damageShieldedOnTeammates, timeCcingOthers, damageShare }` (numbers or null), and `items: [{ id, name, icon, winRate, pickRate, games }]`.

- [ ] **Step 1: Add the averages fixture**

Create `test/fixtures/aramkit/champion-performance-averages-all.json` (real values, 2026-10-02):

```json
{"averages":{"winRate":0.5,"pickRate":0.0775,"blueWinRate":0.5214,"redWinRate":0.4786,"kda":3.861,"kills":11.323,"deaths":11.344,"assists":26.11,"damageToChampions":42018.599,"physicalDamageToChampions":19020.767,"magicDamageToChampions":19526.396,"trueDamageToChampions":3470.58,"damageDealtToTurrets":1509.799,"damageTaken":46086.176,"damageSelfMitigated":46272.043,"healsOnTeammates":479.216,"damageShieldedOnTeammates":461.377,"timeCcingOthers":33.9,"goldEarned":16887.904,"cs":39.3,"killParticipation":0.664,"damageShare":0.2,"gameDuration":1050,"multikills":2.235,"damageGoldEfficiency":2.336}}
```

- [ ] **Step 2: Write failing normalize tests**

Append to `test/data/aramkit/normalize.test.js` (it already builds a normalized Yasuo from `champion-details-157-all.json`; reuse that variable — check its name at the top of the file and use it):

```js
test('champion.combat carries the stats the profile rules need', () => {
  const c = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 }).champion.combat;
  assert.deepEqual(c, {
    physicalDamage: 35093, magicDamage: 5058, trueDamage: 2087, damageTaken: 37193, damageSelfMitigated: 74028,
    healsOnTeammates: 1, damageShieldedOnTeammates: 0, timeCcingOthers: 29.3, damageShare: 0.2061,
  });
});

test('items come from items.filtered.all with names and icons', () => {
  const d = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
  assert.ok(d.items.length > 5);
  const boots = d.items.find((i) => i.id === 3006);
  assert.equal(boots.name, "Berserker's Greaves");
  assert.equal(typeof boots.winRate, 'number');
  assert.equal(typeof boots.pickRate, 'number');
  assert.ok(boots.games > 0);
});

test('missing stats/items → combat null and items empty', () => {
  const raw = { champion: { id: 1 }, augments: { all: [{ id: 1058 }] } };
  const d = normalizeAramkit(raw, aramkitResources(), { version: 'x', bracket: 'all', fetchedAt: 0 });
  assert.equal(d.champion.combat, null);
  assert.deepEqual(d.items, []);
});
```

- [ ] **Step 3: Run to verify failure, then implement normalize**

Run: `node --test test/data/aramkit/normalize.test.js` → FAIL (`combat` undefined).

In `src/data/aramkit/normalize.js` add inside `normalizeAramkit` before the `return`:

```js
  const st = champRaw.stats;
  const combat = st && typeof st === 'object' ? {
    physicalDamage: num(st.physicalDamageToChampions), magicDamage: num(st.magicDamageToChampions), trueDamage: num(st.trueDamageToChampions),
    damageTaken: num(st.damageTaken), damageSelfMitigated: num(st.damageSelfMitigated),
    healsOnTeammates: num(st.healsOnTeammates), damageShieldedOnTeammates: num(st.damageShieldedOnTeammates),
    timeCcingOthers: num(st.timeCcingOthers), damageShare: num(st.damageShare),
  } : null;
  const itemRows = (raw.items?.filtered?.all ?? [])
    .filter((i) => i && i.id != null)
    .map((i) => ({ ...item({ id: i.id }), winRate: num(i.winRate), pickRate: num(i.pickRate), games: i.sampleCount ?? 0 }));
```

Add `combat` to the returned `champion` object and `items: itemRows` at the top level of the returned ChampData. Export a `combatFromAverages(averages)` helper too (same field mapping, used by the adapter):

```js
export function combatFromAverages(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    physicalDamage: num(a.physicalDamageToChampions), magicDamage: num(a.magicDamageToChampions), trueDamage: num(a.trueDamageToChampions),
    damageTaken: num(a.damageTaken), damageSelfMitigated: num(a.damageSelfMitigated),
    healsOnTeammates: num(a.healsOnTeammates), damageShieldedOnTeammates: num(a.damageShieldedOnTeammates),
    timeCcingOthers: num(a.timeCcingOthers), damageShare: num(a.damageShare),
  };
}
```

Refactor the champion `combat` block to call `combatFromAverages(st)` (same mapping) so the two cannot drift.

Run: `node --test test/data/aramkit/normalize.test.js` → PASS

- [ ] **Step 4: Client urls + fetchers (test first)**

Append to `test/data/aramkit/client.test.js` (it imports `aramkitUrls` and `createAramkitClient`; check the existing `entry` fixture variable name and reuse it):

```js
test('rankings and averages urls', () => {
  const u = aramkitUrls({ dataPath: 'data/v', resourcePath: 'resources/r' });
  assert.equal(u.rankings('all'), 'https://data.aramkit.com/data/v/stats/all/champion-rankings.json');
  assert.equal(u.averages('high'), 'https://data.aramkit.com/data/v/stats/high/champion-performance-averages.json');
});
```

Run → FAIL. Implement in `aramkitUrls`:

```js
    rankings: (bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-rankings.json`,
    averages: (bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-performance-averages.json`,
```

and on the client object:

```js
    rankings: (bracket, entry) => fetchJson(aramkitUrls(entry).rankings(bracket)),
    averages: (bracket, entry) => fetchJson(aramkitUrls(entry).averages(bracket)),
```

Run → PASS.

- [ ] **Step 5: Adapter `rankings` / `averages` (test first)**

Append to `test/data/aramkit/adapter.test.js`. Extend `fakeClient()` with two methods and counters:

```js
    async rankings(bracket) { calls.rankings = (calls.rankings ?? 0) + 1; return fixture('aramkit', 'champion-rankings-all.json'); },
    async averages(bracket) { calls.averages = (calls.averages ?? 0) + 1; return fixture('aramkit', 'champion-performance-averages-all.json'); },
```

Tests:

```js
test('rankings: map by id, cached per version, one fetch', async () => {
  const { adapter, client, fs } = setup();
  const r = await adapter.rankings('all');
  assert.equal(r.version, versions.versions[0].version);
  assert.deepEqual(r.byId[157], { id: 157, rank: 1, tier: 'S', winRate: 0.5764, pickRate: 0.1083, games: 804398 });
  await adapter.rankings('all');
  assert.equal(client.calls.rankings, 1);
  assert.ok([...fs.files.keys()].some((k) => k.endsWith('champion-rankings.json')));
  const again = createAramkitAdapter({ client: fakeClient(), cache: createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => 1_000_000 }), now: () => 1_000_000 });
  await again.rankings('all');
  // the second adapter instance reads the disk cache: no new rankings fetch on its own client
});

test('averages: combat shape', async () => {
  const { adapter } = setup();
  const a = await adapter.averages('all');
  assert.equal(a.combat.damageSelfMitigated, 46272.043);
  assert.equal(a.combat.healsOnTeammates, 479.216);
});
```

Run → FAIL. Implement in `src/data/aramkit/adapter.js` (import `combatFromAverages` from `./normalize.js`):

```js
  // Version-keyed single-file caches (rankings, averages): one fetch per data version per bracket.
  const fileMemo = new Map(); // key → { version, data }
  async function versionedFile(name, bracket, fetcher, shape) {
    const e = await versionEntry();
    const key = ['aramkit', bracket, name];
    const memo = fileMemo.get(key.join('/'));
    if (memo && memo.version === e.version) return memo.data;
    const hit = await cache.get(key);
    if (hit && hit.value && hit.value.version === e.version) { fileMemo.set(key.join('/'), hit.value); return hit.value.data; }
    const raw = await fetcher(bracket, e);
    const data = shape(raw, e.version);
    await cache.set(key, { version: e.version, data });
    fileMemo.set(key.join('/'), { version: e.version, data });
    return data;
  }
```

and on the returned adapter:

```js
    rankings: (bracket = 'all') => versionedFile('champion-rankings', bracket, client.rankings, (raw, version) => ({
      version,
      byId: Object.fromEntries((raw?.rows ?? []).filter((r) => Number.isInteger(r.id)).map((r) => [r.id, {
        id: r.id, rank: r.rank ?? null, tier: r.tier ?? null, winRate: r.winRate ?? null, pickRate: r.pickRate ?? null, games: r.sampleCount ?? 0,
      }])),
    })),
    averages: (bracket = 'all') => versionedFile('champion-performance-averages', bracket, client.averages, (raw, version) => ({
      version, combat: combatFromAverages(raw?.averages),
    })),
```

Run: `node --test test/data/aramkit/adapter.test.js` → PASS

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → all pass.

```bash
git add src/data/aramkit test/data/aramkit test/fixtures/aramkit/champion-performance-averages-all.json
git commit -m "feat(aramkit): champion rankings, performance averages, combat stats and item stats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: CommunityDragon per-champion playstyle source

**Files:**
- Create: `src/data/cdragon/champion.js`
- Create: `test/fixtures/cdragon/champions/157.json`, `54.json`, `99.json`, `222.json`
- Test: `test/data/cdragon/champion.test.js`

**Interfaces:**
- Produces `createCdragonChampions({ fetch, cache, now, log }) → { get(id) }` where `get(id) → Promise<CdragonChampion>` and
  `CdragonChampion = { id, roles: string[], damageType: 'physical'|'magic'|'mixed', attackType: 'melee'|'ranged', playstyle: { damage, durability, crowdControl, mobility, utility } }` (raw 1-3 values).
- Produces `normalizeCdragonChampion(raw)` (pure, exported).

- [ ] **Step 1: Fixtures (trimmed real data, 2026-10-02)**

`test/fixtures/cdragon/champions/157.json`:
```json
{"id":157,"name":"Yasuo","alias":"Yasuo","roles":["fighter","assassin"],"tacticalInfo":{"style":3,"difficulty":3,"damageType":"kPhysical","attackType":"melee"},"playstyleInfo":{"damage":3,"durability":1,"crowdControl":2,"mobility":3,"utility":2}}
```
`54.json`:
```json
{"id":54,"name":"Malphite","alias":"Malphite","roles":["tank","mage"],"tacticalInfo":{"style":8,"difficulty":1,"damageType":"kMagic","attackType":"melee"},"playstyleInfo":{"damage":1,"durability":3,"crowdControl":3,"mobility":1,"utility":1}}
```
`99.json`:
```json
{"id":99,"name":"Lux","alias":"Lux","roles":["mage","support"],"tacticalInfo":{"style":9,"difficulty":1,"damageType":"kMagic","attackType":"ranged"},"playstyleInfo":{"damage":3,"durability":1,"crowdControl":2,"mobility":1,"utility":2}}
```
`222.json`:
```json
{"id":222,"name":"Jinx","alias":"Jinx","roles":["marksman"],"tacticalInfo":{"style":2,"difficulty":2,"damageType":"kPhysical","attackType":"ranged"},"playstyleInfo":{"damage":3,"durability":1,"crowdControl":2,"mobility":1,"utility":1}}
```

- [ ] **Step 2: Failing tests**

Create `test/data/cdragon/champion.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCdragonChampions, normalizeCdragonChampion } from '../../../src/data/cdragon/champion.js';
import { CDRAGON_BASE } from '../../../src/data/cdragon/resources.js';
import { createCache } from '../../../src/data/cache.js';
import { createMemFs } from '../../helpers/memfs.js';
import { fixture } from '../../helpers/fixtures.js';

const yasuo = fixture('cdragon', 'champions', '157.json');
const url = (id) => `${CDRAGON_BASE}v1/champions/${id}.json`;

function fakeFetch(routes) {
  const calls = [];
  return { calls, fetch: async (u) => { calls.push(u); return u in routes ? { status: 200, json: async () => routes[u] } : { status: 404, json: async () => ({}) }; } };
}

test('normalizeCdragonChampion maps riot enums', () => {
  assert.deepEqual(normalizeCdragonChampion(yasuo), {
    id: 157, roles: ['fighter', 'assassin'], damageType: 'physical', attackType: 'melee',
    playstyle: { damage: 3, durability: 1, crowdControl: 2, mobility: 3, utility: 2 },
  });
  assert.equal(normalizeCdragonChampion({ id: 1, tacticalInfo: { damageType: 'kMixed', attackType: 'ranged' } }).damageType, 'mixed');
  assert.equal(normalizeCdragonChampion({ id: 1 }).attackType, 'melee');
  assert.deepEqual(normalizeCdragonChampion({ id: 1 }).playstyle, { damage: null, durability: null, crowdControl: null, mobility: null, utility: null });
});

test('get fetches once, then serves memory/disk cache within 24h', async () => {
  const { fetch, calls } = fakeFetch({ [url(157)]: yasuo });
  const fs = createMemFs();
  const clock = { t: 1_000_000 };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const src = createCdragonChampions({ fetch, cache, now: () => clock.t });
  const a = await src.get(157);
  assert.equal(a.attackType, 'melee');
  await src.get(157);
  assert.equal(calls.length, 1);
  clock.t += 25 * 3600 * 1000;
  await src.get(157);
  assert.equal(calls.length, 2);
});

test('404 rejects with HttpError; stale cache is served when refetch fails', async () => {
  const fs = createMemFs();
  const clock = { t: 1_000_000 };
  const cache = createCache({ dir: 'cache', ttlMs: 3600_000, fs, now: () => clock.t });
  const good = createCdragonChampions({ fetch: fakeFetch({ [url(54)]: fixture('cdragon', 'champions', '54.json') }).fetch, cache, now: () => clock.t });
  await good.get(54);
  clock.t += 25 * 3600 * 1000;
  const logs = [];
  const bad = createCdragonChampions({ fetch: fakeFetch({}).fetch, cache, now: () => clock.t, log: (m) => logs.push(m) });
  assert.equal((await bad.get(54)).attackType, 'melee');
  assert.match(logs[0], /serving stale/);
  await assert.rejects(bad.get(99), /HTTP 404/);
});
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `node --test test/data/cdragon/champion.test.js` → FAIL (module missing).

Create `src/data/cdragon/champion.js`:

```js
import { HttpError } from '../model.js';
import { CDRAGON_BASE } from './resources.js';

const FETCH_TIMEOUT_MS = 8000;
const REFRESH_MS = 24 * 3600 * 1000;
const DAMAGE = Object.freeze({ kPhysical: 'physical', kMagic: 'magic', kMixed: 'mixed' });
const PLAYSTYLE_KEYS = ['damage', 'durability', 'crowdControl', 'mobility', 'utility'];

export function normalizeCdragonChampion(raw) {
  const t = raw?.tacticalInfo ?? {};
  const p = raw?.playstyleInfo ?? {};
  return {
    id: raw?.id ?? null,
    roles: Array.isArray(raw?.roles) ? raw.roles.slice() : [],
    damageType: DAMAGE[t.damageType] ?? 'mixed',
    attackType: t.attackType === 'ranged' ? 'ranged' : 'melee',
    playstyle: Object.fromEntries(PLAYSTYLE_KEYS.map((k) => [k, typeof p[k] === 'number' ? p[k] : null])),
  };
}

export function createCdragonChampions({ fetch = globalThis.fetch, cache, now = Date.now, log = () => {}, userAgent = 'aram-mayhem-overlay/0.1 (personal tool)' } = {}) {
  const memo = new Map(); // id → { at, value }

  async function fetchJson(id) {
    const url = `${CDRAGON_BASE}v1/champions/${id}.json`;
    const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status !== 200) throw new HttpError(res.status, url);
    return res.json();
  }

  async function get(id) {
    const m = memo.get(id);
    if (m && now() - m.at < REFRESH_MS) return m.value;
    const key = ['cdragon', 'champions', String(id)];
    const hit = await cache.get(key);
    if (hit && now() - hit.fetchedAt < REFRESH_MS) { memo.set(id, { at: hit.fetchedAt, value: hit.value }); return hit.value; }
    try {
      const value = normalizeCdragonChampion(await fetchJson(id));
      await cache.set(key, value);
      memo.set(id, { at: now(), value });
      return value;
    } catch (e) {
      if (hit) { log(`WARN cdragon champion ${id} refetch failed, serving stale cache: ${e.message}`); return hit.value; }
      throw e;
    }
  }

  return { get };
}
```

Run: `node --test test/data/cdragon/champion.test.js` → PASS

- [ ] **Step 4: Commit**

```bash
git add src/data/cdragon/champion.js test/data/cdragon/champion.test.js test/fixtures/cdragon/champions
git commit -m "feat(cdragon): per-champion roles, damage type and playstyle source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Champion trait profiles (pure) + override file

**Files:**
- Create: `src/rank/profiles.js`
- Create: `data/profile-overrides.json`
- Test: `test/rank/profiles.test.js`

**Interfaces:**
- Produces `buildProfile({ id, riotId, name, icon, cdragon, combat, averages, override }) → Profile` where
  `Profile = { id, riotId, name, icon, roles: string[], ranged: boolean, physicalShare, magicShare, damageShare, style: { damage, durability, crowdControl, mobility, utility }, frontline, engage, peel, sustain, cc, poke, burst, sources: { cdragon, aramkit, override }, warnings: string[] }` — every numeric trait is 0..1.
- Produces `TRAITS = ['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke']` and `EMPTY_PROFILE(id, name)` (all traits 0, style 0.5, warnings `['profile unavailable']`).
- `cdragon` is a `CdragonChampion` from Task 3; `combat` / `averages` are `Combat` objects from Task 2.

- [ ] **Step 1: Failing tests**

Create `test/rank/profiles.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, TRAITS, EMPTY_PROFILE } from '../../src/rank/profiles.js';
import { normalizeCdragonChampion } from '../../src/data/cdragon/champion.js';
import { combatFromAverages } from '../../src/data/aramkit/normalize.js';
import { fixture } from '../../helpers/fixtures.js';

const cd = (id) => normalizeCdragonChampion(fixture('cdragon', 'champions', `${id}.json`));
const averages = combatFromAverages(fixture('aramkit', 'champion-performance-averages-all.json').averages);
const yasuoCombat = { physicalDamage: 35093, magicDamage: 5058, trueDamage: 2087, damageTaken: 37193, damageSelfMitigated: 74028, healsOnTeammates: 1, damageShieldedOnTeammates: 0, timeCcingOthers: 29.3, damageShare: 0.2061 };
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('Malphite without combat stats: neutral ratios, tank/melee rules', () => {
  const p = buildProfile({ id: 54, riotId: 'Malphite', name: 'Malphite', cdragon: cd(54) });
  assert.equal(p.ranged, false);
  assert.deepEqual(p.style, { damage: 0, durability: 1, crowdControl: 1, mobility: 0, utility: 0 });
  near(p.frontline, 0.95);           // 0.4*1 + 0.3*0.5 + 0.3*1 + 0.1 melee
  near(p.engage, 2 / 3);             // mean(mobility 0, cc 1, melee 1) * 1
  near(p.peel, (0 + 1 + 0.4) / 3);   // mean(utility 0, cc 1, melee 0.4) * 1 (mage)
  assert.equal(p.poke, 0);
  near(p.sustain, 0.5);              // neutral ratio
  near(p.cc, 0.75);                  // mean(1, 0.5)
  assert.equal(p.physicalShare, 0.1); // kMagic, no combat
  assert.deepEqual(p.sources, { cdragon: true, aramkit: false, override: false });
  assert.deepEqual(p.warnings, ['combat stats unavailable']);
});

test('Yasuo with combat stats: shares and mitigation ratio from aramkit', () => {
  const p = buildProfile({ id: 157, riotId: 'Yasuo', name: 'Yasuo', cdragon: cd(157), combat: yasuoCombat, averages });
  near(p.physicalShare, 35093 / (35093 + 5058));
  near(p.magicShare, 1 - p.physicalShare);
  near(p.frontline, 0.4 * 0 + 0.3 * Math.min(1, Math.min(2, 74028 / 46272.043) / 2) + 0.3 * 0.6 + 0.1);
  assert.equal(p.sustain, 0);        // heals+shields ≈ 0
  near(p.cc, (0.5 + Math.min(1, (29.3 / 33.9) / 2)) / 2);
  assert.equal(p.poke, 0);           // melee
  near(p.burst, 1);                  // damage 1 × assassin
  assert.equal(p.damageShare, 0.2061);
  assert.deepEqual(p.sources, { cdragon: true, aramkit: true, override: false });
  assert.deepEqual(p.warnings, []);
});

test('Lux and Jinx: ranged poke; peel for mage/support', () => {
  const lux = buildProfile({ id: 99, riotId: 'Lux', name: 'Lux', cdragon: cd(99) });
  near(lux.poke, 1);                 // mean(damage 1, 1 - durability 0) × mage
  near(lux.peel, (0.5 + 0.5 + 1) / 3);
  near(lux.engage, ((0 + 0.5 + 0.3) / 3) * 0.6);
  const jinx = buildProfile({ id: 222, riotId: 'Jinx', name: 'Jinx', cdragon: cd(222) });
  near(jinx.poke, 1);
  near(jinx.peel, ((0 + 0.5 + 1) / 3) * 0.6);
  assert.equal(jinx.physicalShare, 0.9);
});

test('override patches traits and is recorded', () => {
  const p = buildProfile({ id: 54, riotId: 'Malphite', name: 'Malphite', cdragon: cd(54), override: { engage: 1, poke: 0.2, note: 'ult' } });
  assert.equal(p.engage, 1);
  assert.equal(p.poke, 0.2);
  assert.equal(p.sources.override, true);
});

test('no cdragon → style defaults 0.5, roles empty, warning', () => {
  const p = buildProfile({ id: 1, riotId: 'Annie', name: 'Annie', combat: yasuoCombat, averages });
  assert.deepEqual(p.style, { damage: 0.5, durability: 0.5, crowdControl: 0.5, mobility: 0.5, utility: 0.5 });
  assert.equal(p.ranged, false);
  assert.ok(p.warnings.includes('champion profile unavailable'));
  assert.equal(p.sources.cdragon, false);
});

test('EMPTY_PROFILE and TRAITS', () => {
  const e = EMPTY_PROFILE(7, 'X');
  for (const t of TRAITS) assert.equal(e[t], 0);
  assert.deepEqual(TRAITS, ['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke']);
  assert.deepEqual(e.warnings, ['profile unavailable']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/rank/profiles.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/rank/profiles.js`**

```js
// Champion trait profiles, 0..1 per trait, derived by rules from CommunityDragon playstyle data and
// aramkit combat stats (relative to the per-bracket averages), then patched by data/profile-overrides.json.
export const TRAITS = Object.freeze(['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke']);
const STYLE_KEYS = ['damage', 'durability', 'crowdControl', 'mobility', 'utility'];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mean = (...xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function EMPTY_PROFILE(id, name = `#${id}`) {
  return {
    id, riotId: null, name, icon: null, roles: [], ranged: false, physicalShare: 0.5, magicShare: 0.5, damageShare: 0.2,
    style: Object.fromEntries(STYLE_KEYS.map((k) => [k, 0.5])),
    frontline: 0, engage: 0, peel: 0, sustain: 0, cc: 0, poke: 0, burst: 0,
    sources: { cdragon: false, aramkit: false, override: false }, warnings: ['profile unavailable'],
  };
}

export function buildProfile({ id, riotId = null, name = `#${id}`, icon = null, cdragon = null, combat = null, averages = null, override = null }) {
  const warnings = [];
  const roles = cdragon?.roles ?? [];
  const has = (...rs) => rs.some((r) => roles.includes(r));
  const style = {};
  for (const k of STYLE_KEYS) {
    const v = cdragon?.playstyle?.[k];
    style[k] = typeof v === 'number' ? clamp01((v - 1) / 2) : 0.5;
  }
  if (!cdragon) warnings.push('champion profile unavailable');
  const ranged = cdragon ? cdragon.attackType === 'ranged' : false;

  const haveCombat = !!(combat && averages);
  if (!haveCombat) warnings.push('combat stats unavailable');
  // champion stat relative to the bracket average, capped at 2x; neutral (1) when unknown
  const ratio = (k) => {
    const c = combat?.[k]; const a = averages?.[k];
    return typeof c === 'number' && typeof a === 'number' && a > 0 ? Math.min(2, c / a) : 1;
  };
  const sumRatio = (ks) => {
    const c = ks.reduce((s, k) => s + (typeof combat?.[k] === 'number' ? combat[k] : NaN), 0);
    const a = ks.reduce((s, k) => s + (typeof averages?.[k] === 'number' ? averages[k] : NaN), 0);
    return Number.isFinite(c) && Number.isFinite(a) && a > 0 ? Math.min(2, c / a) : 1;
  };

  const phys = combat?.physicalDamage ?? 0; const mag = combat?.magicDamage ?? 0;
  const physicalShare = phys + mag > 0 ? phys / (phys + mag)
    : cdragon?.damageType === 'magic' ? 0.1 : cdragon?.damageType === 'physical' ? 0.9 : 0.5;

  const roleFront = has('tank') ? 1 : has('fighter') ? 0.6 : 0;
  const p = {
    id, riotId, name, icon, roles: roles.slice(), ranged,
    physicalShare, magicShare: 1 - physicalShare,
    damageShare: typeof combat?.damageShare === 'number' ? combat.damageShare : 0.2,
    style,
    frontline: clamp01(0.4 * style.durability + 0.3 * Math.min(1, ratio('damageSelfMitigated') / 2) + 0.3 * roleFront + (ranged ? 0 : 0.1)),
    engage: clamp01(mean(style.mobility, style.crowdControl, ranged ? 0.3 : 1) * (has('tank', 'fighter', 'assassin') ? 1 : 0.6)),
    peel: clamp01(mean(style.utility, style.crowdControl, ranged ? 1 : 0.4) * (has('support', 'mage') ? 1 : 0.6)),
    sustain: clamp01(sumRatio(['healsOnTeammates', 'damageShieldedOnTeammates']) / 2),
    cc: clamp01(mean(style.crowdControl, Math.min(1, ratio('timeCcingOthers') / 2))),
    poke: ranged ? clamp01(mean(style.damage, 1 - style.durability) * (has('mage', 'marksman') ? 1 : 0.6)) : 0,
    burst: clamp01(style.damage * (ranged || has('assassin') ? 1 : 0.6)),
    sources: { cdragon: !!cdragon, aramkit: haveCombat, override: false },
    warnings,
  };
  if (override && typeof override === 'object') {
    for (const t of TRAITS) if (typeof override[t] === 'number') p[t] = clamp01(override[t]);
    p.sources.override = true;
  }
  return p;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/rank/profiles.test.js` → PASS. If a `near` assertion fails by rounding, fix the implementation, not the expected formula.

- [ ] **Step 5: Create `data/profile-overrides.json`** (first pass; tune after the gameplay round)

```json
{
  "Malphite": { "engage": 1, "frontline": 1, "note": "Unstoppable Force" },
  "Janna": { "peel": 1, "note": "Monsoon + shields" },
  "Lulu": { "peel": 1, "sustain": 0.8 },
  "Soraka": { "sustain": 1, "peel": 0.6 },
  "Blitzcrank": { "engage": 1, "note": "hook" },
  "Thresh": { "engage": 0.9, "peel": 0.9 },
  "Nautilus": { "engage": 1, "frontline": 1 },
  "Leona": { "engage": 1, "frontline": 1 },
  "Alistar": { "engage": 1, "peel": 0.9 },
  "Amumu": { "engage": 1 },
  "Yasuo": { "frontline": 0.3, "note": "windwall is not a frontline" },
  "Ziggs": { "poke": 1 },
  "Xerath": { "poke": 1 },
  "Jayce": { "poke": 0.9 },
  "Nidalee": { "poke": 0.9 },
  "Zyra": { "poke": 0.8 }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/rank/profiles.js test/rank/profiles.test.js data/profile-overrides.json
git commit -m "feat(rank): rule-derived champion trait profiles with override file

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Scoring engine (strength, coverage, fit, synergy, reasons, confidence)

**Files:**
- Create: `src/rank/weights.js`
- Create: `src/rank/lineup.js`
- Create: `data/synergy-rules.json`
- Test: `test/rank/lineup.test.js`

**Interfaces:**
- Produces `WEIGHTS` (default export object, see Step 3).
- Produces from `lineup.js`:
  - `shrunkWinRate(winRate, games, K) → number`
  - `strengthPercentile(id, rankings, weights) → number|null` (`rankings` is the adapter's `{ byId }`)
  - `coverage(profiles) → { frontline, engage, peel, sustain, cc, poke, physicalShare }`
  - `fitScore(candidate, allies, weights) → { fit, raw, gains: { [trait]: number }, balanceGain }`
  - `synergyScore(candidate, allies, rules) → { synergy, terms: [{ key, value, reason }] }`
  - `confidenceFor({ knownAllies, games, profile }, weights) → 'high'|'medium'|'low'`
  - `teamSummary(allies) → { knownAllies, coverage, physicalShare }`
  - `rankCandidates({ held, bench, allies, rankings, profiles, champData, rules, weights }) → Candidate[]` where `profiles`/`champData` are maps keyed by id, `allies` is `Profile[]`, and `Candidate = { id, riotId, name, icon, held, tier, winRate, games, score, components: { strength, fit, synergy }, confidence, reasons, warnings }` sorted by score desc.

- [ ] **Step 1: Failing tests**

Create `test/rank/lineup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shrunkWinRate, strengthPercentile, coverage, fitScore, synergyScore, confidenceFor, teamSummary, rankCandidates } from '../../src/rank/lineup.js';
import { WEIGHTS } from '../../src/rank/weights.js';
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';

const prof = (id, over = {}) => ({ ...EMPTY_PROFILE(id, `C${id}`), riotId: `C${id}`, warnings: [], sources: { cdragon: true, aramkit: true, override: false }, ...over });
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const rankingsOf = (rows) => ({ byId: Object.fromEntries(rows.map((r) => [r.id, { games: 1_000_000, tier: 'B', rank: 1, pickRate: 0.1, ...r }])) });

test('shrunkWinRate pulls low samples toward 50%', () => {
  assert.equal(shrunkWinRate(0.6, 0, 20000), 0.5);
  near(shrunkWinRate(0.6, 20000, 20000), 0.55);
  near(shrunkWinRate(0.6, 2_000_000, 20000), 0.6, 0.001);
});

test('strengthPercentile ranks among all rows; ties count half', () => {
  const r = rankingsOf([{ id: 1, winRate: 0.6 }, { id: 2, winRate: 0.5 }, { id: 3, winRate: 0.4 }]);
  near(strengthPercentile(1, r, WEIGHTS), 2.5 / 3);
  near(strengthPercentile(2, r, WEIGHTS), 1.5 / 3);
  near(strengthPercentile(3, r, WEIGHTS), 0.5 / 3);
  assert.equal(strengthPercentile(9, r, WEIGHTS), null);
});

test('coverage is noisy-OR per trait and damage-share-weighted physical share', () => {
  const c = coverage([prof(1, { frontline: 0.5, physicalShare: 1, damageShare: 0.3 }), prof(2, { frontline: 0.5, physicalShare: 0, damageShare: 0.1 })]);
  near(c.frontline, 0.75);
  near(c.physicalShare, 0.75);
  assert.equal(coverage([]).frontline, 0);
  assert.equal(coverage([]).physicalShare, 0.5);
});

test('fit: diminishing returns and damage balance; unknown allies shrink toward neutral', () => {
  const tank = prof(1, { frontline: 0.9 });
  const four = [prof(2), prof(3), prof(4), prof(5)];
  const first = fitScore(tank, four, WEIGHTS);
  const second = fitScore(tank, [prof(2, { frontline: 0.9 }), prof(3), prof(4), prof(5)], WEIGHTS);
  assert.ok(first.gains.frontline > second.gains.frontline);
  assert.ok(first.fit > second.fit);
  const adAllies = [prof(2, { physicalShare: 1 }), prof(3, { physicalShare: 1 }), prof(4, { physicalShare: 1 }), prof(5, { physicalShare: 1 })];
  assert.ok(fitScore(prof(9, { physicalShare: 0 }), adAllies, WEIGHTS).balanceGain > fitScore(prof(9, { physicalShare: 1 }), adAllies, WEIGHTS).balanceGain);
  const none = fitScore(tank, [], WEIGHTS);
  near(none.fit, WEIGHTS.fitNeutral);
});

test('synergy: generic terms and curated pairs', () => {
  const engager = prof(1, { engage: 1, riotId: 'Malphite' });
  const burst = prof(2, { burst: 1, riotId: 'Yasuo' });
  const s = synergyScore(engager, [burst], [{ a: 'Yasuo', b: 'Malphite', delta: 0.5, reason: 'knock-up for Last Breath' }]);
  assert.ok(s.synergy > 0.5);
  assert.ok(s.terms.some((t) => t.key === 'curated' && t.reason === 'knock-up for Last Breath'));
  assert.ok(s.terms.some((t) => t.key === 'engageBurst' && t.value === 1));
  assert.equal(synergyScore(prof(3), [], []).synergy, 0);
});

test('confidence levels', () => {
  const full = prof(1);
  assert.equal(confidenceFor({ knownAllies: 4, games: 60000, profile: full }, WEIGHTS), 'high');
  assert.equal(confidenceFor({ knownAllies: 3, games: 60000, profile: full }, WEIGHTS), 'medium');
  assert.equal(confidenceFor({ knownAllies: 3, games: 100, profile: full }, WEIGHTS), 'low');
  assert.equal(confidenceFor({ knownAllies: 4, games: 60000, profile: { ...full, sources: { cdragon: false, aramkit: true, override: false } } }, WEIGHTS), 'medium');
});

test('rankCandidates: held flagged, sorted by score, reasons and warnings, fallback strength', () => {
  const rankings = rankingsOf([{ id: 1, winRate: 0.58, tier: 'S' }, { id: 2, winRate: 0.50, tier: 'B' }, { id: 3, winRate: 0.45, tier: 'D', games: 1000 }]);
  const allies = [prof(10, { physicalShare: 1 }), prof(11, { physicalShare: 1 }), prof(12, { physicalShare: 1 }), prof(13, { physicalShare: 1 })];
  const profiles = { 1: prof(1, { physicalShare: 1 }), 2: prof(2, { physicalShare: 0, frontline: 0.9 }), 3: prof(3) };
  const champData = { 1: { champion: { id: 1, name: 'C1', icon: 'i1', winRate: 0.58, games: 1_000_000 } } };
  const out = rankCandidates({ held: 1, bench: [2, 3, 2], allies, rankings, profiles, champData, rules: [], weights: WEIGHTS });
  assert.deepEqual(out.map((c) => c.id).sort(), [1, 2, 3]);
  assert.equal(out.find((c) => c.id === 1).held, true);
  assert.equal(out.find((c) => c.id === 1).icon, 'i1');
  assert.equal(out.find((c) => c.id === 1).tier, 'S');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
  const two = out.find((c) => c.id === 2);
  assert.ok(two.reasons.includes('adds magic damage'));
  assert.ok(two.reasons.includes('adds frontline'));
  const three = out.find((c) => c.id === 3);
  assert.ok(three.warnings.some((w) => /low sample/.test(w)));
  assert.equal(three.confidence, 'medium'); // one failure: low sample (allies known, profile complete)
  // no rankings at all → strength from champ data
  const noRank = rankCandidates({ held: 1, bench: [], allies, rankings: null, profiles, champData, rules: [], weights: WEIGHTS });
  assert.ok(noRank[0].components.strength > 0.5);
  assert.ok(noRank[0].warnings.includes('rankings unavailable'));
});

test('teamSummary', () => {
  const t = teamSummary([prof(1, { frontline: 1 }), prof(2)]);
  assert.equal(t.knownAllies, 2);
  assert.equal(t.coverage.frontline, 1);
  assert.equal(typeof t.physicalShare, 'number');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/rank/lineup.test.js` → FAIL (modules missing).

- [ ] **Step 3: Create `src/rank/weights.js`**

```js
// Every tunable number of the recommender and build adaptation lives here.
export const WEIGHTS = Object.freeze({
  components: Object.freeze({ strength: 0.6, fit: 0.3, synergy: 0.1 }),
  traits: Object.freeze({ frontline: 1.0, balance: 1.0, engage: 0.8, peel: 0.8, cc: 0.7, sustain: 0.6, poke: 0.6 }),
  fitNeutral: 0.25,          // fit value assumed when no ally is known
  shrinkGames: 20_000,       // K in (wr·n + 0.5·K)/(n + K)
  lowSampleGames: 50_000,    // below this: low-sample warning + confidence hit
  reasonMinGain: 0.15,       // trait gain needed to become a reason
  reasonMinSynergy: 0.4,
  lackThreshold: 0.4,        // coverage below this after adding the candidate → "team still lacks"
  coverageThreshold: 0.6,    // UI ✓/✗ cut for the team strip
  archetypeCapPp: 3,         // max win-rate points a composition need may add to an archetype
  archetypeMinPick: 0.05,
  itemCapPp: 3,
  itemMinPick: 0.01,
  maxSituational: 3,
  antiHealItems: Object.freeze([3123, 3033, 3165, 3011, 3075]),
});
```

- [ ] **Step 4: Create `data/synergy-rules.json`**

```json
[
  { "a": "Yasuo", "b": "Malphite", "delta": 0.5, "reason": "knock-up for Last Breath" },
  { "a": "Yasuo", "b": "Alistar", "delta": 0.4, "reason": "knock-up for Last Breath" },
  { "a": "Yasuo", "b": "Nautilus", "delta": 0.3, "reason": "knock-up for Last Breath" },
  { "a": "Yone", "b": "Malphite", "delta": 0.3, "reason": "wombo follow-up" },
  { "a": "Kalista", "b": "Leona", "delta": 0.3, "reason": "Fate's Call engage" },
  { "a": "Lucian", "b": "Braum", "delta": 0.3, "reason": "Vulnerable passive procs" },
  { "a": "Xayah", "b": "Rakan", "delta": 0.4, "reason": "lovers' recall + engage" },
  { "a": "Twitch", "b": "Lulu", "delta": 0.3, "reason": "hypercarry enabling" },
  { "a": "Master Yi", "b": "Taric", "delta": 0.3, "reason": "invulnerability window" }
]
```

- [ ] **Step 5: Create `src/rank/lineup.js`**

```js
import { TRAITS, EMPTY_PROFILE } from './profiles.js';
import { WEIGHTS } from './weights.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const TRAIT_LABEL = Object.freeze({ frontline: 'frontline', engage: 'engage', peel: 'peel', sustain: 'sustain', cc: 'crowd control', poke: 'poke' });

export function shrunkWinRate(winRate, games, K) {
  const n = Number(games) || 0;
  const wr = typeof winRate === 'number' ? winRate : 0.5;
  return (wr * n + 0.5 * K) / (n + K);
}

// Fraction of all ranked champions whose shrunk win rate is below this champion's (ties count half).
export function strengthPercentile(id, rankings, weights = WEIGHTS) {
  const rows = Object.values(rankings?.byId ?? {});
  const me = rankings?.byId?.[id];
  if (!me || rows.length === 0) return null;
  const s = shrunkWinRate(me.winRate, me.games, weights.shrinkGames);
  let below = 0; let equal = 0;
  for (const r of rows) {
    const v = shrunkWinRate(r.winRate, r.games, weights.shrinkGames);
    if (v < s) below++; else if (v === s) equal++;
  }
  return (below + 0.5 * equal) / rows.length;
}

// Noisy-OR per trait: a second tank adds much less than the first.
export function coverage(profiles) {
  const out = {};
  for (const t of TRAITS) out[t] = 1 - profiles.reduce((acc, p) => acc * (1 - clamp01(p?.[t] ?? 0)), 1);
  const w = profiles.reduce((s, p) => s + (p?.damageShare ?? 0.2), 0);
  out.physicalShare = w > 0 ? profiles.reduce((s, p) => s + (p?.physicalShare ?? 0.5) * (p?.damageShare ?? 0.2), 0) / w : 0.5;
  return out;
}

export function fitScore(candidate, allies, weights = WEIGHTS) {
  const before = coverage(allies);
  const after = coverage([...allies, candidate]);
  const gains = {};
  let sum = 0; let wsum = 0;
  for (const t of TRAITS) {
    gains[t] = Math.max(0, after[t] - before[t]);
    sum += weights.traits[t] * gains[t]; wsum += weights.traits[t];
  }
  const balanceGain = clamp01(2 * Math.max(0, Math.abs(before.physicalShare - 0.5) - Math.abs(after.physicalShare - 0.5)));
  sum += weights.traits.balance * balanceGain; wsum += weights.traits.balance;
  const raw = wsum > 0 ? sum / wsum : 0;
  const known = Math.min(4, allies.length) / 4;
  const fit = weights.fitNeutral + (raw - weights.fitNeutral) * known;
  return { fit: clamp01(fit), raw, gains, balanceGain, after };
}

const isHypercarry = (p) => (p.roles.includes('marksman') || p.roles.includes('mage')) && p.style.durability <= 0.3;

export function synergyScore(candidate, allies, rules = []) {
  const terms = [];
  if (allies.length) {
    const engageBurst = clamp01(candidate.engage * Math.max(...allies.map((a) => a.burst)));
    const peelCarry = clamp01(candidate.peel * Math.max(...allies.map((a) => (isHypercarry(a) ? a.style.damage : 0))));
    const ccChain = clamp01(candidate.cc * Math.max(...allies.map((a) => a.cc)));
    terms.push({ key: 'engageBurst', value: engageBurst, reason: 'engage for allied burst' });
    terms.push({ key: 'peelCarry', value: peelCarry, reason: `peel for ${allies.find(isHypercarry)?.name ?? 'the carry'}` });
    terms.push({ key: 'ccChain', value: ccChain, reason: 'crowd-control chain' });
  }
  let curated = 0;
  for (const r of rules) {
    const pair = [r.a, r.b];
    const other = pair[0] === candidate.riotId ? pair[1] : pair[1] === candidate.riotId ? pair[0] : null;
    if (other && allies.some((a) => a.riotId === other)) { curated += Number(r.delta) || 0; terms.push({ key: 'curated', value: clamp01(Number(r.delta) || 0), reason: r.reason ?? `pairs with ${other}` }); }
  }
  const generic = terms.filter((t) => t.key !== 'curated');
  const base = generic.length ? generic.reduce((s, t) => s + t.value, 0) / generic.length : 0;
  return { synergy: clamp01(base + curated), terms };
}

export function confidenceFor({ knownAllies, games, profile }, weights = WEIGHTS) {
  const failures = [knownAllies < 4, (games ?? 0) < weights.lowSampleGames, !(profile?.sources?.cdragon && profile?.sources?.aramkit)].filter(Boolean).length;
  return failures === 0 ? 'high' : failures === 1 ? 'medium' : 'low';
}

export function teamSummary(allies) {
  const cov = coverage(allies);
  return { knownAllies: allies.length, coverage: cov, physicalShare: cov.physicalShare };
}

function reasonsFor({ candidate, strength, fit, synergy, games, weights }) {
  const pos = [];
  for (const t of TRAITS) if (fit.gains[t] >= weights.reasonMinGain) pos.push({ v: fit.gains[t], text: `adds ${TRAIT_LABEL[t]}` });
  if (fit.balanceGain >= weights.reasonMinGain) pos.push({ v: fit.balanceGain, text: candidate.physicalShare < 0.5 ? 'adds magic damage' : 'adds physical damage' });
  for (const term of synergy.terms) if (term.value >= weights.reasonMinSynergy) pos.push({ v: term.value, text: term.reason });
  if (strength >= 0.8) pos.push({ v: strength, text: 'top-tier win rate' });
  const reasons = [...new Set(pos.sort((a, b) => b.v - a.v).map((p) => p.text))].slice(0, 3);
  const lacking = TRAITS.filter((t) => fit.after[t] < weights.lackThreshold).sort((a, b) => fit.after[a] - fit.after[b])[0];
  if (lacking) reasons.push(`team still lacks ${TRAIT_LABEL[lacking]}`);
  if ((games ?? 0) < weights.lowSampleGames) reasons.push(`low sample (${Math.round((games ?? 0) / 1000)}k games)`);
  return reasons;
}

export function rankCandidates({ held, bench = [], allies = [], rankings = null, profiles = {}, champData = {}, rules = [], weights = WEIGHTS }) {
  const ids = [...new Set([held, ...bench].filter((id) => Number.isInteger(id) && id > 0))];
  const out = ids.map((id) => {
    const profile = profiles[id] ?? EMPTY_PROFILE(id);
    const row = rankings?.byId?.[id] ?? null;
    const champ = champData[id]?.champion ?? null;
    const warnings = [...(profile.warnings ?? [])];
    let strength = rankings ? strengthPercentile(id, rankings, weights) : null;
    if (strength == null) {
      warnings.push(rankings ? 'not in rankings' : 'rankings unavailable');
      const wr = shrunkWinRate(champ?.winRate, champ?.games, weights.shrinkGames);
      strength = clamp01((wr - 0.45) / 0.15);
    }
    const games = row?.games ?? champ?.games ?? 0;
    if (games < weights.lowSampleGames) warnings.push(`low sample (${Math.round(games / 1000)}k games)`);
    const fit = fitScore(profile, allies, weights);
    const synergy = synergyScore(profile, allies, rules);
    const score = Math.round(100 * (weights.components.strength * strength + weights.components.fit * fit.fit + weights.components.synergy * synergy.synergy));
    return {
      id, riotId: profile.riotId ?? champ?.riotId ?? null, name: champ?.name ?? profile.name, icon: champ?.icon ?? profile.icon ?? null,
      held: id === held, tier: row?.tier ?? champ?.tier ?? null, winRate: row?.winRate ?? champ?.winRate ?? null, games,
      score, components: { strength, fit: fit.fit, synergy: synergy.synergy },
      confidence: confidenceFor({ knownAllies: allies.length, games, profile }, weights),
      reasons: reasonsFor({ candidate: profile, strength, fit, synergy, games, weights }),
      warnings: [...new Set(warnings)],
    };
  });
  return out.sort((a, b) => b.score - a.score || (b.winRate ?? 0) - (a.winRate ?? 0));
}
```

- [ ] **Step 6: Run tests**

Run: `node --test test/rank/lineup.test.js` → PASS. If `rankCandidates` reason assertions fail because gains fall below 0.15 with the chosen fixture values, raise the fixture trait (e.g. `frontline: 0.9` already gives gain 0.9 against empty allies) rather than lowering the threshold.

- [ ] **Step 7: Commit**

```bash
git add src/rank/weights.js src/rank/lineup.js data/synergy-rules.json test/rank/lineup.test.js
git commit -m "feat(rank): lineup scoring engine with strength, composition fit, synergy and reasons

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Build adaptation (archetype modifier + situational items)

**Files:**
- Modify: `src/rank/builds.js`
- Test: `test/rank/builds.test.js`

**Interfaces:**
- `pickBuild(champData, { minPick = 0.05, context = null, weights = WEIGHTS } = {})`; `context = { allies: Profile[], enemies: Profile[]|null, itemCategories: { [id]: string[] } }`.
- Output gains `context: 'none'|'allies'|'both'`, `situational: [{ item: { id, name, icon }, winRate, pickRate, games, reason }]`, and on `primary` when the archetype was swapped: `contextDelta` (pp, number) and `contextReason` (string). Without swap both are `null`.

- [ ] **Step 1: Failing tests**

Append to `test/rank/builds.test.js` (`real`, `arch`, `pickBuild` exist). Add imports:

```js
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';
import { WEIGHTS } from '../../src/rank/weights.js';
const prof = (id, over = {}) => ({ ...EMPTY_PROFILE(id, `C${id}`), warnings: [], ...over });
const squishy = () => [prof(1), prof(2), prof(3), prof(4)];                  // no frontline anywhere

test('no context → context none, no situational, primary unchanged', () => {
  const b = pickBuild(real);
  assert.equal(b.context, 'none');
  assert.deepEqual(b.situational, []);
  assert.equal(b.primary.contextDelta, null);
});

test('allies only: a frontline need can promote bruiser within the cap; swap is explained', () => {
  const d = { build: { archetypes: [arch({ key: 'crit', name: 'Crit', winRate: 0.60, pickRate: 0.6 }), arch({ key: 'bruiser', name: 'Bruiser', winRate: 0.58, pickRate: 0.2 })] }, summoners: [], skills: [], items: [] };
  const b = pickBuild(d, { context: { allies: squishy(), enemies: null, itemCategories: {} } });
  assert.equal(b.context, 'allies');
  assert.equal(b.primary.key, 'bruiser');
  assert.ok(b.primary.contextDelta > 0 && b.primary.contextDelta <= WEIGHTS.archetypeCapPp);
  assert.equal(b.primary.contextReason, 'team lacks frontline');
  // a 5 pp gap is beyond the 3 pp cap: no swap
  const far = { ...d, build: { archetypes: [arch({ key: 'crit', winRate: 0.63, pickRate: 0.6 }), arch({ key: 'bruiser', winRate: 0.58, pickRate: 0.2 })] } };
  assert.equal(pickBuild(far, { context: { allies: squishy(), enemies: null, itemCategories: {} } }).primary.key, 'crit');
  // below the pick floor the alternative may not overtake
  const rare = { ...d, build: { archetypes: [arch({ key: 'crit', winRate: 0.60, pickRate: 0.6 }), arch({ key: 'bruiser', winRate: 0.58, pickRate: 0.02 })] } };
  assert.equal(pickBuild(rare, { context: { allies: squishy(), enemies: null, itemCategories: {} } }).primary.key, 'crit');
  // frontline already covered → no modifier
  const covered = [prof(1, { frontline: 1 }), prof(2), prof(3), prof(4)];
  assert.equal(pickBuild(d, { context: { allies: covered, enemies: null, itemCategories: {} } }).primary.key, 'crit');
});

test('both teams: situational items ranked by threat-matching categories, core excluded, max 3', () => {
  const items = [
    { id: 3065, name: 'Spirit Visage', icon: null, winRate: 0.55, pickRate: 0.05, games: 1000 },
    { id: 3075, name: 'Thornmail', icon: null, winRate: 0.54, pickRate: 0.04, games: 1000 },
    { id: 3047, name: 'Plated Steelcaps', icon: null, winRate: 0.56, pickRate: 0.3, games: 1000 },
    { id: 3031, name: 'Infinity Edge', icon: null, winRate: 0.62, pickRate: 0.5, games: 1000 },
    { id: 3153, name: 'BotRK', icon: null, winRate: 0.6, pickRate: 0.2, games: 1000 },
    { id: 9999, name: 'Rare', icon: null, winRate: 0.9, pickRate: 0.001, games: 10 },
  ];
  const itemCategories = { 3065: ['Health', 'SpellBlock'], 3075: ['Armor', 'Health'], 3047: ['Armor', 'Boots'], 3031: ['Damage', 'CriticalStrike'], 3153: ['Damage', 'LifeSteal'], 9999: ['Armor'] };
  const d = { build: { archetypes: [arch({ key: 'crit', winRate: 0.6, pickRate: 0.6, core: [{ id: 3031, name: 'IE', icon: null }] })] }, summoners: [], skills: [], items };
  const enemies = [prof(5, { physicalShare: 1, damageShare: 0.3 }), prof(6, { physicalShare: 1, damageShare: 0.3 }), prof(7, { physicalShare: 1 }), prof(8, { physicalShare: 1 }), prof(9, { physicalShare: 1 })];
  const b = pickBuild(d, { context: { allies: squishy(), enemies, itemCategories } });
  assert.equal(b.context, 'both');
  assert.ok(b.situational.length <= 3);
  const ids = b.situational.map((s) => s.item.id);
  assert.ok(ids.includes(3047) && ids.includes(3075), 'armor items vs an all-AD lineup');
  assert.ok(!ids.includes(3031), 'core item excluded');
  assert.ok(!ids.includes(9999), 'below pick floor excluded');
  assert.match(b.situational.find((s) => s.item.id === 3047).reason, /physical damage → Armor/);
  const healing = [prof(5, { sustain: 1 })];
  const h = pickBuild(d, { context: { allies: squishy(), enemies: healing, itemCategories } });
  assert.ok(h.situational.some((s) => s.item.id === 3075 && /anti-heal/.test(s.reason)));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/rank/builds.test.js` → FAIL (`context` undefined, etc.).

- [ ] **Step 3: Implement in `src/rank/builds.js`**

Replace the file body (keep `best()` as is) with:

```js
import { WEIGHTS } from './weights.js';
import { coverage } from './lineup.js';

// Highest win rate among entries with pickRate >= minPick; if none qualify, among all.
function best(list, minPick) { /* unchanged */ }

// What each aramkit archetype brings to a composition.
const ARCHETYPE_NEEDS = Object.freeze({
  bruiser: ['frontline'], tank: ['frontline'], juggernaut: ['frontline'],
  ap: ['magic'], burst: ['magic'], crit: ['physical'], ad: ['physical'], on_hit: ['physical'], lethality: ['physical'],
  support: ['peel', 'sustain'], enchanter: ['peel', 'sustain'], utility: ['peel'],
});
const NEED_LABEL = Object.freeze({ frontline: 'frontline', peel: 'peel', sustain: 'sustain', magic: 'magic damage', physical: 'physical damage' });
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function unmetNeeds(allies) {
  const cov = coverage(allies);
  return {
    frontline: 1 - cov.frontline, peel: 1 - cov.peel, sustain: 1 - cov.sustain,
    magic: clamp01((cov.physicalShare - 0.5) * 2), physical: clamp01((0.5 - cov.physicalShare) * 2),
  };
}

function archetypeModifier(key, unmet, weights) {
  const needs = ARCHETYPE_NEEDS[key] ?? [];
  let top = null;
  for (const n of needs) if (!top || unmet[n] > unmet[top]) top = n;
  return { pp: top ? weights.archetypeCapPp * unmet[top] : 0, need: top };
}

function chooseArchetype(archetypes, minPick, context, weights) {
  const plain = best(archetypes, minPick);
  if (!context || !Array.isArray(context.allies) || context.allies.length === 0 || !plain) return { primary: plain, contextDelta: null, contextReason: null };
  const unmet = unmetNeeds(context.allies);
  const adjusted = (a) => (a.winRate ?? 0) + archetypeModifier(a.key, unmet, weights).pp / 100;
  const pool = archetypes.filter((a) => (a.pickRate ?? 0) >= weights.archetypeMinPick);
  const winner = pool.slice().sort((a, b) => adjusted(b) - adjusted(a))[0] ?? plain;
  if (winner === plain) return { primary: plain, contextDelta: null, contextReason: null };
  const mod = archetypeModifier(winner.key, unmet, weights);
  return { primary: winner, contextDelta: Math.round((adjusted(winner) - adjusted(plain)) * 1000) / 10, contextReason: `team lacks ${NEED_LABEL[mod.need]}` };
}

const CATEGORY_THREAT = Object.freeze({ Armor: 'physical', SpellBlock: 'magic', Tenacity: 'cc', Health: 'burst' });
const THREAT_REASON = Object.freeze({
  physical: (t) => `${Math.round(t * 100)} % physical damage → Armor`,
  magic: (t) => `${Math.round(t * 100)} % magic damage → Magic resist`,
  cc: () => 'heavy crowd control → Tenacity',
  burst: () => 'high burst → Health',
  healing: () => 'enemy healing → anti-heal',
});

function situationalItems(champData, primary, context, weights) {
  const enemies = context?.enemies;
  if (!Array.isArray(enemies) || enemies.length === 0) return [];
  const cov = coverage(enemies);
  const threats = {
    physical: cov.physicalShare, magic: 1 - cov.physicalShare, cc: cov.cc,
    burst: Math.max(0, ...enemies.map((e) => (e.poke > 0.5 || e.roles.includes('assassin') ? e.burst : 0))),
    healing: cov.sustain,
  };
  const exclude = new Set([...(primary?.core ?? []).map((i) => i.id), primary?.boots?.id, ...(primary?.starter ?? []).map((i) => i.id)].filter((x) => x != null));
  const cats = context.itemCategories ?? {};
  const scored = [];
  for (const it of champData.items ?? []) {
    if ((it.pickRate ?? 0) < weights.itemMinPick || exclude.has(it.id)) continue;
    let bestThreat = null; let bestValue = 0;
    for (const c of cats[it.id] ?? []) {
      const t = CATEGORY_THREAT[c];
      if (t && threats[t] > bestValue) { bestValue = threats[t]; bestThreat = t; }
    }
    if (weights.antiHealItems.includes(it.id) && threats.healing > bestValue) { bestValue = threats.healing; bestThreat = 'healing'; }
    if (!bestThreat || bestValue < 0.3) continue;
    scored.push({ item: { id: it.id, name: it.name, icon: it.icon }, winRate: it.winRate, pickRate: it.pickRate, games: it.games,
      reason: THREAT_REASON[bestThreat](bestValue), adjusted: (it.winRate ?? 0) + (weights.itemCapPp * bestValue) / 100 });
  }
  return scored.sort((a, b) => b.adjusted - a.adjusted).slice(0, weights.maxSituational).map(({ adjusted, ...rest }) => rest);
}

export function pickBuild(champData, { minPick = 0.05, context = null, weights = WEIGHTS } = {}) {
  const archetypes = champData?.build?.archetypes ?? [];
  if (archetypes.length === 0) return null;
  const { primary, contextDelta, contextReason } = chooseArchetype(archetypes, minPick, context, weights);
  const spells = best(champData.summoners, minPick);
  const skill = best(champData.skills, minPick);
  const built = {
    context: !context || !context.allies?.length ? 'none' : context.enemies?.length ? 'both' : 'allies',
    primary: {
      key: primary.key, name: primary.name, winRate: primary.winRate, pickRate: primary.pickRate, games: primary.games,
      starter: primary.starters[0]?.items ?? [], boots: primary.boots[0]?.item ?? null, core: primary.core, later: primary.later.map((l) => l.item),
      spells: spells?.names ?? [], skillOrder: skill?.order ?? null, routeWinRate: primary.routeWinRate, routeGames: primary.routeGames,
      contextDelta, contextReason,
    },
    alternatives: archetypes.filter((a) => a !== primary).map((a) => ({ key: a.key, name: a.name, winRate: a.winRate, pickRate: a.pickRate, games: a.games })),
    situational: [],
  };
  built.situational = situationalItems(champData, built.primary, context, weights);
  return built;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/rank/builds.test.js` → PASS (existing assertions still hold: no context → same primary; `b.primary` keys are a superset). Run `npm test` to confirm the state/http tests that read `build.primary.key` still pass.

- [ ] **Step 5: Commit**

```bash
git add src/rank/builds.js test/rank/builds.test.js
git commit -m "feat(rank): context-aware archetype choice and situational items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Recommender service + app-state slice with revision guard

**Files:**
- Create: `src/server/recommend.js`
- Create: `src/util/dumps.js`
- Modify: `src/server/state.js`
- Test: `test/server/recommend.test.js`, `test/server/state.test.js`

**Interfaces:**
- Produces `createRecommender({ repository, aramkit, cdragonChampions, cdragon, champIndex, overrides = {}, synergyRules = [], weights = WEIGHTS, debugDir = null, autoDump = false, fs = null, path = null, now = Date.now, log })`
  with `compute({ held, bench, allies, enemies, bracket }) → Promise<{ recommend: { context: 'champselect'|'ingame', team, candidates, warnings }, profiles: { allies: Profile[], enemies: Profile[] }, itemCategories: { [id]: string[] } }>`.
  `aramkit` = adapter from Task 2; `cdragonChampions` from Task 3; `cdragon` = existing `createCdragonResources` (for `load().itemsById`); `repository.getChamp(id, bracket)` existing.
- `createAppState({ repository, recommender = null, ... })`: `setGame()` recomputes when `lineupRev` changes (phase champselect/ingame), clears on phase `none`; `snapshot()` adds `recommend: { rev, ...} | null` and passes `context` to `pickBuild`; new `previewRecommend({ held, bench, allies, enemies }) → { recommend, build }`.
- `pruneDumps(fs, path, dir, prefix, limit)` from `src/util/dumps.js`.

- [ ] **Step 1: Failing recommender tests**

Create `test/server/recommend.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommender } from '../../src/server/recommend.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { normalizeAramkit, combatFromAverages } from '../../src/data/aramkit/normalize.js';
import { normalizeCdragonChampion } from '../../src/data/cdragon/champion.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const champIndex = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const yasuo = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const rankingsRaw = fixture('aramkit', 'champion-rankings-all.json');
const rankings = { version: '16.19', byId: Object.fromEntries(rankingsRaw.rows.map((r) => [r.id, { id: r.id, rank: r.rank, tier: r.tier, winRate: r.winRate, pickRate: r.pickRate, games: r.sampleCount }])) };
const averages = { version: '16.19', combat: combatFromAverages(fixture('aramkit', 'champion-performance-averages-all.json').averages) };
const CD = { 157: '157.json', 54: '54.json', 99: '99.json', 222: '222.json' };

function deps({ failChamp = [], failCdragon = [], failRankings = false } = {}) {
  const calls = { champ: [], cdragon: [] };
  return {
    calls,
    repository: { async getChamp(id, bracket) { calls.champ.push([id, bracket]); if (failChamp.includes(id)) throw new Error(`no data for ${id}`); return { data: { ...yasuo, champion: { ...yasuo.champion, id, name: champIndex.byId(id)?.name ?? `#${id}` } }, stale: false, source: 'aramkit' }; } },
    aramkit: { async rankings() { if (failRankings) throw new Error('rankings down'); return rankings; }, async averages() { return averages; } },
    cdragonChampions: { async get(id) { calls.cdragon.push(id); if (failCdragon.includes(id) || !CD[id]) throw new Error('HTTP 404'); return normalizeCdragonChampion(fixture('cdragon', 'champions', CD[id])); } },
    cdragon: { async load() { return { itemsById: { 3065: { id: 3065, categories: ['Health', 'SpellBlock'] } } }; } },
    champIndex,
  };
}

test('champ select: candidates for held + bench, allies profiled, every champion fetched once', async () => {
  const d = deps();
  const rec = createRecommender({ ...d, overrides: { Malphite: { engage: 1 } }, synergyRules: [{ a: 'Yasuo', b: 'Malphite', delta: 0.5, reason: 'knock-up' }] });
  const r = await rec.compute({ held: 157, bench: [99, 54], allies: [54, 222, 1, 62], enemies: [], bracket: 'all' });
  assert.equal(r.recommend.context, 'champselect');
  assert.deepEqual(r.recommend.candidates.map((c) => c.id).sort(), [54, 99, 157]);
  assert.equal(r.recommend.candidates.find((c) => c.id === 157).held, true);
  assert.equal(r.recommend.team.knownAllies, 4);
  assert.equal(r.profiles.allies.length, 4);
  assert.equal(r.profiles.enemies.length, 0);
  assert.deepEqual(r.itemCategories, { 3065: ['Health', 'SpellBlock'] });
  assert.equal(new Set(d.calls.champ.map(([id]) => id)).size, d.calls.champ.length, 'no duplicate champion fetches');
  assert.ok(r.recommend.candidates.find((c) => c.id === 157).reasons.includes('knock-up'));
  assert.ok(r.recommend.warnings.some((w) => /Annie|Wukong/.test(w)), 'missing cdragon data for 1/62 is a warning, not a failure');
});

test('in game: no candidates, enemies profiled, context ingame', async () => {
  const rec = createRecommender(deps());
  const r = await rec.compute({ held: 157, bench: [], allies: [54], enemies: [99, 222], bracket: 'all' });
  assert.equal(r.recommend.context, 'ingame');
  assert.deepEqual(r.recommend.candidates.map((c) => c.id), [157]);
  assert.equal(r.profiles.enemies.length, 2);
});

test('degradation: rankings down → strength fallback with warning; champ fetch failure → warning, profile still built from cdragon', async () => {
  const rec = createRecommender(deps({ failRankings: true, failChamp: [99] }));
  const r = await rec.compute({ held: 157, bench: [99], allies: [54], enemies: [], bracket: 'all' });
  assert.ok(r.recommend.warnings.some((w) => /rankings unavailable/.test(w)));
  const lux = r.recommend.candidates.find((c) => c.id === 99);
  assert.ok(lux, 'Lux still ranked');
  assert.equal(lux.name, 'Lux');
  assert.ok(lux.warnings.includes('combat stats unavailable'));
});

test('debug dump writes recommend-<ts>.json and prunes', async () => {
  const writes = []; const rms = [];
  const fs = { mkdir: async () => {}, writeFile: async (p, d) => writes.push(p), readdir: async () => ['recommend-1.json', 'recommend-2.json', 'recommend-3.json'], rm: async (p) => rms.push(p) };
  const path = await import('node:path');
  const rec = createRecommender({ ...deps(), debugDir: 'data/debug', autoDump: true, fs, path, now: () => 3, maxDumps: 2 });
  await rec.compute({ held: 157, bench: [], allies: [], enemies: [], bracket: 'all' });
  assert.ok(writes[0].endsWith('recommend-3.json'));
  assert.ok(rms.some((p) => p.endsWith('recommend-1.json')));
});
```

- [ ] **Step 2: Run to verify failure, then create `src/util/dumps.js`**

Run: `node --test test/server/recommend.test.js` → FAIL.

```js
// Keep the newest `limit` files named `${prefix}<timestamp>.json` in `dir` (best effort).
export async function pruneDumps(fs, path, dir, prefix, limit) {
  const names = await fs.readdir(dir);
  const dumps = names.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort();
  for (const name of dumps.slice(0, Math.max(0, dumps.length - limit))) {
    await fs.rm(path.resolve(dir, name), { force: true }).catch(() => {});
  }
}
```

- [ ] **Step 3: Create `src/server/recommend.js`**

```js
import { buildProfile } from '../rank/profiles.js';
import { rankCandidates, teamSummary } from '../rank/lineup.js';
import { WEIGHTS } from '../rank/weights.js';
import { pruneDumps } from '../util/dumps.js';

const unique = (ids) => [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];

export function createRecommender({
  repository, aramkit, cdragonChampions, cdragon, champIndex,
  overrides = {}, synergyRules = [], weights = WEIGHTS,
  debugDir = null, autoDump = false, fs = null, path = null, maxDumps = 50, now = Date.now, log = () => {},
}) {
  async function settle(p) { try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; } }

  async function compute({ held = null, bench = [], allies = [], enemies = [], bracket = 'all' }) {
    const warnings = [];
    const ids = unique([held, ...bench, ...allies, ...enemies]);
    const [rk, av] = await Promise.all([settle(aramkit.rankings(bracket)), settle(aramkit.averages(bracket))]);
    const rankings = rk.ok ? rk.value : null;
    if (!rk.ok) warnings.push(`rankings unavailable: ${rk.error.message}`);
    const averages = av.ok ? av.value.combat : null;
    if (!av.ok) warnings.push(`averages unavailable: ${av.error.message}`);

    const champData = {}; const profiles = {};
    await Promise.all(ids.map(async (id) => {
      const info = champIndex.byId(id);
      const label = info?.name ?? `#${id}`;
      const [cd, cg] = await Promise.all([settle(repository.getChamp(id, bracket)), settle(cdragonChampions.get(id))]);
      if (cd.ok) champData[id] = cd.value.data; else warnings.push(`${label}: ${cd.error.message}`);
      if (!cg.ok) warnings.push(`${label}: profile unavailable (${cg.error.message})`);
      const c = champData[id]?.champion ?? null;
      profiles[id] = buildProfile({
        id, riotId: info?.riotId ?? c?.riotId ?? null, name: c?.name ?? label, icon: c?.icon ?? info?.icon ?? null,
        cdragon: cg.ok ? cg.value : null, combat: c?.combat ?? null, averages, override: overrides[info?.riotId] ?? null,
      });
    }));

    const allyProfiles = allies.map((id) => profiles[id]).filter(Boolean);
    const enemyProfiles = enemies.map((id) => profiles[id]).filter(Boolean);
    const candidates = rankCandidates({ held, bench, allies: allyProfiles, rankings, profiles, champData, rules: synergyRules, weights });
    let itemCategories = {};
    try {
      const res = await cdragon.load();
      itemCategories = Object.fromEntries(Object.values(res.itemsById ?? {}).map((i) => [i.id, Array.isArray(i.categories) ? i.categories : []]));
    } catch (e) { warnings.push(`item categories unavailable: ${e.message}`); }

    const result = {
      recommend: { context: enemies.length ? 'ingame' : 'champselect', team: teamSummary(allyProfiles), candidates, warnings },
      profiles: { allies: allyProfiles, enemies: enemyProfiles },
      itemCategories,
    };
    if (autoDump && debugDir && fs && path) {
      try {
        await fs.mkdir(debugDir, { recursive: true });
        await fs.writeFile(path.resolve(debugDir, `recommend-${now()}.json`), JSON.stringify({ input: { held, bench, allies, enemies, bracket }, profiles, recommend: result.recommend }, null, 2));
        await pruneDumps(fs, path, debugDir, 'recommend-', maxDumps);
      } catch (e) { log(`[recommend] debug dump failed: ${e.message}`); }
    }
    return result;
  }

  return { compute };
}
```

Run: `node --test test/server/recommend.test.js` → PASS

- [ ] **Step 4: Failing state tests**

Append to `test/server/state.test.js` (`createAppState`, `buildPayload`, `fakeRepo`, `game`, `yasuo` exist). Add a fake recommender:

```js
import { EMPTY_PROFILE } from '../../src/rank/profiles.js';
function fakeRecommender({ delayMs = 0, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async compute(input) {
      calls.push(input);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw new Error('recommender exploded');
      const p = (id) => ({ ...EMPTY_PROFILE(id, `C${id}`), frontline: 0 });
      return {
        recommend: { context: input.enemies.length ? 'ingame' : 'champselect', team: { knownAllies: input.allies.length, coverage: {}, physicalShare: 0.5 }, candidates: [{ id: input.held, held: true, score: 50, reasons: [], warnings: [] }], warnings: [] },
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
  const rec = fakeRecommender({ delayMs: 30 });
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
```

- [ ] **Step 5: Run to verify failure, then implement in `src/server/state.js`**

Run: `node --test test/server/state.test.js` → FAIL.

Changes:

```js
export function buildPayload({ game, loading, champData, view, source, stale, errors, offer = null, ocr = EMPTY_OCR, recommend = null, buildContext = null }) {
  // ...
    build: champData ? pickBuild(champData, { context: buildContext }) : null,
  // ...
    recommend,
```

In `createAppState({ repository, recommender = null, now = Date.now, maxErrors = 10, log = () => {} })` add:

```js
  let recommend = null;      // { rev, context, team, candidates, warnings }
  let buildContext = null;   // { allies, enemies, itemCategories }
  let pendingRecommend = Promise.resolve();

  async function loadRecommend(g) {
    const rev = g.lineupRev;
    try {
      const r = await recommender.compute({ ...g.lineup, bracket: view.bracket });
      if (game.lineupRev !== rev) return; // superseded
      recommend = { rev, ...r.recommend };
      buildContext = { allies: r.profiles.allies, enemies: g.phase === 'ingame' ? r.profiles.enemies : null, itemCategories: r.itemCategories };
      for (const w of r.recommend.warnings) log(`[recommend] ${w}`);
    } catch (e) {
      if (game.lineupRev !== rev) return;
      recommend = null; buildContext = null;
      pushError('recommend', e.message);
    }
  }
```

In `setGame(next)`:

```js
    setGame(next) {
      const prevError = game.error;
      const prevRev = game.lineupRev;
      game = { ...next };
      if (game.phase !== 'ingame') offer = null;
      if (next.error && next.error !== prevError) pushError('game', next.error);
      if (recommender) {
        if (game.phase === 'none') { recommend = null; buildContext = null; }
        else if (game.phase !== 'loading' && game.lineupRev !== prevRev) pendingRecommend = loadRecommend(game);
      }
      return Promise.all([ensureLoaded(), pendingRecommend]).then(() => undefined);
    },
```

`snapshot()` passes `recommend, buildContext` to `buildPayload`. Add:

```js
    async previewRecommend({ held = null, bench = [], allies = [], enemies = [] }) {
      if (!recommender) throw new Error('recommender not configured');
      const r = await recommender.compute({ held, bench, allies, enemies, bracket: view.bracket });
      let build = null;
      if (held) {
        const data = (await repository.getChamp(held, view.bracket)).data;
        build = pickBuild(data, { context: { allies: r.profiles.allies, enemies: enemies.length ? r.profiles.enemies : null, itemCategories: r.itemCategories } });
      }
      return { recommend: { rev: null, preview: true, ...r.recommend }, build };
    },
```

Also, when `setView({ bracket })` changes the bracket and a lineup is active, recompute: at the end of `setView`, `if (recommender && patch.bracket !== undefined && game.lineupRev > 0 && game.phase !== 'none') pendingRecommend = loadRecommend(game);` and return `Promise.all([ensureLoaded(), pendingRecommend]).then(() => undefined)`.

- [ ] **Step 6: Run the suite**

Run: `npm test` → all pass (the existing `payload carries offer and ocr with safe defaults` test may need `recommend: null` added to its expectation if it does a deep-equal on keys; adjust that test).

- [ ] **Step 7: Commit**

```bash
git add src/server/recommend.js src/server/state.js src/util/dumps.js test/server/recommend.test.js test/server/state.test.js
git commit -m "feat(server): recommender service and app-state slice with lineup revision guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: HTTP preview endpoint, config flag, main wiring

**Files:**
- Modify: `src/server/http.js`
- Modify: `src/config.js`
- Modify: `src/main.js`
- Test: `test/server/http.test.js`, `test/config.test.js`

**Interfaces:**
- `POST /api/recommend/preview` body `{ held, bench: [], allies: [], enemies: [] }` (numbers or names/riotIds) → `state.previewRecommend` result; 400 `{ error: 'unknown champions: X' }`; 503 when the state has no recommender (`state.previewRecommend` throws `recommender not configured`).
- `resolveChampionIds(list, champIndex) → { ids: number[], unknown: string[] }` exported from `http.js`.
- Config: `recDebug` (bool) from `--rec-debug` / `REC_DEBUG`.

- [ ] **Step 1: Failing http tests**

Append to `test/server/http.test.js`. Extend the fake `state` object with:

```js
  previewRecommend: async (input) => ({ recommend: { preview: true, rev: null, context: input.enemies.length ? 'ingame' : 'champselect', candidates: [], team: {}, warnings: [] }, build: null, input }),
```

and add `resolveChampionIds` to the import from `../../src/server/http.js`. Tests:

```js
test('resolveChampionIds accepts ids, riotIds and display names', () => {
  const r = resolveChampionIds([157, 'MonkeyKing', 'Wukong', 'lux', 'Nope', 0], champIndex);
  assert.deepEqual(r.ids, [157, 62, 62, 99]);
  assert.deepEqual(r.unknown, ['Nope', '0']);
});

test('POST /api/recommend/preview resolves names and rejects unknown ones', async () => {
  const ok = await post('/api/recommend/preview', { held: 'Yasuo', bench: [99, 'Malphite'], allies: ['Annie', 'Wukong'], enemies: [] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.input, { held: 157, bench: [99, 54], allies: [1, 62], enemies: [] });
  const bad = await post('/api/recommend/preview', { held: 'Yasuo', bench: ['Nope'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /unknown champions: Nope/);
  const noHeld = await post('/api/recommend/preview', { bench: [99] });
  assert.equal(noHeld.status, 400);
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `node --test test/server/http.test.js` → FAIL.

In `src/server/http.js` add:

```js
export function resolveChampionIds(list, champIndex) {
  const ids = []; const unknown = [];
  for (const v of Array.isArray(list) ? list : []) {
    let hit = null;
    if (Number.isInteger(v)) hit = champIndex.byId(v);
    else if (typeof v === 'string') {
      hit = champIndex.byRiotId(v) ?? champIndex.search(v, 5).find((c) => c.name.toLowerCase() === v.trim().toLowerCase()) ?? null;
    }
    if (hit) ids.push(hit.id); else unknown.push(String(v));
  }
  return { ids, unknown };
}
```

and the route (before the 404):

```js
      if (req.method === 'POST' && p === '/api/recommend/preview') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const held = resolveChampionIds([body.held], champIndex);
        const bench = resolveChampionIds(body.bench ?? [], champIndex);
        const allies = resolveChampionIds(body.allies ?? [], champIndex);
        const enemies = resolveChampionIds(body.enemies ?? [], champIndex);
        const unknown = [...held.unknown, ...bench.unknown, ...allies.unknown, ...enemies.unknown].filter((u) => u !== 'undefined' && u !== 'null');
        if (unknown.length) return send(res, 400, { error: `unknown champions: ${unknown.join(', ')}` });
        if (held.ids.length !== 1) return send(res, 400, { error: 'held champion required' });
        let result;
        try { result = await state.previewRecommend({ held: held.ids[0], bench: bench.ids, allies: allies.ids, enemies: enemies.ids }); }
        catch (e) { return send(res, /not configured/.test(e.message) ? 503 : 502, { error: e.message }); }
        return send(res, 200, result);
      }
```

Run → PASS.

- [ ] **Step 3: Config flag (test first)**

Append to `test/config.test.js`:

```js
test('rec-debug flag and env', () => {
  assert.equal(loadConfig({}).recDebug, false);
  assert.equal(loadConfig({ argv: ['--rec-debug'] }).recDebug, true);
  assert.equal(loadConfig({ env: { REC_DEBUG: 'true' } }).recDebug, true);
  assert.equal(loadConfig({ env: { REC_DEBUG: 'false' } }).recDebug, false);
});
```

Run → FAIL. Add `recDebug: false` to `DEFAULTS` and, after the `ocr-debug` block in `loadConfig`:

```js
  const rec = pick('rec-debug', 'REC_DEBUG');
  if (rec !== undefined) c.recDebug = bool(rec);
```

Run → PASS.

- [ ] **Step 4: Wire `src/main.js`**

Add imports:

```js
import { createCdragonChampions } from './data/cdragon/champion.js';
import { createRecommender } from './server/recommend.js';
```

After `const repository = createRepository(...)` and before `createAppState`:

```js
  const cdragonChampions = createCdragonChampions({ cache, log });
  const readJson = async (file, fallback) => {
    try { return JSON.parse(await fs.readFile(path.join(here, '..', 'data', file), 'utf8')); }
    catch (e) { log(`WARN ${file} not loaded: ${e.message}`); return fallback; }
  };
  const recommender = createRecommender({
    repository, aramkit, cdragonChampions, cdragon, champIndex,
    overrides: await readJson('profile-overrides.json', {}), synergyRules: await readJson('synergy-rules.json', []),
    debugDir: path.join('data', 'debug'), autoDump: cfg.recDebug, fs, path, log,
  });
  const state = createAppState({ repository, recommender, log });
  log(`recommend: enabled debug=${cfg.recDebug}`);
```

(Remove the older `const state = createAppState({ repository, log });` line.)

- [ ] **Step 5: Smoke run + commit**

Run: `npm test` → all pass. Run: `node src/main.js --port 3790` for ~10 s in another shell, then:

```powershell
curl.exe -s -X POST localhost:3790/api/recommend/preview -H "content-type: application/json" -d "{\"held\":\"Yasuo\",\"bench\":[\"Lux\",\"Malphite\"],\"allies\":[\"Annie\",\"Wukong\",\"Morgana\",\"Ahri\"],\"enemies\":[]}"
```

Expected: 200 JSON with three candidates and `build.context: "allies"`. Stop the server.

```bash
git add src/server/http.js src/config.js src/main.js test/server/http.test.js test/config.test.js
git commit -m "feat(server): recommend preview endpoint, rec-debug flag, main wiring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Champ-select panel (UI)

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`

No unit tests (static front end); verified by the preview endpoint and the manual checklist in Task 11.

- [ ] **Step 1: Markup**

In `public/index.html`, inside the `.row.controls` div before `<div class="spacer"></div>` add:

```html
      <button id="lineup-btn" title="Try a lineup without a game">Lineup…</button>
```

After `</header>` and before `<section id="offer" hidden>` add:

```html
  <form id="lineup-form" hidden autocomplete="off">
    <label>Held <input name="held" placeholder="Yasuo"></label>
    <label>Bench <input name="bench" placeholder="Lux, Malphite"></label>
    <label>Allies <input name="allies" placeholder="Annie, Wukong, Morgana, Ahri"></label>
    <label>Enemies <input name="enemies" placeholder="(leave empty for champ select)"></label>
    <button type="submit">Rank</button>
    <button type="button" id="lineup-close">Close</button>
  </form>
  <section id="recommend" hidden>
    <div class="rec-head">
      <div id="rec-title">Champ select</div>
      <div id="rec-meta" class="muted"></div>
      <div class="spacer"></div>
      <button id="rec-hide">Hide</button>
    </div>
    <div id="rec-team" class="rec-team"></div>
    <div id="rec-warnings" class="muted" hidden></div>
    <div id="rec-cards" class="rec-cards"></div>
  </section>
```

- [ ] **Step 2: Rendering in `public/app.js`**

Add state near the top:

```js
let recPreview = null;      // result of POST /api/recommend/preview when the user tries a lineup
let recHiddenRev = null;    // rev the user hid
const TRAIT_NAMES = { frontline: 'Frontline', engage: 'Engage', peel: 'Peel', sustain: 'Sustain', cc: 'CC', poke: 'Poke' };
const COVERAGE_OK = 0.6;
```

Add a renderer:

```js
function renderRecommend(r, g) {
  const el = $('#recommend');
  const show = r && (recPreview || g.phase === 'champselect') && recHiddenRev !== (r.rev ?? 'preview');
  el.hidden = !show;
  if (!show) return;
  const top = r.candidates[0];
  $('#rec-title').textContent = recPreview ? 'Lineup preview' : 'Champ select';
  $('#rec-meta').textContent = `${r.team.knownAllies}/4 allies known${top ? ` · confidence ${top.confidence}` : ''}${recPreview ? ' · Preview' : ''}`;
  const cov = r.team.coverage ?? {};
  const ad = Math.round((r.team.physicalShare ?? 0.5) * 100);
  $('#rec-team').innerHTML = Object.entries(TRAIT_NAMES).map(([k, label]) => `<span class="trait ${(cov[k] ?? 0) >= COVERAGE_OK ? 'ok' : 'miss'}">${label} ${(cov[k] ?? 0) >= COVERAGE_OK ? '✓' : '✗'}</span>`).join('')
    + `<span class="trait">${ad} % AD / ${100 - ad} % AP</span>`;
  $('#rec-warnings').hidden = !(r.warnings && r.warnings.length);
  $('#rec-warnings').textContent = (r.warnings ?? []).slice(0, 3).join(' · ');
  $('#rec-cards').innerHTML = r.candidates.map((c) => {
    const comp = c.components ?? {};
    const title = `strength ${Math.round((comp.strength ?? 0) * 100)} · fit ${Math.round((comp.fit ?? 0) * 100)} · synergy ${Math.round((comp.synergy ?? 0) * 100)}`;
    return `<div class="rec-card${c.held ? ' held' : ''}">
      ${img(c.icon, 'icon')}
      <div class="body">
        <div class="name">${esc(c.name)} <span class="tier ${esc(c.tier ?? '')}">${esc(c.tier ?? '·')}</span> <span class="muted">${pct(c.winRate)} · ${kfmt(c.games)}</span>
          <span class="chip ${c.held ? 'on' : ''}">${c.held ? 'HELD' : 'bench'}</span> <span class="chip conf-${esc(c.confidence)}">${esc(c.confidence)}</span></div>
        <div class="bar" title="${esc(title)}"><div class="fill" style="width:${c.score}%"></div><span class="num">${c.score}</span></div>
        <div class="reasons">${(c.reasons ?? []).map((t) => `<span class="reason">${esc(t)}</span>`).join('')}</div>
        ${(c.warnings ?? []).length ? `<div class="muted small">${esc(c.warnings.join(' · '))}</div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="muted">No candidates</div>';
}
```

In `render(p, state)` after `renderOcrChip(p.ocr);` add `renderRecommend(recPreview ? recPreview.recommend : p.recommend, p.game);`. Also exclude `recommend.team`-free churn: the render key already covers the payload; no change needed.

Controls (append near the other listeners):

```js
$('#lineup-btn').addEventListener('click', () => { $('#lineup-form').hidden = !$('#lineup-form').hidden; });
$('#lineup-close').addEventListener('click', () => { $('#lineup-form').hidden = true; });
$('#rec-hide').addEventListener('click', () => { const r = recPreview ? recPreview.recommend : JSON.parse(lastRendered || '{}').recommend; recHiddenRev = r ? (r.rev ?? 'preview') : null; if (recPreview) recPreview = null; lastRendered = ''; lastRenderKey = ''; tick(); });
$('#lineup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const list = (k) => String(f.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    recPreview = await api('/api/recommend/preview', { method: 'POST', body: JSON.stringify({ held: String(f.get('held') ?? '').trim(), bench: list('bench'), allies: list('allies'), enemies: list('enemies') }) });
    recHiddenRev = null; $('#lineup-form').hidden = true; lastRendered = ''; lastRenderKey = ''; tick();
  } catch (err) { setBanner(err.message); }
});
```

In `tick()`, when a new live champion appears (`liveId !== lastLiveChampionId`), also set `recPreview = null` and `recHiddenRev = null`. When `recPreview` is set, the build column should show the preview build: in `render`, use `const build = recPreview ? recPreview.build : p.build;` and pass it to `renderBuild` (Task 10 updates `renderBuild`).

- [ ] **Step 3: Styles (append to `public/style.css`)**

```css
#lineup-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; padding: 10px 14px; background: var(--panel2); border-bottom: 1px solid #2c343f; }
#lineup-form[hidden] { display: none; }
#lineup-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
#recommend { padding: 12px 14px; }
#recommend[hidden] { display: none; }
.rec-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
#rec-title { font-size: 20px; font-weight: 700; }
.rec-team { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.trait { font-size: 13px; padding: 2px 8px; border-radius: 10px; background: #2c343f; color: var(--muted); }
.trait.ok { color: var(--good); } .trait.miss { color: var(--bad); }
.rec-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 10px; }
.rec-card { display: grid; grid-template-columns: 56px 1fr; gap: 10px; background: var(--panel); border-radius: 10px; padding: 10px; border: 2px solid transparent; }
.rec-card.held { border-color: #2f5cff; }
.rec-card img.icon { width: 56px; height: 56px; border-radius: 8px; }
.rec-card .name { font-weight: 700; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rec-card .bar { position: relative; height: 18px; background: #2c343f; border-radius: 6px; margin: 6px 0; overflow: hidden; }
.rec-card .fill { height: 100%; background: linear-gradient(90deg, #2f5cff, #4fd18b); }
.rec-card .num { position: absolute; right: 8px; top: 0; font-size: 13px; font-weight: 700; line-height: 18px; }
.reasons { display: flex; gap: 6px; flex-wrap: wrap; }
.reason { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--panel2); }
.small { font-size: 12px; }
.chip.conf-high { color: var(--good); } .chip.conf-medium { color: var(--warn); } .chip.conf-low { color: var(--bad); }
```

- [ ] **Step 4: Verify in the browser**

Run `node src/main.js --open`, click **Lineup…**, enter Held `Yasuo`, Bench `Lux, Malphite`, Allies `Annie, Wukong, Morgana, Ahri`, submit. Expected: panel titled "Lineup preview" with three cards sorted by score, HELD on Yasuo, trait strip, reasons. Hide works; Lineup… again re-opens the form.

- [ ] **Step 5: Commit**

```bash
git add public
git commit -m "feat(ui): champ-select recommendation panel with lineup preview form

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Build column context (UI)

**Files:**
- Modify: `public/app.js` (`renderBuild`)
- Modify: `public/style.css`

- [ ] **Step 1: Extend `renderBuild`**

Replace `renderBuild` with:

```js
function renderBuild(b) {
  if (!b) return '<div class="muted">–</div>';
  const p = b.primary;
  const ctx = b.context === 'both' ? '<span class="chip on">Full matchup</span>' : b.context === 'allies' ? '<span class="chip">Allies only</span>' : '';
  const swap = p.contextReason ? `<div class="swap">${esc(p.name)} chosen · ${p.contextDelta >= 0 ? '+' : ''}${p.contextDelta} pp est. · ${esc(p.contextReason)}</div>` : '';
  const alts = b.alternatives.length
    ? `<details class="alts"><summary>Other builds (${b.alternatives.length})</summary>${b.alternatives.map((a) => `<div>${esc(a.name)} · ${pct(a.winRate)} WR · ${pct(a.pickRate, 0)} pick · ${kfmt(a.games)}</div>`).join('')}</details>`
    : '';
  const situational = (b.situational ?? []).length
    ? `<dt>Situational</dt><dd class="items">${b.situational.map((s) => `<span class="item" title="${esc(s.reason)} · ${pct(s.winRate)} WR · pick ${pct(s.pickRate, 0)}">${img(s.item.icon)}${esc(s.item.name)}<span class="why">${esc(s.reason)}</span></span>`).join('')}</dd>`
    : '';
  return `<div><strong>${esc(p.name)}</strong> <span class="muted">${pct(p.winRate)} WR · ${pct(p.pickRate, 0)} pick · ${kfmt(p.games)} games</span> ${ctx}</div>${swap}
  <dl>
    <dt>Start</dt><dd class="items">${itemList(p.starter) || '–'}</dd>
    <dt>Boots</dt><dd class="items">${p.boots ? itemList([p.boots]) : '–'}</dd>
    <dt>Core (route ${pct(p.routeWinRate)} WR)</dt><dd class="items">${itemList(p.core, '›') || '–'}</dd>
    <dt>Later</dt><dd class="items">${itemList(p.later) || '–'}</dd>
    ${situational}
    <dt>Spells</dt><dd>${esc(p.spells.join(' + ')) || '–'}</dd>
    <dt>Skills</dt><dd>${esc(p.skillOrder ?? '–')}</dd>
  </dl>${alts}`;
}
```

- [ ] **Step 2: Styles**

Append to `public/style.css`:

```css
.swap { margin: 4px 0 2px; font-size: 13px; color: var(--warn); }
.item .why { font-size: 11px; color: var(--muted); margin-left: 4px; }
```

- [ ] **Step 3: Verify**

With the server running, submit the lineup form with Enemies `Lux, Malphite, Jinx, Janna, Miss Fortune`. Expected: Build column shows "Full matchup" chip and a Situational row with up to three items and reason text. Submit again with empty Enemies: chip reads "Allies only", no Situational row.

- [ ] **Step 4: Commit**

```bash
git add public
git commit -m "feat(ui): build context chip, archetype swap line and situational items

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: README, smoke checklist, gameplay round

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

Add a section after "Live augment offers (Windows)":

```markdown
## Champ-select recommender and adaptive builds

During ARAM Mayhem champ select the page shows a **Champ select** panel ranking your held
champion and every bench champion for *this* team: 60 % individual Mayhem strength (win rate
shrunk by sample size, percentile among all champions), 30 % composition fit (what the pick adds
in frontline, engage, peel, sustain, crowd control, poke and physical/magic balance), 10 % synergy
(rule-based plus a small curated pair list — no source publishes champion-pair statistics).
Each card shows a 0-100 score (hover for the three components), a confidence chip and two or three
plain-language reasons. Advisory only: nothing is swapped or clicked.

Builds adapt twice: in champ select the archetype may shift by at most 3 win-rate points to cover
an allied gap ("Allies only" chip); once the game runs and enemies are known, a **Situational** row
lists up to three items from your champion's own win-rate table that answer the enemy lineup
("Full matchup" chip). Core items never change.

Trait profiles are derived from CommunityDragon playstyle data and aramkit combat stats; rule
misses are patched in `data/profile-overrides.json` (keyed by riot id, traits 0..1). Curated pairs
live in `data/synergy-rules.json`. Weights and caps: `src/rank/weights.js`.

Try a lineup without a game: **Lineup…** in the header, or

```powershell
curl.exe -s -X POST localhost:3777/api/recommend/preview -H "content-type: application/json" -d "{\"held\":\"Yasuo\",\"bench\":[\"Lux\",\"Malphite\"],\"allies\":[\"Annie\",\"Wukong\",\"Morgana\",\"Ahri\"],\"enemies\":[]}"
```

Tuning: run one game with `node src/main.js --rec-debug` (or `REC_DEBUG=true`); every recompute is
saved as `data/debug/recommend-<ts>.json` (newest 50) with the lineup, profiles and scores. Capture
a real champ-select session for fixtures with `node scripts/lcu-dump.js` during champ select.
```

- [ ] **Step 2: Extend the manual smoke checklist**

Under "## Manual smoke checklist" add:

```markdown
- Champ select: panel appears within one poll of entering champ select; held card marked HELD; a
  bench swap reorders the cards; Hide dismisses until the lineup changes.
- Loading screen: panel gone, build keeps the "Allies only" chip.
- In game: build shows "Full matchup" and a Situational row with reasons; augment list unchanged.
- Lineup… form: unknown names produce a banner error; a valid lineup renders a "Lineup preview"
  panel and preview build; Live/new game clears it.
```

- [ ] **Step 3: Full suite, commit**

Run: `npm test` → all pass.

```bash
git add README.md
git commit -m "docs: champ-select recommender, adaptive builds, tuning workflow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Gameplay round (user)**

Play one ARAM Mayhem game with `node src/main.js --rec-debug`, run `node scripts/lcu-dump.js` during champ select. Afterwards:
1. Copy the champ-select dump's `champSelect.body` over `test/fixtures/lcu/champ-select-session.json` (trim to `localPlayerCellId`, `benchChampions`, `myTeam`), update ids in the Task 1 tests if they differ, commit as `test(lcu): real champ-select session fixture`.
2. Read `data/debug/recommend-*.json`; for champions whose traits look wrong, add entries to `data/profile-overrides.json`; commit as `data: profile overrides from first gameplay round`.

---

## Self-review

- **Spec coverage**: §6.1 → Task 1; §6.2 → Tasks 2-3 (+ override/synergy files in Tasks 4-5); §6.3 → Task 4; §6.4 → Task 5; §6.5 → Task 6; §6.6 → Task 7; §6.7 → Task 8; §6.8 → Tasks 9-10; §7 config → Tasks 5 (weights) and 8 (`--rec-debug`); §8 error handling → Tasks 5, 7, 8; §9 testing → every task; §10 milestones map 1:1; §11 risks → Task 11 Step 4 tuning loop. `bracket` change recompute → Task 7 Step 5.
- **Placeholders**: none; every code step has code. `best()` in Task 6 is marked unchanged on purpose (existing function kept verbatim).
- **Type consistency**: `Profile` fields (`style`, `burst`, `roles`, `riotId`, `sources`, `warnings`) are produced in Task 4 and consumed identically in Tasks 5, 6, 7. `rankings.byId[id].games` (Task 2) matches `strengthPercentile`/`rankCandidates` (Task 5). `champData.items` (Task 2) matches `situationalItems` (Task 6). `compute()` result shape (Task 7) matches the state slice and the `fakeRecommender` in the state tests. `previewRecommend` result shape matches the http test fake and the UI (`recPreview.recommend`, `recPreview.build`).
