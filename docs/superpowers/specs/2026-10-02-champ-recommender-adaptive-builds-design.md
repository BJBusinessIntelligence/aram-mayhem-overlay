# Champion Recommender + Adaptive Builds — Design Spec

Date: 2026-10-02
Status: draft for review
Builds on: `2026-09-25-aram-mayhem-overlay-design.md` (v1, merged), `2026-09-26-ocr-offer-detection-design.md` (merged, verified in game 2026-09-30)

## 1. Goal

During ARAM Mayhem champ select, rank the held champion and every bench champion by how well each
would do **in this team**, with plain-language reasons, so a better swap is visible at a glance.
Once the game is running and both lineups are known, adjust the recommended build (archetype and
situational items) to the matchup. Everything stays advisory, local and read-only.

Two stages for build adaptation:

1. Champ select: allied lineup known → archetype choice may shift (allies only).
2. In game: enemy lineup known (Live Client) → archetype + situational items (full matchup).

## 2. Facts that shape the design

Verified against live endpoints on 2026-10-02 (aramkit 16.19, cdragon latest).

- **LCU champ select** (`/lol-champ-select/v1/session`): `localPlayerCellId`, `myTeam[]` with
  `cellId` + `championId` (ARAM: every player holds a champion from the start; swaps change it),
  `benchChampions[]` with `championId`. Enemy team is not exposed in ARAM champ select.
- **Live Client** (`/liveclientdata/allgamedata`): `allPlayers[].team` (`ORDER`/`CHAOS`) and
  `rawChampionName` for all ten players. Available only once the game client is running, so the
  enemy lineup appears at game start, not on the loading screen.
- **aramkit `stats/all/champion-rankings.json`**: `{ rows: [{ id, rank, tier, sampleCount,
  winRate, pickRate, blueWinRate, redWinRate }] }` for every champion in one file. Base strength
  for a whole bench costs one fetch.
- **aramkit `stats/all/champion-performance-averages.json`**: `{ averages: { damageToChampions,
  physicalDamageToChampions, magicDamageToChampions, trueDamageToChampions, damageTaken,
  damageSelfMitigated, healsOnTeammates, damageShieldedOnTeammates, timeCcingOthers, damageShare,
  … } }`. Used to normalise a champion's combat stats.
- **aramkit champion-details `champion.stats`** has the same combat fields per champion (already
  fetched for the picked champion; the same ChampData is reused). `items.filtered.all[]` gives
  per-item `{ id, winRate, pickRate, sampleCount }` for that champion; `builds.filtered.archetypes[]`
  keyed `crit`, `bruiser`, `ad`, `on_hit`, `ap`, … with routes and `laterItems`.
- **CommunityDragon `v1/champions/{id}.json`**: `roles[]`, `tacticalInfo { damageType:
  kPhysical|kMagic|kMixed, attackType: melee|ranged }`, `playstyleInfo { damage, durability,
  crowdControl, mobility, utility }` on a 1-3 scale. `v1/items.json` (already fetched) has item
  `categories[]` (Armor, SpellBlock, Health, Tenacity, …).
- **No source has champion-pair win rates.** Synergy is heuristic in v1 and the UI says so.
- aramkit ToS forbids bulk scraping; a champ select needs ≤ 15 small champion fetches, all cached
  on disk per data version, so repeat selects are cache hits.
- Riot policy: tools that "dictate player decisions" are unapproved for distribution. This tool is
  strictly personal; output is framed as comparison + reasons, never commands.

Interview decisions (Codex 2026-10-01, Claude 2026-10-02): hybrid layered engine; team fit from
explainable composition rules (empirical pair data when a source exists, none today); no personal
mastery in v1; advisory only; weights **60 / 30 / 10** (strength / composition fit / synergy);
profiles derived by rules + a small override file; one spec covering both subsystems.

## 3. Non-goals

