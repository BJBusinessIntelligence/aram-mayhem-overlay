# Live Augment Offer Detection (OCR) — Design Spec

Date: 2026-09-26
Status: draft for review
Builds on: `2026-09-25-aram-mayhem-overlay-design.md` (v1, merged)

## 1. Goal

While in an ARAM Mayhem game, detect the moment the augment selection screen shows three
cards, read the three augment names off the screen, and switch the page from the ranked list to
an **offer view**: three cards drawn in the game's style, the recommended pick highlighted, and
per-card reroll advice. When the selection screen goes away, return to the list.

## 2. Facts that shape the design

- No API exposes offered augments (Riot Live Client Data, LCU) — only picked spell-slot augments
  leak. Screen capture + OCR is the only route (same as aramgg_client / ARAMKit Companion).
- Windows 10/11 ships `Windows.Media.Ocr`. Spike on this machine (3440×1440, Borderless):
  one-shot script ≈ 0.5 s per full frame; a persistent worker (engine kept warm, frame passed
  in memory) measured 207–332 ms per capture+OCR; UI text read cleanly. Zero new dependencies:
  Node spawns `powershell.exe` (Windows PowerShell 5.1, which has the WinRT projection; `pwsh` 7
  does not).
- The game window is found by process name (`League of Legends`) and captured by its client
  rect via Win32 (`GetWindowRect`/`ClientToScreen`), so the game may sit on any monitor.
- Card geometry from aramgg_client (16:9 reference): three cards centred, each ≈ 16.8 % of width,
  gap ≈ 1.75 %, titles at 35–45 % of height, reroll buttons at ≈ 63 %. On 21:9 the UI is
  height-scaled and centred, so ratios differ. Design is therefore **geometry-agnostic**: OCR a
  generous central band and cluster matches by x-position.
- Reroll rule (wiki): each card can be rerolled once for another augment of the same rarity.
  Every card on one screen shares one rarity.
- Interview decisions: Borderless mode; cards replace the list; reroll advice = "reroll every
  card below the best; if even the best is C/D, reroll all".

## 3. Non-goals

- Reading reroll-button state, Golden Rerolls, or the reroll counter.
- Auto-clicking anything. Read-only, always.
- Non-Windows OCR backends. Linux/macOS: feature disabled, list view unchanged.
- Multiple languages: English client text only (the OCR engine uses the user's Windows
  language; names are matched against English augment names).

## 4. Architecture (additions to v1)

```
src/ocr/
  worker.ps1        persistent PowerShell OCR worker (stdin commands → stdout JSON lines)
  worker.js         Node side: spawn/respawn worker, capture(opts) → { ok, w, h, ms, lines }
  match.js          pure: OCR lines + augment index → offer { cards[3], rarity, confidence }
  watcher.js        loop: gated by game phase, cadence, debounce, publishes offer to AppState
  advice.js         pure: rank cards, pick, reroll verdicts
public/             offer view (cards), toggled by payload.offer
```

Dependency direction: `watcher` → `worker`, `match`, `advice`, `state.setOffer`. `match` and
`advice` are pure and fully unit-tested; `worker.js` is tested with a fake child process;
`worker.ps1` is verified by a manual capture command (§9).

## 5. Data model

```js
OcrLine  = { text: 'Mystic Punch', x: 1420, y: 610, w: 210, h: 34 }     // px in the captured frame
Capture  = { ok: true, w: 3440, h: 1440, ms: 480, lines: OcrLine[], error?: string }

Offer = {
  detectedAt: ms, frames: 3,                     // consecutive frames that agreed
  stage: 2 | null, rarity: 'gold' | 'unknown',   // rarity from the matched augments
  cards: [                                       // always length 3, left → right
    { slot: 'left', augmentId: 1058, ocrText: 'Mystic Punch', score: 0.96, row: Row | null,
      verdict: 'pick' | 'reroll' | 'keep' }, …
  ],
  pickSlot: 'left' | null,
  note: 'Reroll all, then pick the best' | null,
}
Row = AugmentRow (from ChampData) + { lift, lowSample, description }
```

