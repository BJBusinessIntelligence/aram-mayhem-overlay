# Automatic Summoner Spell + Item Set Import — Design Spec

Date: 2026-10-03
Status: draft for review
Builds on: `2026-10-02-champ-recommender-adaptive-builds-design.md` (merged; opening-pick support added 2026-10-03)

## 1. Goal

Whenever the champion I hold changes in ARAM Mayhem champ select (hover during the opening pick,
lock, bench swap), the League client's summoner spells are set to the champion's best pair and an
item set for that champion appears in the in-game shop, built from the same context-adjusted build
the overlay shows. Once the game starts and enemies are known, the item set is refreshed once with
the situational items. No clicks required; a header chip and a flag turn it off.

This is the first feature that **writes to the League client**. The earlier "advisory only, never
write to the LCU" rule is superseded for exactly two write operations (summoner spells in champ
select, item sets) and nothing else: no champion picks, swaps, rerolls, chat, or purchases.

## 2. Facts that shape the design

- LCU summoner spells: `PATCH /lol-champ-select/v1/session/my-selection` with
  `{ spell1Id, spell2Id }`; accepted only while in champ select (the opening pick included).
- LCU item sets: `GET /lol-item-sets/v1/item-sets/{summonerId}/sets` returns
  `{ accountId, itemSets: [...], timestamp }`; `PUT` to the same path with the whole object
  replaces the list. An item set is `{ title, type: 'custom', map: 'any', mode: 'any',
  associatedChampions: [id], associatedMaps: [], sortrank, startedFrom: 'blank',
  preferredItemSlots: [], uid, blocks: [{ type, items: [{ id: '3031', count: 1 }],
  hideIfSummonerSpell: '', showIfSummonerSpell: '' }] }`. Item ids are strings. The exact optional
  fields are confirmed on the first live run (see §8); unknown fields from the GET are preserved.
- Summoner id / account id: `GET /lol-summoner/v1/current-summoner` → `{ summonerId, accountId }`.
- aramkit ChampData `summoners[]` rows carry `spellIds` (Flash 4, Mark 32, …); `pickBuild` already
  chooses the best pair by win rate with a 5 % pick floor and returns names only.
- `pickBuild(champData, { context })` returns starter, boots, core, later and situational items
  with numeric ids; ARAM Mayhem items (e.g. 123430 Rite of Ruin) are normal in-store items.
- The held champion during the opening pick is a hover (`game.lineup.held`), not a lock
  (`game.championId`); in champ select after locking both are equal; in game `held` = the played
  champion. ChampData for a hovered champion must be fetched by the importer (the state only loads
  the locked champion).
- Interview decisions: fire on every lineup change in champ select; content = context build +
  situational; on by default with a header toggle and a start flag; every write logged.

## 3. Non-goals

- Changing anything else in the client (picks, swaps, rerolls, runes, skins, chat).
- Multiple item sets per champion or per archetype; one `AMO · <name>` set per champion.
- Deleting item sets the importer did not create; deleting AMO sets of other champions.
- Retrying failed writes on a timer (retry happens on the next fingerprint change only).
- In-game spell changes (the client forbids them).

## 4. Architecture (additions)

```
detector → state.game (phase, championId, lineup.held, lineup.enemies)
state.recommend / buildContext (allies always; enemies once in game)
            │ snapshot() every 1 s
            ▼
src/import/importer.js   fingerprint changed? → champData(held) via repository → pickBuild(context)
            │                                  → planImport() → { spells, itemSet }
            ▼
src/game/lcuWriter.js    PATCH my-selection (champ select only) · GET/PUT item sets (merge one AMO set)
            ▼
state.setImportStatus() → payload.import → header chip; POST /api/import { enabled }
```

Mirrors the OCR watcher: a loop with `start()`, `stop()`, `setEnabled()`, status pushed into the app
state, wired in `src/main.js`. The planner is pure; the writer is the only module with LCU writes.

## 5. Data model

```js
// pickBuild output — addition
build.primary.spellIds: [4, 32]            // alongside the existing spells: ['Flash', 'Mark']

// planner output
{
  spells: { ids: [4, 32], names: ['Flash', 'Mark'] } | null,
  itemSet: { title: 'AMO · Yasuo', type: 'custom', map: 'any', mode: 'any', associatedChampions: [157],
             associatedMaps: [], sortrank: 0, startedFrom: 'blank', preferredItemSlots: [], uid: 'amo-157',
             blocks: [{ type: 'Start', items: [{ id: '1038', count: 1 }, { id: '2003', count: 1 }], hideIfSummonerSpell: '', showIfSummonerSpell: '' },
                      { type: 'Boots', … }, { type: 'Core (in order)', … }, { type: 'Later', … },
                      { type: 'Situational vs 5 enemies', … }] } | null,
}

// payload.import (state)
import: { enabled: true, running: true, lastChampion: 'Yasuo', lastSpells: 'Flash + Mark',
          lastItemSetAt: 1790990000000, lastError: null }
```

## 6. Components