- Reroll advice in champ select, trade suggestions with allies, or any LCU write.
- Personal mastery / recent-games weighting (deferred until the core model is validated).
- Predicting lineup outcomes from match histories (option 2 in the brainstorm; interfaces leave
  room for it).
- Enemy lineup on the loading screen (Live Client is not up yet).
- Hand-curated traits for all champions. Overrides are for the rule misses only.

## 4. Architecture (additions to v1)

```
LCU champ select ──┐
Live Client ───────┴─► detector: game.lineup { held, bench[], allies[], enemies[] }, game.lineupRev
                                   │
                                   ▼
                      AppState.recommend slice (I/O + revision guard)
                                   │
        ┌──────────────────────────┼───────────────────────────┐
        ▼                          ▼                           ▼
 aramkit rankings            champion profiles           ChampData per id
 + averages (1 file each)    cdragon champion json       (existing repository)
                             + aramkit combat stats
                             + data/profile-overrides.json
        └──────────────────────────┼───────────────────────────┘
                                   ▼
                 src/rank/profiles.js   traits 0-1 per champion (pure)
                 src/rank/lineup.js     coverage, fit, synergy, score, reasons (pure)
                 src/rank/builds.js     context-aware archetype + situational items (pure)
                                   ▼
                 /api/state → payload.recommend, payload.build.context
                 POST /api/recommend/preview (same engine, hand-given lineup)
                                   ▼
                 public/app.js: #recommend panel (champ select), build context chips (in game)
```

Pure modules do no I/O and are unit-tested with fixtures. The state layer owns fetching, caching
and the `lineupRev` guard. Existing augment/build display is untouched when the recommender has
no data.

## 5. Data model

```js
// game state (detector) — additions to EMPTY_GAME
lineup: { held: 157, bench: [99, 103], allies: [1, 62, 25], enemies: [] },  // champion ids
lineupRev: 7,   // increments whenever lineup content changes

// profile (src/rank/profiles.js) — all traits 0..1
{ id, riotId, name, ranged: true,
  physicalShare: 0.83, magicShare: 0.12,            // from aramkit combat stats (true dmg excluded)
  frontline, engage, peel, sustain, cc, poke,       // derived traits
  sources: { cdragon: true, aramkit: true, override: false }, warnings: [] }

// recommend payload (state → UI)
recommend: {
  rev: 7, context: 'champselect',
  team: { knownAllies: 3, coverage: { frontline: 0.9, engage: 0.4, … }, physicalShare: 0.7 },
  candidates: [{
    id, riotId, name, icon, held: true|false,
    tier: 'S', winRate: 0.578, games: 3138960,
    score: 82,                                   // 0..100
    components: { strength: 0.91, fit: 0.62, synergy: 0.4 },
    confidence: 'high'|'medium'|'low',
    reasons: ['adds engage', 'team lacks magic damage'],
    warnings: ['profile from roles only'],
  }],
  warnings: [],
}

// build payload — additions to pickBuild() output
build.context: 'none'|'allies'|'both',
build.primary.contextDelta: +2.1,                // pp vs unadjusted top archetype, when swapped
build.primary.contextReason: 'team lacks frontline',
build.situational: [{ item, winRate, pickRate, reason: '3 physical threats → Armor' }],  // ≤ 3
```

## 6. Components

### 6.1 Lineup detection (`src/game/lcu.js`, `src/game/liveclient.js`, `src/game/detector.js`)

- LCU snapshot adds `champSelect: { held, bench[], allies[] }` from the session JSON (`allies` =
  `myTeam` minus the local cell, zero ids dropped). Existing `championId` stays for compatibility.
- Live Client snapshot adds `players: [{ riotId, team }]`; the detector maps riotIds through
  `champIndex.byRiotId` into `allies` / `enemies` relative to the active player's team.
- Detector merges into `game.lineup`; `lineupRev` bumps when the sorted id lists differ.
  `sameState` compares `lineupRev`.