`/api/state` payload gains `offer: Offer | null` and `ocr: { enabled, running, lastCaptureMs,
lastError }`. `AugmentRow` gains `description: string | null` (flattened tooltip text from the
aramkit augments resource; null for Blitz/CommunityDragon rows unless cdragon provides one).

## 6. Components

### 6.1 `worker.ps1`
Long-lived. Reads one command per line from stdin:
- `capture {"region":"band"|"full","saveTo":null|"path"}` → captures the League window client
  rect (falls back to the primary screen if the window is not found), optionally crops to the
  band `x 15–85 %, y 20–75 %`, runs OCR, writes one JSON line: `{ ok, w, h, ms, window: bool,
  lines: [{ text, x, y, w, h }] }` with coordinates in **full-frame** pixels even when cropped.
- `ping` → `{ ok: true }`. `quit` → exits.
Errors are returned as `{ ok:false, error }` lines; the process never dies on a bad frame.

### 6.2 `worker.js`
`createOcrWorker({ spawn, scriptPath, timeoutMs = 4000, log })` → `{ capture(opts), ping(),
stop(), isAvailable() }`. Serializes requests (one in flight), respawns the child on exit or
timeout (max 5 respawns per 10 min, then `isAvailable() = false` and an error is recorded).
`isAvailable()` is `false` on non-win32 without spawning anything.

### 6.3 `match.js` (pure)
`matchOffer(lines, augmentIndex, { frameW, frameH }) → { cards, rarity, confidence } | null`

1. Candidate lines: within the central band; height between 0.9 % and 4 % of `frameH` (title
   size, rejects body text and tiny UI); merge two adjacent lines in the same column when a
   title wraps.
2. Normalize text: lowercase, strip everything but `[a-z0-9]`. Compare against every augment
   name normalized the same way. Score = 1 − levenshtein / max(len); accept ≥ 0.8, or exact
   prefix ≥ 6 chars. Prefer longest name on ties.
3. Keep the best-scoring match per distinct x-cluster (cluster = centres within 6 % of frameW).
   Need ≥ 2 clusters with matches; take the three largest-scored clusters ordered by x →
   `left, center, right`; a missing third slot is `{ augmentId: null }`.
4. `rarity` = the rarity shared by the matched augments (majority); `confidence` = mean score ×
   (matched / 3).

`augmentIndex` is built once per ChampData from `augments.all` (names) and from the
CommunityDragon augment list for names the champion's source lacks.

### 6.4 `advice.js` (pure)
`advise(cards, champData, { stage }) → { cards, pickSlot, note }`. For each matched card take the
row from `shapeAugments(champData, { stage })` (any rarity column). Order by the v1 comparator
(tier → WR → games). `pick` = best. For the others: `reroll` if tier ∈ {C, D, null} or
`lift < 0`; else `keep`. If the best is C/D (or unmatched): `note = 'Reroll all, then pick the
best'` and every card is `reroll`.

### 6.5 `watcher.js`
`createOfferWatcher({ worker, state, getChampData, getAugmentIndex, now, timers, idleMs = 1500,
activeMs = 500, log })` → `{ start(), stop(), captureOnce() }`.
- Runs only while `state.getGame().phase === 'ingame'` and `worker.isAvailable()`; otherwise idle
  (checks the phase every `idleMs` without capturing).
- Cadence: `idleMs` when no offer is showing, `activeMs` while one is.
- Debounce: an offer is published after **2 consecutive** frames agree on the same augment ids;
  cleared after **2 consecutive** frames with no match (avoids flicker on animation frames).
- Publishes via `state.setOffer(offer | null)` and `state.setOcrStatus({...})`.
- Never throws out of the loop; errors go to `state.pushError('ocr', …)` at most once per
  distinct message.