### 6.1 `src/rank/builds.js` — spell ids
`pickBuild` adds `primary.spellIds` (the chosen summoner row's `spellIds`, `[]` when none).

### 6.2 `src/import/plan.js` (pure)
`planImport({ champ, build, enemiesKnown })`:
- `spells`: `build.primary.spellIds` when it has two ids, else `null`.
- Blocks, each included only when it has items, ids as strings, duplicates removed within a block:
  `Start` = starter items + Health Potion (2003); `Boots`; `Core (in order)` = core;
  `Later` = later; `Situational vs <n> enemies` = situational items, only when `enemiesKnown`.
- `itemSet` is `null` when there is no primary archetype.
- `title` = `AMO · ${champ.name}`, `uid` = `amo-${champ.id}`, `associatedChampions` = `[champ.id]`.
- `fingerprint(plan, phase)` = `${phase}|${spells ids}|${blocks: type:ids}` — a string used by the
  importer to detect change.

### 6.3 `src/game/lcuWriter.js`
`createLcuWriter({ readLockfile, getJson, sendJson, log })`:
- `summoner()` → `{ summonerId, accountId }` cached per lockfile port.
- `setSpells(ids)` → `PATCH /lol-champ-select/v1/session/my-selection`; resolves `{ ok, status }`.
- `upsertItemSet(itemSet)` → GET sets, replace the set whose `title === itemSet.title` (or `uid`
  equal) else append; keep every other set untouched; `PUT` `{ ...getBody, itemSets, timestamp: now }`.
- Every call returns `{ ok: boolean, status, error? }`, never throws; non-2xx → `ok: false`.
- `src/util/httpsJson.js` gains `httpsSendJson(url, { method, body, headers, … })` (PATCH/PUT with a
  JSON body), same TLS/timeout handling as `httpsGetJson`.

### 6.4 `src/import/importer.js`
`createImporter({ state, repository, writer, setTimer, clearTimer, intervalMs = 1000, now, log })`:
- `tick()`: read `state.snapshot()`; if disabled, or `game.phase` not champselect/ingame, or no
  `lineup.held` → idle. Else get ChampData for `held` (repository, bracket from `view`), compute
  `pickBuild(data, { context: state.getBuildContext() })`, `planImport`, `fingerprint`.
  Unchanged fingerprint → nothing. Changed → in champselect: `setSpells` (when spells present) then
  `upsertItemSet`; in game: `upsertItemSet` only. Update status after each write; log one line per
  write (`[import] spells Flash + Mark for Yasuo`, `[import] item set AMO · Yasuo (4 blocks)`) or
  failure (`[import] spells failed: 404`). Remember the fingerprint only when all writes succeeded,
  so a failure retries on the next change.
- `state.getBuildContext()` is added to the app state (returns the stored `buildContext`).
- `start()/stop()/setEnabled()/getStatus()` as in the OCR watcher; `setEnabled(false)` clears the
  remembered fingerprint so re-enabling re-imports.

### 6.5 App state, HTTP, config, main, UI
- State: `import` slice with `setImportStatus(patch)`, carried in `buildPayload`
  (`import: null` without an importer); `getBuildContext()`.
- HTTP: `POST /api/import { enabled: boolean }` → 400 without a boolean, 503 without an importer.
- Config: `importEnabled` default true; `--import=false` / `IMPORT_ENABLED=false`;
  `--import-debug` / `IMPORT_DEBUG` dumps the raw item-sets GET/PUT bodies to `data/debug/item-sets-<ts>.json`.
- Main: create writer (`readLockfile`, `httpsGetJson`, `httpsSendJson`) and importer; `start()`.
- UI: header chip `#import-chip` next to the OCR chip — "Import on · Yasuo · Flash + Mark",
  "Import off", or "Import: <error>" in red; click toggles via `POST /api/import`.

## 7. Configuration
`IMPORT_ENABLED`, `--import`; `IMPORT_DEBUG`, `--import-debug`; poll interval fixed at 1 s.

## 8. Error handling
- LCU unreachable / not in champ select for spells → `ok: false`, status shows the error, no retry
  loop; next fingerprint change retries.
- Item-set GET failure → skip the PUT (never write without reading first).
- Unknown schema fields: the PUT body is the GET body with only `itemSets` and `timestamp`
  replaced; each foreign set is passed through by reference.
- First live run: with `--import-debug` the raw GET/PUT bodies are saved for inspection; if the
  client rejects the PUT (4xx), the body is in the dump and the shape gets fixed from evidence.

## 9. Testing
- `test/rank/builds.test.js`: `spellIds` on the real fixture (`[4, 32]`).
- `test/import/plan.test.js`: blocks from the real Yasuo build (Start has starter + 2003, Core order,
  Later), situational gating by `enemiesKnown`, string ids, dedup, `null` cases, fingerprint changes
  when ids or phase change and not otherwise.
- `test/game/lcuWriter.test.js`: fake `getJson`/`sendJson` — PATCH body and path, GET→PUT merge
  (foreign sets kept, same-title AMO replaced, other AMO sets kept, append when missing, timestamp
  updated, other GET fields echoed), non-2xx → `ok: false`, lockfile missing → `ok: false`.
- `test/import/importer.test.js`: fake state/repository/writer — fires on held change, idle on
  unchanged snapshot, no spell write in game, refresh when enemies appear, disabled → nothing,
  failure keeps fingerprint unset, re-enable re-imports, status updates.
- `test/server/state.test.js` / `http.test.js` / `config.test.js`: slice, route, flag.
- `test/util/httpsJson.test.js`: `httpsSendJson` sends method + JSON body.
- Manual: next champ select with `--import-debug`; confirm spells flip on hover and the item set
  appears in the shop; README checklist.

## 10. Milestones
1. `spellIds` + planner. 2. `httpsSendJson` + writer. 3. Importer loop. 4. State/HTTP/config/main.
5. UI chip. 6. README + live run with `--import-debug`.

## 11. Open questions / risks
- Item-set body fields beyond `title/type/map/mode/associatedChampions/blocks` are from memory;
  the first live PUT confirms them (debug dump captures the client's own shape from the GET).
- Setting spells on every hover in a 15 s opening pick is a write per hover; the client accepts it
  but the fingerprint keeps it to one write per distinct champion.
- The shop shows item sets by `associatedChampions`; `map: 'any'` is required for the ARAM map (12).