- `scripts/lcu-dump.js`: saves the raw champ-select session JSON to `data/debug/` for a real
  fixture (`test/fixtures/lcu/champ-select-session.json`).

### 6.2 Data sources

- `src/data/aramkit/client.js` + adapter: `rankings(bracket)` → map id → `{ rank, tier, winRate,
  pickRate, games }`; `averages(bracket)` → combat averages. Cached per data version like champ
  data. Normaliser adds `champion.combat` (physical/magic/true damage, damageTaken,
  damageSelfMitigated, healsOnTeammates, damageShieldedOnTeammates, timeCcingOthers, damageShare)
  to ChampData.
- `src/data/cdragon/champion.js`: `champion(id)` → `{ roles, tacticalInfo, playstyleInfo }`,
  24 h cache, stale-if-error like the other cdragon files.
- `data/profile-overrides.json`: `{ "Malphite": { "engage": 1, "frontline": 1, "note": "ult" } }`
  keyed by riotId; partial trait patches only.
- `data/synergy-rules.json`: curated pairs `{ "a": "Yasuo", "b": "trait:knockup"|"Malphite",
  "delta": 0.5, "reason": "knock-up for Last Breath" }`. Small list; generic rules live in code.

### 6.3 Profiles (`src/rank/profiles.js`, pure)

Inputs: cdragon champion json, aramkit combat stats + averages, override entry. Rules (all clamp
to 0..1; `ps` = playstyleInfo scaled (v−1)/2; `ratio(x)` = champion stat / average, capped at 2):

- `ranged` = attackType === 'ranged'.
- `physicalShare`, `magicShare` = shares of (physical + magic) champion damage.
- `frontline` = mean(ps.durability, min(1, ratio(damageSelfMitigated)/2), roles tank 1 / fighter 0.6 / else 0) — melee bonus +0.1.
- `engage` = mean(ps.mobility, ps.crowdControl, melee ? 1 : 0.3) × (roles tank/fighter/assassin ? 1 : 0.6).
- `peel` = mean(ps.utility, ps.crowdControl, ranged ? 1 : 0.4) × (roles support/mage ? 1 : 0.6).
- `sustain` = min(1, ratio(healsOnTeammates + damageShieldedOnTeammates)/2).
- `cc` = mean(ps.crowdControl, min(1, ratio(timeCcingOthers)/2)).
- `poke` = ranged ? mean(ps.damage, 1 − ps.durability) × (roles mage/marksman ? 1 : 0.6) : 0.
- Missing cdragon → playstyle terms default 0.5 and `warnings: ['profile from roles only']`;
  missing aramkit combat → ratio terms default 1 (neutral) and warning.
- Override patch applied last; `sources.override = true`.

### 6.4 Scoring engine (`src/rank/lineup.js`, pure; weights in `src/rank/weights.js`)

- `strength(candidate, rankings)`: shrunk win rate `wr' = (wr·n + 0.5·K)/(n + K)`, K = 20 000
  games; strength = percentile of `wr'` among all rankings rows (0..1). Missing rankings row →
  use ChampData `champion.winRate/games`; missing both → 0.5 + warning.
- `coverage(profiles)`: per trait noisy-OR `1 − Π(1 − t_i)`; damage balance = allied
  physicalShare weighted by damageShare.
- `fit(candidate, allies)`: Σ_trait w_t · (coverage(allies + c) − coverage(allies)) +
  w_balance · balanceGain, where balanceGain = reduction of |physicalShare − 0.5| after adding
  the candidate. Trait weights: frontline 1.0, balance 1.0, engage 0.8, peel 0.8, cc 0.7,
  sustain 0.6, poke 0.6. Normalised by Σ w (max possible) → 0..1. With k known allies out of 4,
  fit is shrunk toward 0.5 by k/4.
