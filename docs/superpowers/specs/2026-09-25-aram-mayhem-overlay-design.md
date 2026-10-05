# ARAM Mayhem Augment & Build Overlay — Design Spec

Date: 2026-09-25
Status: draft for review
Owner: project maintainer

## 1. Goal

A local tool that, while playing League of Legends ARAM Mayhem, shows on a second-monitor
browser tab:

1. Every augment for the current champion, grouped by rarity (Prismatic / Gold / Silver),
   ranked so the best of the three offered augments is obvious at a glance, with the
   ranking automatically switched to the current augment stage (levels 3 / 7 / 11 / 15).
2. One clear high-win-rate build: starters, boots, core three items in order, later items,
   summoner spells, skill order.

Champion is detected automatically. Offered augments are **not** detected (Live Client Data
never exposes them; only OCR can, and that is out of scope).

## 2. Non-goals (v1)

- OCR / screen capture of the augment cards.
- Always-on-top game overlay window. Deliverable is a normal browser tab.
- Tracking augments already taken.
- Augment pair/trio synergies.
- Team / enemy champion data.
- Any write to the League client. Everything is read-only.
- Localization. English only.

## 3. Decisions made in interview

| Topic | Decision |
|---|---|
| Detection | Champion only, automatic. LCU during champ select, Live Client Data in game. |
| Data | aramkit static JSON primary, aramgg official API fallback. Both behind one adapter interface. |
| Stage | Auto-switch to current stage from player level; manual tabs All / 1 / 2 / 3 / 4. |
| Bracket | Default `all`; header toggle to `high` (high-MMR). |
| Ranking | Source tier (S…D) then win rate. Show WR, lift vs global augment WR, games. Dim rows under 200 games. |
| Build | Top archetype by WR with pick ≥ 5 %, full route. Other archetypes collapsed. |
| Runtime | Node 24, no framework. `cheerio` not needed (JSON only). Zero runtime deps target. |
| Tests | `node:test` + `node:assert`, TDD. |
| UI | Static HTML/CSS/JS served by the same process, dark theme, large text. |

## 4. Architecture

```
aram-mayhem-overlay/
  package.json                 "type": "module", scripts: start, test
  start.cmd                    node src/main.js && start http://localhost:3777
  src/
    main.js                    wires everything, starts poll loop + http server
    config.js                  env/CLI → {port, bracket, cacheDir, pollMs, sources, aramggKey}
    game/
      lockfile.js              parse LCU lockfile → {port, password}
      lcu.js                   LCU client: gameflow phase, session (queue), champ-select champ
      liveclient.js            Live Client Data: active player champion + level
      detector.js              merges LCU + LiveClient into GameState (pure reducer + poller)
    data/
      model.js                 ChampData type doc + validators + stage helpers
      adapter.js               DataSource interface + resolveChampion helpers
      aramkit/
        client.js              URL builders + fetch (versions, resources, champion-details)
        normalize.js           raw aramkit JSON → ChampData (pure)
      aramgg/
        client.js              URL builders + fetch with API key
        normalize.js           raw aramgg JSON → ChampData (pure)
      champions.js             ChampionIndex: numericId ⇄ riotId ⇄ name (from aramkit resources)
      cache.js                 disk cache with TTL, keyed by source/version/bracket/champ
      repository.js            "give me ChampData for champ X, bracket B" — cache → primary → fallback
    server/
      http.js                  static files + /api/* routes
      state.js                 AppState store: current GameState + ChampData + errors
    rank/
      augments.js              rank/tier/stage selection + row shaping for UI (pure)
      builds.js                pick top archetype, flatten route (pure)
  public/
    index.html  app.js  style.css
  test/
    fixtures/                  real JSON captured 2026-09-25 (aramkit) + hand-written LCU/Live samples
    **/*.test.js
  data/cache/                  gitignored
```

Dependency direction: `server` → `state` ← `detector`, `repository`. `rank/*` and `*/normalize.js`
are pure functions with no I/O. All I/O modules take `fetch`, `fs`, and `now` as injected
parameters with defaults, so tests never touch the network or the real clock.