### 6.6 AppState / server
- `setOffer(offer)`, `setOcrStatus(s)`; `snapshot()` includes `offer` and `ocr`.
- `POST /api/ocr/capture` → runs `captureOnce()` and returns the raw `Capture` plus the match
  result; with `{ "save": true }` also writes `data/debug/capture-<ts>.png` + `.json`. This is
  the calibration tool: run it during a real augment screen to collect a fixture.
- `POST /api/ocr` `{ enabled: bool }` toggles the watcher at runtime.

### 6.7 Page (offer view)
When `payload.offer` is non-null the main grid is replaced by `#offer`:
- Header: `Stage 2 · Gold offer · confidence 94 %` and the OCR status chip.
- Three cards, left→right, matching the game: tall rounded panel with a rarity-coloured frame
  (silver `#c3ccd6`, gold `#f2c14e`, prismatic animated cyan/magenta gradient), augment icon
  (64 px), name, description (≤ 4 lines, muted), then stats: tier badge, WR, lift, games.
- The `pick` card gets a bright outline + "PICK" ribbon; `reroll` cards a dim "REROLL" chip;
  unmatched slot shows "unread" with the OCR text.
- `note` shown as a banner above the cards.
- Escape key or a "Show list" button hides the offer view until the next offer.
List view is unchanged and returns automatically when `offer` becomes null.

## 7. Configuration

| Env / flag | Default | Meaning |
|---|---|---|
| `OCR_ENABLED` / `--ocr` | `true` on win32, else `false` | master switch |
| `OCR_IDLE_MS` | 1500 | capture interval while no offer is shown |
| `OCR_ACTIVE_MS` | 500 | capture interval while an offer is shown |
| `OCR_DEBUG` / `--ocr-debug` | off | save every frame that produced a match to `data/debug/` |
| `OCR_REGION` | `band` | `band` or `full` |

## 8. Error handling

- Worker missing/crashing: status chip "OCR unavailable", list view keeps working. Respawn
  budget as in §6.2.
- OCR reads garbage: `matchOffer` returns null; nothing changes. Only ≥ 2 agreeing frames
  publish.
- Capture returns a black/empty frame (fullscreen-exclusive): zero lines → null; a status hint
  "no text seen for 30 s while in game — is League in Borderless mode?" after 30 s in game.
- Augment not in the champion's data (new augment): card row null, verdict `keep`, name from
  CommunityDragon if known.

## 9. Testing

| Unit | Test |
|---|---|
| `match.js` | fixtures: hand-written line sets (clean, one typo, wrapped title, noise lines, 2-of-3, ultrawide coordinates); real capture JSON once collected via `/api/ocr/capture` |
| `advice.js` | tier/WR combinations → verdicts and note; unmatched card |
| `worker.js` | fake `spawn` (EventEmitter child with stdin/stdout): request serialization, JSON parsing, timeout → respawn, respawn budget, non-win32 → unavailable |
| `watcher.js` | fake worker + fake timers: phase gating, cadence switch, 2-frame debounce both ways, error dedupe |
| state/http | `offer`/`ocr` in payload; `/api/ocr/capture` and `/api/ocr` routes |
| `worker.ps1` | manual: `node scripts/ocr-capture.js` prints lines + timing; repeated during a real augment screen to produce `test/fixtures/ocr/*.json` |

## 10. Milestones

1. `worker.ps1` + `worker.js` + `scripts/ocr-capture.js` (manual capture tool). Collect a real
   augment-screen fixture on the next game.
2. `match.js` + `advice.js` against fixtures.
3. `watcher.js` + state/http wiring + config.
4. Offer view UI + `description` in rows.
5. README + calibration notes.

## 11. Open questions / risks

- Card title font/case in-game may lower OCR accuracy; the fuzzy threshold (0.8) is a starting
  point to tune against the first real fixture.
- The ultrawide band percentages are a guess until a real capture exists; `/api/ocr/capture`
  with `save` is the tool to fix them.
- Capture of the game window while the overlay page has focus on another monitor is fine; if
  the game is minimised, capture yields the desktop → no match → nothing happens.