- `synergy(candidate, allies, rules)`: generic rules, each 0..1 then averaged: engage(c) ×
  max ally burst (ps.damage, ranged or assassin), peel(c) × max ally hypercarry (marksman or
  mage with durability ≤ 0.3), cc(c) × max ally cc (chain). Plus curated rule deltas (clamped).
- `score = 100 · (0.6·strength + 0.3·fit + 0.1·synergy)`.
- `confidence`: high when knownAllies = 4, candidate games ≥ 50 000 and profile has both sources;
  medium when any one fails; low when two or more fail.
- `reasons`: top 2-3 positive terms by contribution, worded from a fixed table ("adds frontline",
  "adds magic damage", "engage for allied burst", "peel for Jinx"); one negative when the team
  still lacks a trait the candidate also lacks ("team still lacks peel"); "low sample (12k games)"
  when games < 50 000.
- `rankCandidates({ held, bench, allies, rankings, profiles, champData, rules })` → sorted
  candidates; held champion is included and flagged.

### 6.5 Build adaptation (`src/rank/builds.js`, pure, extends `pickBuild`)

- `pickBuild(champData, { context })`, `context = { allies: profiles[], enemies: profiles[]|null,
  itemCategories }`. Without context: unchanged behaviour (`build.context = 'none'`).
- Archetype modifier (allies known): per archetype key, a lookup of what it brings
  (`bruiser`/`tank` → frontline; `ap` → magic damage; `crit`/`ad`/`on_hit` → physical damage;
  `support`/`enchanter` → peel/sustain). Modifier = Σ unmet-need × 3 pp, capped at **±3 pp**,
  added to archetype winRate; only archetypes with pickRate ≥ 5 % may overtake the top one.
  When the top archetype changes, `contextDelta` and `contextReason` are set.
- Situational items (enemies known): candidates = union of the chosen route's `laterItems` and
  `items.filtered.all` with pickRate ≥ 1 %. Threat vector from enemy profiles: physicalShare,
  magicShare, cc coverage, burst (mean ps.damage of enemies with poke or assassin), healing
  (sustain coverage). Item gets a bonus per matching cdragon category: Armor ↔ physical,
  SpellBlock ↔ magic, Tenacity ↔ cc, Health ↔ burst, anti-heal (curated id list: 3123, 3033,
  3165, 3011, 3075) ↔ healing. Rank by winRate + bonus (bonus capped at 3 pp); top 3 with a
  reason each. Never replaces `core`.
- `build.context` = `'both'` when enemies known, `'allies'` when only allies, else `'none'`.

### 6.6 App state (`src/server/state.js`)

- New slice `recommend` with `rev`. On `setGame`, when `lineup`/`lineupRev` changed and phase is
  `champselect` or `ingame`, call `loadRecommend(rev)`: fetch rankings + averages (once per
  version), profiles for every lineup id (parallel, each failure → warning not abort), ChampData
  for candidates (champ select) or the held champion (in game; already loaded). Compute via the
  pure modules. Store only when `rev` is still current.
- `snapshot()` adds `recommend` and passes `context` into `pickBuild`.
- `previewRecommend({ held, bench, allies, enemies })` runs the same path without touching game
  state (mirrors the existing preview pattern).
- Errors push to the `errors` ring with scope `recommend`.

### 6.7 HTTP (`src/server/http.js`)

- `POST /api/recommend/preview` body `{ held, bench: [], allies: [], enemies: [] }`; ids or
  riotIds (resolved via `champIndex`); 400 on invalid input, 502 when data is unavailable.
- `/api/state` unchanged in shape apart from the new fields.

### 6.8 UI (`public/index.html`, `app.js`, `style.css`)

- New `<section id="recommend" hidden>` between `#offer` and `#main`: head line (context,
  "n/4 allies known", confidence of the top card, Hide button), team coverage strip (trait ✓/✗ at
  threshold 0.6, "70 % AD / 30 % AP"), candidate cards sorted by score: icon, name, tier,
  win rate, 0-100 bar + number (title attribute shows the three components), HELD / bench tag,
  confidence chip, reason chips, muted warnings.