## 5. Domain model

### 5.1 `ChampData` (normalized, source-agnostic)

```js
{
  source: 'aramkit' | 'aramgg',
  sourceVersion: '16.19',          // data version string from source
  dataDate: '2026-09-24',
  fetchedAt: 1790000000000,        // ms epoch
  bracket: 'all' | 'high',
  champion: {
    id: 157, riotId: 'Yasuo', name: 'Yasuo', tier: 'S', rank: 1,
    winRate: 0.5764, pickRate: 0.1083, games: 804398
  },
  augments: {
    all:    AugmentRow[],
    stages: { 1: AugmentRow[], 2: AugmentRow[], 3: AugmentRow[], 4: AugmentRow[] } // may be empty per source
  },
  build: {
    archetypes: Archetype[]        // sorted by winRate desc after pick filter, see rank/builds.js
  },
  summoners: [{ spellIds: [4, 32], names: ['Flash', 'Mark'], winRate, pickRate, games }],
  skills:    [{ order: 'E>Q>W', winRate, pickRate, games }]
}

AugmentRow = {
  id: 1058, name: 'Mystic Punch', rarity: 'prismatic' | 'gold' | 'silver',
  tier: 'S' | 'A' | 'B' | 'C' | 'D' | null,   // source tier for this champ
  rank: 1,                                     // source rank for this champ
  winRate: 0.6517, pickRate: 0.1477, games: 112923,
  globalWinRate: 0.5128,                       // augment WR across all champs (null if unknown)
  icon: 'https://data.aramkit.com/assets/augment/1058-....webp' | null
}

Archetype = {
  key: 'crit', name: 'Crit', winRate, pickRate, games,
  starters: [{ items: Item[], winRate, pickRate, games }],   // sorted by pickRate desc
  boots:    [{ item: Item,    winRate, pickRate, games }],
  core:     Item[],                                            // purchase order of the top route
  later:    [{ item: Item,    winRate, pickRate, games }],    // top 6 by pickRate
  routeWinRate, routePickRate, routeGames
}

Item = { id: 3032, name: 'Yun Tal Wildarrows', icon: 'https://...' | null }
```

Rates are 0–1 decimals everywhere. UI formats to percent.

### 5.2 `GameState`

```js
{
  phase: 'none' | 'champselect' | 'loading' | 'ingame',
  queueId: 2400 | 2450 | number | null,       // from LCU gameflow session
  championId: 157 | null,                     // numeric Riot id
  riotId: 'Yasuo' | null,
  level: 7 | null,                            // Live Client activePlayer.level
  stage: 1 | 2 | 3 | 4 | null,                // derived from level
  gameMode: 'ARAM' | string | null,           // Live Client gameStats.gameMode (informational)
  lcuConnected: boolean,
  liveConnected: boolean,
  updatedAt: ms
}
```

Stage from level: `< 7 → 1`, `7–10 → 2`, `11–14 → 3`, `≥ 15 → 4`. Null when level unknown.

## 6. Game detection

### 6.1 LCU (`game/lockfile.js`, `game/lcu.js`)

- Lockfile: `C:\Riot Games\League of Legends\lockfile` (configurable). Format
  `LeagueClient:PID:PORT:PASSWORD:PROTOCOL`. Missing file = client not running (not an error).
- Requests: `https://127.0.0.1:{port}{path}`, header `Authorization: Basic base64("riot:" + password)`,
  TLS via a dedicated `https.Agent({ rejectUnauthorized: false })` scoped to this client only.
- Endpoints used:
  - `GET /lol-gameflow/v1/gameflow-phase` → JSON string: `None | Lobby | Matchmaking | ChampSelect | InProgress | Reconnect | EndOfGame | ...`
  - `GET /lol-gameflow/v1/session` → `gameData.queue.id`
  - `GET /lol-champ-select/v1/session` → `localPlayerCellId`, `myTeam[{cellId, championId}]`
