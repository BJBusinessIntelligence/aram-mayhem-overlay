# ARAM Mayhem Overlay

Local page for a second monitor: detects your League of Legends champion (champ select via LCU,
in game via Live Client Data) and shows ARAM Mayhem augment win rates per rarity, auto-switched
to the current augment stage (levels 3 / 7 / 11 / 15), plus a high-win-rate build.

Data: [aramkit.com](https://aramkit.com) public JSON (primary), [Blitz.gg](https://blitz.gg) +
[CommunityDragon](https://communitydragon.org) (keyless fallback). Not endorsed by Riot Games.

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
| `PRIMARY_SOURCE` / `--primary` | `aramkit` | `aramkit` or `blitz` |
| `--open` | off | Open the browser after start |
| page `?noicons=1` | | Hide item/augment icons |

Blitz needs no key and is CORS-open, but it only has **tiers (S–D), not win/pick rates**, and its
builds come from regular ARAM (queue 450), not ARAM Mayhem specifically — augment and champion
win rate, pick rate and games all read `null` (shown as "–"), and the shown build is a general-ARAM
build rather than a Mayhem one. It's a fallback for when aramkit is unreachable, not a replacement.

## Page

- Stage tabs: Auto (from your level), All, 1–4. Bracket: All or High MMR.
- Rows: tier badge, name, win rate, lift vs the augment's global win rate, games. Rows under
  200 games are dimmed and sorted last.
- Build: best archetype by win rate with ≥5 % pick; starter, boots, core order, later items,
  spells, skill order. Other archetypes under "Other builds".
- Search box previews any champion; "Live" returns to the detected one. ↻ re-fetches.

## Live augment offers (Windows)

While you are in a game the overlay captures the League window with Windows' built-in OCR
(about 4 frames/s while an offer is on screen, one every 1.5 s otherwise) and reads the three
augment card titles. When two consecutive frames agree, the page switches to three cards:

- **PICK** — the best card by tier, then win rate.
- **REROLL** — cards with C/D tier or negative lift; if even the best is weak, "Reroll all".
- **KEEP** — fine, but not the pick.

The list returns when the cards disappear. Press Esc or "Show list" to dismiss early.
Requirements: League in **Borderless** (or Windowed) mode; English client. Nothing is clicked
or sent to the game — capture only.

Options: `OCR_ENABLED=false` / `--ocr=false` turns it off; `OCR_IDLE_MS`, `OCR_ACTIVE_MS`,
`OCR_REGION=band|full`, `--ocr-debug` (dumps every in-game tick's OCR result, plus every
published offer, to `data/debug/`; see below).
Runtime toggle: `POST /api/ocr {"enabled":false}`.

Calibration / troubleshooting: capture a frame + OCR result under `data/debug/` for tuning,
via any of:

- the page's **📷 Capture** button (top right, next to refresh) — one click, no terminal.
- `curl.exe -X POST "localhost:3777/api/ocr/capture?save=1"` — PowerShell-safe, no request
  body needed.
- `node scripts/ocr-capture.js --full --save data/debug/f.png --json data/debug/f.json` —
  prints every line the OCR sees with coordinates.

These work whether or not `--ocr-debug` is set, and attach the saved files when reporting a
missed offer. Separately, run one full game with `node src/main.js --ocr-debug` and send
`data/debug/` for tuning: it writes every in-game tick's OCR result as `tick-<ts>.json`
(capped at the newest 100 files) plus one `offer-<ts>.json` per published offer.

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
    src/data/           cache, repository, champion index, aramkit + blitz adapters, cdragon resources
    src/rank/           augment ranking, build selection (pure)
    src/game/           lockfile, lcu, liveclient, detector
    src/server/         state store, http routes
    public/             page
    test/               node:test suites + fixtures (aramkit/blitz/cdragon fixtures are real captures)