- Shown only when `game.phase === 'champselect'` (or a preview is active) and `recommend` is
  present. `#main` stays below for the held champion.
- Build column: context chip ("Allies only" / "Full matchup"), archetype swap line
  ("crit → bruiser · +2.1 pp est. · team lacks frontline"), "Situational" row of ≤ 3 items with
  reason tags.
- Preview: a small form in the recommend section head (held, bench, allies, enemies as
  comma-separated names) posting to the preview endpoint; result renders with a "Preview" tag.

## 7. Configuration

- `src/rank/weights.js`: component weights (0.6/0.3/0.1), trait weights, shrink K, archetype and
  item caps (3 pp), pick-rate floors (5 %, 1 %), confidence thresholds. Plain exported object;
  no env plumbing in v1.
- `--rec-debug` / `REC_DEBUG=true`: dump `data/debug/recommend-<ts>.json` (lineup, inputs
  summary, candidates) on every recompute; keep the newest 50.

## 8. Error handling

- Any missing source degrades per component (see 6.3, 6.4) and adds a warning; the panel renders
  what it has. Only a total failure (no rankings and no ChampData for any candidate) yields
  `recommend: null` plus an `errors` entry.
- Late results for an older `lineupRev` are dropped.
- Profile fetch failures for one champion never block the others (`Promise.allSettled`).
- The preview endpoint validates ids/names and returns 400 with a message listing the unknown
  names.

## 9. Testing

node:test, zero deps, fixtures under `test/fixtures/`:

- `lcu/champ-select-session.json` (real capture via `scripts/lcu-dump.js`; hand-built from the
  LCU schema until then), `liveclient/allgamedata.json` (exists; add team mapping cases),
  `cdragon/champions/{157,99,54}.json`, `aramkit/champion-rankings.json`,
  `aramkit/champion-performance-averages.json`.
- `test/rank/profiles.test.js`: each rule, missing-source defaults + warnings, override patch.
- `test/rank/lineup.test.js`: shrink + percentile, noisy-OR coverage, diminishing returns
  (second tank gains less than first), balance gain, unknown-ally shrink, synergy generic +
  curated, reason selection, confidence levels, held flag + sorting.
- `test/rank/builds.test.js`: no-context unchanged, modifier cap, pick-rate floor, swap fields,
  situational ranking + reasons, anti-heal list.
- `test/game/lcu.test.js`, `liveclient.test.js`, `detector.test.js`: lineup extraction, rev
  bumps only on content change.
- `test/server/state.test.js`: recompute on lineup change, revision guard, degradation paths,
  preview isolation. `http.test.js`: preview endpoint validation.
- README manual smoke checklist: champ select panel appears, swap reorders, in-game build chip
  and situational row, preview form.

## 10. Milestones

1. Lineup detection + fixtures + `lcu-dump.js`.
2. Data sources (rankings, averages, cdragon champion, combat stats in ChampData).
3. Profiles + override file.
4. Scoring engine + weights + reasons.
5. State slice + preview endpoint.
6. Champ-select UI.
7. Build adaptation (archetype modifier, situational items) + in-game UI.
8. Debug dumps, README, one gameplay round, tune overrides from the dumps.

## 11. Open questions / risks

- Rule-derived traits will mis-profile some champions; the override file and the gameplay-round
  dumps are the tuning loop. Expect a first pass of ~10-20 overrides.
- Percentile strength hides absolute gaps (S at 58 % vs A at 54 %); win rate is shown next to the
  score so the gap stays visible.
- aramkit archetype keys beyond `crit/bruiser/ad/on_hit` are not enumerated; unknown keys get no
  modifier (logged once).
- LCU session shape for ARAM bench is from the public schema; the first real dump confirms it
  before milestone 1 is closed.