- `lcu.snapshot()` returns `{ connected, phase, queueId, championId }` and never throws;
  connection errors yield `{ connected: false }`.

### 6.2 Live Client Data (`game/liveclient.js`)

- `GET https://127.0.0.1:2999/liveclientdata/allgamedata`, same scoped insecure agent.
- Active player: match `activePlayer.riotId` against `allPlayers[].riotId`
  (fallback `summonerName`). Take `rawChampionName`, strip prefix
  `game_character_displayname_` → `riotId` (e.g. `MonkeyKing`). `activePlayer.level` → level.
  `gameData.gameMode` → gameMode.
- `liveclient.snapshot()` returns `{ connected, riotId, level, gameMode }`, never throws.

### 6.3 Detector (`game/detector.js`)

Pure reducer `reduce(prev, lcuSnap, liveSnap, champIndex, now) → GameState`:

- `liveSnap.connected` wins: phase `ingame`, championId via `champIndex.byRiotId(riotId)`.
- Else if `lcuSnap.phase === 'ChampSelect'` and a championId is picked (≠ 0): phase `champselect`.
- Else if `lcuSnap.phase` is `InProgress`/`Reconnect` without Live Client yet: phase `loading`,
  keep previous championId.
- Else phase `none`; championId retained from prev (so the page keeps showing the last champ)
  but `level`/`stage` cleared.
- queueId from LCU when available, else kept from prev while phase ≠ none.

Poller: every `pollMs` (default 2000) call both snapshots in parallel, reduce, publish to
`AppState` if changed (deep-equal on the relevant fields).

## 7. Data sources

### 7.1 Adapter interface (`data/adapter.js`)

```js
{
  name: 'aramkit',
  async latestVersion()                       // → { version, dataDate, ...opaque }
  async champion(championId, bracket)         // → ChampData (already normalized)
  supportsBracket(bracket)                    // aramgg: only 'all'
  supportsStages()                            // aramgg: false
}
```

### 7.2 aramkit (primary) — `data/aramkit/*`

Base `https://data.aramkit.com`. All GET, no auth. Send a descriptive `User-Agent`.

| Purpose | URL |
|---|---|
| versions | `/data/versions.json` → `{latest, versions:[{version, dataPath, resourcePath, dataDate}]}` |
| champion detail | `/{dataPath}/stats/{all\|high}/champion-details/{id}.json` |
| champions | `/{resourcePath}/en-US/resources/champions.json` (keyed by numeric id: `{slug, riotId, name, roles, icon}`) |
| augments | `/{resourcePath}/en-US/resources/augments.json` (keyed by id: `{slug, name, rarity, icon}`) |
| items | `/{resourcePath}/en-US/resources/items.json` (keyed by id: `{name, icon, ...}`) |
| spells | `/{resourcePath}/en-US/resources/summoner-spells.json` (keyed by id: `{name, icon}`) |
| archetypes | `/{resourcePath}/en-US/resources/archetypes.json` (`{crit:{name:'Crit'}, ...}`) |

Icons: `https://data.aramkit.com/` + icon path.

`normalize(raw, resources, meta)` mapping:

- `champion` ← `raw.champion.{id, rank, tier, stats.winRate, stats.pickRate, stats.sampleCount}`
- `augments.all[i]` ← `raw.augments.all[i]` (`sampleCount → games`, `augmentWinRate → globalWinRate`),
  name/rarity/icon joined from augments resource. Unknown id → row kept with name `#<id>`, rarity `unknown`.
- `augments.stages[s]` ← `raw.augments.stages[s]` same shape.
- `build.archetypes` ← `raw.builds.filtered.archetypes[]`: for each, take `profiles[0].routes[0]`
  as the route; `core ← route.purchaseOrder`, `starters ← route.starters`, `boots ← route.boots`
  (drop `item.id === 0` "No Boots"), `later ← route.laterItems` top 6 by pickRate.
  Items joined from items resource.
- `summoners` ← `raw.summoners` with names from spells resource.
- `skills` ← `raw.skills`.

Rate limiting: one in-flight request per URL, minimum 500 ms between requests to
`data.aramkit.com`, resources fetched once per `resourcePath` and cached to disk.

### 7.3 aramgg (fallback) — `data/aramgg/*`

Base `https://data.dtodo.cn/api/v1/en`. Header `x-api-key: <key>` from `ARAMGG_API_KEY`.
Disabled (adapter reports `enabled: false`) when key missing.

| Purpose | URL | Credits |
|---|---|---|
| config | `/config.json` | 0 |
| champion detail | `/champions/{id}.json` | 2 |
| augments (names, rarity, global stats) | `/augments.json` | 1, cached per `dataVersion` |
| items | `/items.json` | 1, cached per `dataVersion` |
| spells | `/summoner-spells.json` | 1, cached per `dataVersion` |

Champion ids are the same Riot numeric ids. Docs saved at `docs/aramgg-api-docs.md`.
Normalizer notes: per-champ augment `winRate` may be `null` (under 255 games) → keep row, `games` 0,
tier null, sort by their `rank`. No stages → `augments.stages = {}`. Builds: `data.builds[0]`
→ single archetype `key: 'default'`, `core ← coreItems`, `starters ← startingItems`,
`later ← situationalItems`, spells and skills from the same build record. Exact field names
are verified against a real response once a key exists; until then the aramgg normalizer is
built against a hand-written fixture derived from the docs and marked as such.

### 7.4 Champion index (`data/champions.js`)

Built from aramkit `champions.json`. Lookups: `byId(157)`, `byRiotId('MonkeyKing')`
(case-insensitive), `search('yas')` (prefix on name and riotId, for the UI search box).
Persisted with resources cache; if aramkit is unreachable and no cache exists, the app starts
with an empty index and reports it in `/api/state.errors`.

### 7.5 Repository (`data/repository.js`)

`getChamp(championId, bracket)`:

1. Cache hit and fresh → return.
2. Primary adapter (aramkit): fetch → normalize → cache → return.
3. On any primary failure (network, HTTP ≠ 200, invalid JSON, normalize throws or yields
   zero augments) → fallback adapter if enabled and `supportsBracket(bracket)`
   (aramgg only `all`; a `high` request falls back to `all` and the result is flagged
   `bracket: 'all'`).
4. If everything fails and a stale cache entry exists → return it with `stale: true`.
5. Else throw `DataUnavailable` with both errors attached.

Only one fetch per `(source, championId, bracket)` in flight; concurrent callers share it.

### 7.6 Cache (`data/cache.js`)

- Path: `data/cache/{source}/{version}/{bracket}/champ-{id}.json` and
  `data/cache/{source}/{version}/resources-{name}.json`.
- Freshness: `fetchedAt` within TTL (default 24 h). Version check (`versions.json` /
  `config.json`) at most every 6 h; a new version invalidates nothing on disk but changes the
  path, so old versions simply stop being read. Prune directories not matching the current
  version on startup.
- All reads/writes wrapped; a corrupt file is treated as a miss and deleted.

## 8. Ranking & shaping (`rank/*`, pure)

### 8.1 Augments

`shapeAugments(champData, { stage, bracket, minGames = 200 })`:

- Source rows: `augments.stages[stage]` if stage and non-empty, else `augments.all`.
  Response carries `stageUsed: 1..4 | 'all'`.
- Per row compute `lift = winRate - globalWinRate` (how much better this augment does on this
  champion than across all champions; `null` when `globalWinRate` is null) and
  `lowSample = games < minGames`. The champion's own baseline WR is shown once in the header.
- Group by rarity. Within group sort by: tier order S>A>B>C>D>null, then winRate desc,
  then games desc. Rows with `lowSample` sort after all non-low rows regardless of tier.
- Output `{ stageUsed, columns: { prismatic: Row[], gold: Row[], silver: Row[] }, unknown: Row[] }`.

### 8.2 Build

`pickBuild(champData, { minPick = 0.05 })`:

- Candidates = archetypes with `pickRate ≥ minPick`; if none, all archetypes.
- Primary = max winRate among candidates. Others returned as `alternatives` (key, name,
  winRate, pickRate, games) for the collapsed list.
- Primary flattened to `{ starter: Item[], boots: Item, core: Item[], later: Item[6],
  spells: names[2], skillOrder: 'E>Q>W' }` using the top-pickRate starter and boots, top
  summoner spell set and skill order by winRate with pick ≥ 5 %.

## 9. Server (`server/*`)

Plain `node:http`, port from config (default 3777), binds 127.0.0.1 only.

| Route | Response |
|---|---|
| `GET /` and `/app.js`, `/style.css` | static from `public/` |
| `GET /api/state` | `{ game: GameState, loading: boolean, champ: ChampSummary\|null, view: { stage, bracket }, augments: shaped\|null, build: shaped\|null, meta: { source, version, dataDate, fetchedAt, stale }\|null, errors: [{ scope, message, at }] }` |
| `GET /api/champ/:id?bracket=all&stage=2&force=1` | same payload for an arbitrary champion (search box, testing). `force=1` bypasses cache. |
| `GET /api/champions?q=ya` | `[{ id, name, riotId }]` from the index |
| `POST /api/view` body `{ stage?: 'auto'\|1..4, bracket?: 'all'\|'high' }` | updates view prefs held in `AppState`; returns `/api/state` payload |

`AppState` holds: latest `GameState`, current `ChampData` (per bracket), view prefs
(`stage: 'auto'`, `bracket: 'all'`), last 10 errors. When `GameState.championId` changes or
bracket changes, it asks the repository for data (async, non-blocking; state reports
`loading: true` meanwhile).

## 10. UI (`public/`)

Single page, dark theme, minimum 16 px body text, designed for a 1080p secondary monitor.
Polls `/api/state` every 2 s; re-renders only when the JSON string changes.

Layout:

```
┌─ Header ───────────────────────────────────────────────────────────────┐
│ [icon] Yasuo  S  57.6% WR  804k games   | ARAM Mayhem (2400) | lvl 7   │
│ Stage: [Auto: 2] [All] [1] [2] [3] [4]   Bracket: [All] [High]   [↻]   │
│ aramkit 16.19 · data 2026-09-24 · fetched 3h ago        [search champ] │
├─ Prismatic ───┬─ Gold ────────┬─ Silver ──────┬─ Build ────────────────┤
│ S Mystic Punch│ ...           │ ...           │ Crit  60.1% WR  60% pk │
│   65.2% +7.5  │               │               │ Start: Rite+Boots      │
│   113k games  │               │               │ Boots: Berserker's     │
│ A ...         │               │               │ Core: Rite › BotRK › DD│
│ (dimmed low)  │               │               │ Later: IE, PD, ...     │
│               │               │               │ Spells: Flash + Mark   │
│               │               │               │ Skills: E>Q>W          │
│               │               │               │ ▸ other builds (3)     │
└───────────────┴───────────────┴───────────────┴────────────────────────┘
```

- Augment row: tier badge (color per tier), name, WR, lift (`+7.5` green / `-2.1` red),
  games. `lowSample` rows at 45 % opacity. Rarity column header colored (prismatic cyan,
  gold amber, silver grey).
- No game: header says "Not in game — showing last champion" or "Waiting for League…".
  Search box always works.
- Errors: red banner with last error message; stale data gets a yellow "stale" chip.
- Icons: `<img>` from source CDN, `loading="lazy"`, broken image hidden via `onerror`.
  A `?noicons=1` query disables them.

## 11. Configuration (`config.js`)

Env vars (CLI flags `--port` etc. override):

| Var | Default |
|---|---|
| `PORT` | 3777 |
| `POLL_MS` | 2000 |
| `CACHE_DIR` | `./data/cache` |
| `CACHE_TTL_H` | 24 |
| `LOL_LOCKFILE` | `C:\Riot Games\League of Legends\lockfile` |
| `ARAMGG_API_KEY` | unset (fallback disabled) |
| `PRIMARY_SOURCE` | `aramkit` (`aramgg` allowed to swap roles) |

## 12. Error handling

- Every I/O module returns a result or a typed error; nothing unhandled reaches the poll loop.
  The loop logs once per distinct message and pushes to `AppState.errors`.
- LCU/Live Client unreachable: silent (expected most of the time). Logged at debug only.
- HTTP 429 from aramgg: adapter marks itself cooling down for 1 h.
- Normalizer yields zero augments: treated as source failure; raw JSON written to
  `data/debug/{source}-{id}-{timestamp}.json` for inspection.
- Unknown champion riotId: `GameState.championId = null`, error `unknown champion "X"`.

## 13. Testing strategy (TDD)

Every module gets its test file first. `npm test` = `node --test test/`.

| Module | Test approach |
|---|---|
| `game/lockfile.js` | parse valid / malformed / missing file (fs injected) |
| `game/lcu.js` | fake fetch returning phase/session/champ-select fixtures; connection refused path |
| `game/liveclient.js` | fixture `allgamedata` (hand-written from Riot docs shape); active player matching by riotId and by summonerName; prefix stripping; missing fields |
| `game/detector.js` | reducer table tests: every phase transition, champ retention, stage derivation |
| `data/aramkit/normalize.js` | real fixture `champion-details-157-all.json` + resources → exact expected values (Mystic Punch 0.6517 / 112923 / S; crit archetype route; Flash+Mark); missing resource entries; empty augments → throws |
| `data/aramkit/client.js` | URL building from `versions.json` fixture; rate limiter with fake timers |
| `data/aramgg/normalize.js` | hand-written fixture per docs; null winRate rows; no stages |
| `data/champions.js` | byId / byRiotId case-insensitive / search prefix |
| `data/cache.js` | in-memory fs shim + fake `now`: hit, miss, expired, corrupt, version pruning |
| `data/repository.js` | fake adapters: primary ok; primary fails → fallback; both fail → stale; both fail no cache → throws; in-flight dedupe |
| `rank/augments.js` | sort order by tier/WR/games, low-sample demotion, stage selection & `stageUsed`, lift math |
| `rank/builds.js` | pick filter, tie-breaks, flattening, fallback when no archetype passes filter |
| `server/http.js` | spin up on port 0, hit each route with `fetch`, assert JSON shapes and 404s |
| `server/state.js` | champ change triggers one repository call; bracket toggle; error ring buffer |

Manual smoke checklist (documented in README): start server, open page, start a Mayhem game,
confirm champ appears in champ select, level/stage advances in game, bracket toggle, search.

## 14. Milestones (for the implementation plan)

1. Scaffold + config + cache + champion index (green tests, no UI).
2. aramkit client + normalizer against fixtures.
3. rank/augments + rank/builds.
4. HTTP server + `/api/champ/:id` → first useful page via search box (no game needed).
5. Live Client + LCU + detector → automatic champion.
6. aramgg fallback adapter.
7. Polish: icons, stale/error UI, start.cmd, README.

## 15. Open questions

- aramgg API key: obtain from `https://data.dtodo.cn/developer.html` (GitHub login) when
  milestone 6 starts. Fallback stays disabled until then.
- aramkit endpoints are undocumented and found in their frontend bundle; if they move, the
  adapter breaks. Version check failure → clear error in UI, fallback takes over.

## 16. References

- aramkit data endpoints and schemas: verified 2026-09-25, fixtures in `test/fixtures/aramkit/`.
- aramgg API docs: `docs/aramgg-api-docs.md`.
- Riot Live Client Data API: https://developer.riotgames.com/docs/lol#game-client-api_live-client-data-api
- Augment rounds at levels 3/7/11/15: League wiki, ARAM: Mayhem.
- Mayhem queue ids 2400 / 2450 and "Live Client never exposes offered augments":
  MyNamesEMurray/MayhemStatsTracker source.
