# Live Augment Offer Detection (OCR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While in an ARAM Mayhem game, read the three offered augment names off the screen with Windows' built-in OCR and swap the page to an offer view with a recommended pick and per-card reroll advice.

**Architecture:** A persistent PowerShell worker (`Windows.Media.Ocr`) captures the League window and returns OCR lines as JSON over stdio. Pure modules match lines to augment names (`match.js`) and produce verdicts (`advice.js`). A watcher loop, gated on `game.phase === 'ingame'`, debounces two agreeing frames and publishes an `offer` into the existing AppState payload; the page renders it as three game-style cards.

**Tech Stack:** Node 24 ESM, zero dependencies, `node:test`; Windows PowerShell 5.1 (`powershell.exe`) for WinRT OCR; existing v1 modules (`server/state.js`, `rank/augments.js`, `server/http.js`, `public/app.js`).

**Spec:** `docs/superpowers/specs/2026-09-26-ocr-offer-detection-design.md`

## Global Constraints

- Node `>=22`, `"type": "module"`, no runtime or dev dependencies. Tests: `node:test` + `node:assert/strict` under `test/` mirroring `src/`, named `*.test.js`; `npm test` = `node --test "test/**/*.test.js"`. Tests never spawn PowerShell, touch the screen, the network, or the real clock (inject `spawn`, `now`, timers).
- OCR is Windows-only: `worker.isAvailable()` is `false` when `platform !== 'win32'`; every other feature keeps working.
- Worker protocol: one JSON object per stdin line (`{"cmd":"capture","region":"band"|"full","saveTo":null|path}`, `{"cmd":"ping"}`, `{"cmd":"quit"}`), one JSON object per stdout line. First line is `{"ok":true,"ready":true,...}`. Capture reply: `{ ok, w, h, window, region:{x,y,w,h}, ms, lines:[{text,x,y,w,h}] }` with coordinates in **full-frame pixels** even when cropped.
- Default band = x 15–85 %, y 20–75 % of the frame. Title line height accepted = 0.9 %–4 % of frame height. Fuzzy accept score ≥ 0.8. x-cluster radius = 6 % of frame width. Slot by centre x: `< 42 % → left`, `> 58 % → right`, else `center`.
- Debounce: publish after 2 consecutive agreeing frames; clear after 2 consecutive frames without a match. Cadence 1500 ms idle / 500 ms while an offer is shown.
- Verdicts: `pick` = best by v1 comparator (tier → WR → games); other cards `reroll` if tier ∈ {C, D, null} or lift < 0, else `keep`; if the best is C/D/null → all `reroll` + note `Reroll all, then pick the best`. Unmatched slot → `unread`.
- Payload additions: `offer: Offer|null`, `ocr: { enabled, running, lastCaptureMs, lastCaptureAt, lastError }`; `AugmentRow.description: string|null`.
- Config: `OCR_ENABLED`/`--ocr` (default `true` on win32), `OCR_IDLE_MS` 1500, `OCR_ACTIVE_MS` 500, `OCR_REGION` `band`, `OCR_DEBUG`/`--ocr-debug` off.
- This plan is executed **after** the Blitz-fallback branch is merged. `src/main.js` edits are given as insertions relative to anchors that exist in both versions.
- Every commit message: subject, blank line, `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer on its own line.
- Deviations recorded during the final-review fix wave: worker `timeoutMs` is `8000`, not spec §6.2's `4000` (measured 200–350 ms per capture in practice, with a cold-start respawn around 2 s, so the larger budget avoids spurious timeouts without materially slowing error detection); the no-rows advice note text is `No data for these augments` / `Champion data not loaded` rather than spec §6.4's reroll-all wording for the "or unmatched" case (clearer about *why* there's no verdict when the row itself is missing); `debugDir` is always set so `POST /api/ocr/capture {"save":true}` works unconditionally, with only the per-offer auto-dump on a published tick gated behind `OCR_DEBUG`/`--ocr-debug`.

## File Structure

```
src/ocr/worker.ps1        persistent OCR worker (WinRT), stdio JSON protocol
src/ocr/worker.js         spawn/respawn, request serialization, timeout, availability
src/ocr/match.js          pure: OCR lines → offer cards (fuzzy name match, x-clustering)
src/ocr/advice.js         pure: offer + ChampData → verdicts, pick, note
src/ocr/watcher.js        loop: phase gating, cadence, debounce, publish to AppState
scripts/ocr-capture.js    manual capture tool (calibration + fixture collection)
src/config.js             + ocr* options
src/server/state.js       + setOffer, setOcrStatus, getChampData, payload fields
src/server/http.js        + POST /api/ocr/capture, POST /api/ocr
src/main.js               + worker + watcher wiring
src/data/aramkit/normalize.js  + description on augment rows
public/index.html, app.js, style.css   offer view
test/ocr/*.test.js, test/fixtures/ocr/*.json
```

---

### Task 1: OCR worker (PowerShell script + Node wrapper + manual capture tool)

**Files:**
- Create: `src/ocr/worker.ps1`, `src/ocr/worker.js`, `scripts/ocr-capture.js`, `test/ocr/worker.test.js`

**Interfaces:**
- Produces: `createOcrWorker({ spawn?, scriptPath?, platform?, timeoutMs = 8000, maxRespawns = 5, respawnWindowMs = 600000, now?, log? }) → { isAvailable(), lastError(), capture({ region?, saveTo? }) → Capture, ping(), stop() }` where `Capture = { ok: true, w, h, window, ms, lines: [{ text, x, y, w, h }] } | { ok: false, error, lines: [] }`.
- `DEFAULT_SCRIPT` = absolute path of `worker.ps1`.

- [ ] **Step 1: Write `src/ocr/worker.ps1`**

```powershell
# Persistent OCR worker. Protocol: one JSON object per stdin line -> one JSON object per stdout line.
# Requires Windows PowerShell 5.1 (WinRT projection). Never exits on a bad frame.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AmoWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Emit @{ ok = $false; ready = $false; error = 'no OCR language pack installed' }; exit 1 }
Emit @{ ok = $true; ready = $true; lang = $engine.RecognizerLanguage.LanguageTag }

function Get-GameRect {
  $p = Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $p -or [AmoWin32]::IsIconic($p.MainWindowHandle)) { return $null }
  $r = New-Object AmoWin32+RECT
  if (-not [AmoWin32]::GetClientRect($p.MainWindowHandle, [ref]$r)) { return $null }
  $pt = New-Object AmoWin32+POINT
  [AmoWin32]::ClientToScreen($p.MainWindowHandle, [ref]$pt) | Out-Null
  if ($r.Right -lt 200 -or $r.Bottom -lt 200) { return $null }
  return @{ X = $pt.X; Y = $pt.Y; W = $r.Right; H = $r.Bottom; Window = $true }
}

function Capture($req) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $rect = Get-GameRect
  if ($null -eq $rect) {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $rect = @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height; Window = $false }
  }
  $ox = 0; $oy = 0; $cw = $rect.W; $ch = $rect.H
  if ($req.region -ne 'full') { $ox = [int]($rect.W * 0.15); $oy = [int]($rect.H * 0.20); $cw = [int]($rect.W * 0.70); $ch = [int]($rect.H * 0.55) }
  $bmp = New-Object System.Drawing.Bitmap $cw, $ch
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.X + $ox, $rect.Y + $oy, 0, 0, $bmp.Size); $g.Dispose()
  if ($req.saveTo) { $bmp.Save([string]$req.saveTo, [System.Drawing.Imaging.ImageFormat]::Png) }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
  $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
  $writer.WriteBytes($ms.ToArray())
  $null = Await ($writer.StoreAsync()) ([UInt32]); $null = $writer.DetachStream(); $ras.Seek(0)
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($l in $res.Lines) {
    $ws = @($l.Words); if ($ws.Length -eq 0) { continue }
    $r0 = $ws[0].BoundingRect; $rN = $ws[$ws.Length - 1].BoundingRect
    $lines += @{ text = $l.Text; x = [int]($r0.X + $ox); y = [int]($r0.Y + $oy); w = [int]($rN.X + $rN.Width - $r0.X); h = [int]$r0.Height }
  }
  return @{ ok = $true; w = $rect.W; h = $rect.H; window = $rect.Window; region = @{ x = $ox; y = $oy; w = $cw; h = $ch }; ms = $sw.ElapsedMilliseconds; lines = $lines }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try { $req = $line | ConvertFrom-Json } catch { Emit @{ ok = $false; error = "bad request" }; continue }
  switch ($req.cmd) {
    'ping'    { Emit @{ ok = $true; pong = $true } }
    'quit'    { exit 0 }
    'capture' { try { Emit (Capture $req) } catch { Emit @{ ok = $false; error = $_.Exception.Message } } }
    default   { Emit @{ ok = $false; error = "unknown cmd" } }
  }
}
```

- [ ] **Step 2: Verify the script by hand (Windows only)**

Run from the repo root:
```
printf '{"cmd":"ping"}\n{"cmd":"capture","region":"band"}\n{"cmd":"quit"}\n' | powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File src\ocr\worker.ps1
```
Expected: three JSON lines: `{"ok":true,"ready":true,"lang":"en-..."}`, `{"ok":true,"pong":true}`, then a capture object with `"ok":true`, `"w"`, `"h"`, `"ms"` under ~1000 and a `lines` array (content depends on what is on screen).

- [ ] **Step 3: Write the failing test** `test/ocr/worker.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOcrWorker } from '../../src/ocr/worker.js';

// Fake powershell child: replies to each stdin line via `respond(req) -> reply object | undefined`.
function fakeSpawnFactory({ respond, readyLine = { ok: true, ready: true, lang: 'en-US' }, exitOnSpawn = false } = {}) {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 1)); };
    child.stdin = { write: (s) => { const req = JSON.parse(s); const reply = respond(req, child); if (reply !== undefined) setImmediate(() => child.stdout.emit('data', JSON.stringify(reply) + '\n')); } };
    children.push(child);
    setImmediate(() => { if (readyLine) child.stdout.emit('data', JSON.stringify(readyLine) + '\n'); if (exitOnSpawn) child.emit('exit', 1); });
    return child;
  };
  return { spawn, children };
}

test('non-windows: unavailable, capture resolves ok:false without spawning', async () => {
  const { spawn, children } = fakeSpawnFactory({ respond: () => ({}) });
  const w = createOcrWorker({ spawn, platform: 'linux' });
  assert.equal(w.isAvailable(), false);
  const r = await w.capture();
  assert.equal(r.ok, false);
  assert.deepEqual(r.lines, []);
  assert.equal(children.length, 0);
});

test('capture sends the protocol command and normalizes the reply', async () => {
  let seen;
  const { spawn, children } = fakeSpawnFactory({ respond: (req) => { seen = req; return { ok: true, w: 3440, h: 1440, window: true, ms: 210, lines: [{ text: 'Mystic Punch', x: '1400', y: 600, w: 200, h: 34 }] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32', scriptPath: 'X:\\worker.ps1' });
  const r = await w.capture({ region: 'full', saveTo: 'C:\\t.png' });
  assert.deepEqual(seen, { cmd: 'capture', region: 'full', saveTo: 'C:\\t.png' });
  assert.equal(r.ok, true);
  assert.equal(r.w, 3440);
  assert.deepEqual(r.lines, [{ text: 'Mystic Punch', x: 1400, y: 600, w: 200, h: 34 }]);
  assert.equal(children.length, 1, 'one child reused');
  assert.equal(w.isAvailable(), true);
});

test('a single object reply for lines is wrapped in an array; default region is band', async () => {
  let seen;
  const { spawn } = fakeSpawnFactory({ respond: (req) => { seen = req; return { ok: true, w: 1, h: 1, ms: 1, lines: { text: 'A', x: 1, y: 2, w: 3, h: 4 } }; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  const r = await w.capture();
  assert.equal(seen.region, 'band');
  assert.equal(seen.saveTo, null);
  assert.equal(r.lines.length, 1);
});

test('requests are serialized: second capture waits for the first reply', async () => {
  const order = [];
  const { spawn } = fakeSpawnFactory({ respond: (req) => { order.push('req'); return { ok: true, w: 1, h: 1, ms: 1, lines: [] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  const [a, b] = await Promise.all([w.capture(), w.capture()]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(order, ['req', 'req']);
});

test('timeout kills the child, resolves ok:false, and the next call respawns', async () => {
  let calls = 0;
  const { spawn, children } = fakeSpawnFactory({ respond: () => { calls++; return calls === 1 ? undefined : { ok: true, w: 1, h: 1, ms: 1, lines: [] }; } });
  const w = createOcrWorker({ spawn, platform: 'win32', timeoutMs: 20 });
  const r1 = await w.capture();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /timeout/);
  assert.equal(children[0].killed, true);
  const r2 = await w.capture();
  assert.equal(r2.ok, true);
  assert.equal(children.length, 2);
  assert.equal(w.lastError(), 'worker timeout');
});

test('respawn budget: after maxRespawns within the window the worker disables itself', async () => {
  const { spawn, children } = fakeSpawnFactory({ respond: () => ({}), readyLine: null, exitOnSpawn: true });
  let t = 0;
  const w = createOcrWorker({ spawn, platform: 'win32', maxRespawns: 3, respawnWindowMs: 1000, now: () => t, timeoutMs: 50 });
  for (let i = 0; i < 4; i++) await w.capture();
  assert.equal(children.length, 3);
  assert.equal(w.isAvailable(), false);
  assert.match(w.lastError(), /too often/);
  t = 5000; // window elapsed does not revive a dead worker
  await w.capture();
  assert.equal(children.length, 3);
});

test('ready:false from the script marks the worker dead', async () => {
  const { spawn } = fakeSpawnFactory({ respond: () => ({}), readyLine: { ok: false, ready: false, error: 'no OCR language pack installed' } });
  const w = createOcrWorker({ spawn, platform: 'win32', timeoutMs: 30 });
  const r = await w.capture();
  assert.equal(r.ok, false);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.isAvailable(), false);
  assert.match(w.lastError(), /language pack/);
});

test('stop() sends quit and kills; ping works', async () => {
  const seen = [];
  const { spawn, children } = fakeSpawnFactory({ respond: (req) => { seen.push(req.cmd); return req.cmd === 'ping' ? { ok: true, pong: true } : undefined; } });
  const w = createOcrWorker({ spawn, platform: 'win32' });
  assert.equal((await w.ping()).pong, true);
  w.stop();
  assert.ok(seen.includes('quit'));
  assert.equal(children[0].killed, true);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/ocr/worker.test.js`
Expected: FAIL, cannot find `src/ocr/worker.js`.

- [ ] **Step 5: Write `src/ocr/worker.js`**

```js
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCRIPT = path.join(here, 'worker.ps1');

const UNAVAILABLE = (error) => ({ ok: false, error, lines: [] });

function normalizeCapture(msg) {
  if (!msg || !msg.ok) return UNAVAILABLE(msg && msg.error ? String(msg.error) : 'unknown worker error');
  const raw = Array.isArray(msg.lines) ? msg.lines : msg.lines ? [msg.lines] : [];
  return {
    ok: true, w: Number(msg.w) || 0, h: Number(msg.h) || 0, window: !!msg.window, ms: Number(msg.ms) || 0,
    lines: raw.map((l) => ({ text: String(l.text ?? ''), x: Number(l.x) || 0, y: Number(l.y) || 0, w: Number(l.w) || 0, h: Number(l.h) || 0 })),
  };
}

export function createOcrWorker({
  spawn = nodeSpawn, scriptPath = DEFAULT_SCRIPT, platform = process.platform,
  timeoutMs = 8000, maxRespawns = 5, respawnWindowMs = 10 * 60 * 1000, now = Date.now, log = () => {},
} = {}) {
  const supported = platform === 'win32';
  let child = null;
  let buffer = '';
  let pending = null;          // { resolve, timer }
  let dead = false;
  let lastError = null;
  let spawnTimes = [];
  let queue = Promise.resolve();

  function settlePending(msg) {
    if (!pending) return;
    const p = pending; pending = null; clearTimeout(p.timer); p.resolve(msg);
  }

  function onData(chunk) {
    buffer += String(chunk);
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.ready !== undefined) {
        if (!msg.ready) { dead = true; lastError = msg.error ? String(msg.error) : 'worker not ready'; log(`[ocr] ${lastError}`); }
        continue;
      }
      settlePending(msg);
    }
  }

  function start() {
    if (!supported || dead || child) return;
    const t = now();
    spawnTimes = spawnTimes.filter((s) => t - s < respawnWindowMs);
    if (spawnTimes.length >= maxRespawns) {
      dead = true; lastError = 'OCR worker crashed too often; disabled'; log(`[ocr] ${lastError}`); return;
    }
    spawnTimes.push(t);
    buffer = '';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    if (proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { lastError = String(d).trim().slice(0, 200); });
    proc.on('exit', (code) => { if (child === proc) child = null; log(`[ocr] worker exited (${code})`); settlePending({ ok: false, error: `worker exited (${code})` }); });
    proc.on('error', (e) => { if (child === proc) child = null; lastError = e.message; settlePending({ ok: false, error: e.message }); });
  }

  function request(obj) {
    const run = () => new Promise((resolve) => {
      start();
      if (!child) { resolve({ ok: false, error: lastError ?? 'OCR unavailable' }); return; }
      const proc = child;
      const timer = setTimeout(() => {
        if (!pending) return;
        pending = null; lastError = 'worker timeout'; log('[ocr] request timed out; respawning');
        if (child === proc) child = null;
        try { proc.kill(); } catch { /* already gone */ }
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      pending = { resolve, timer };
      try { proc.stdin.write(JSON.stringify(obj) + '\n'); }
      catch (e) { settlePending({ ok: false, error: e.message }); }
    });
    queue = queue.then(run, run);
    return queue;
  }

  return {
    isAvailable: () => supported && !dead,
    lastError: () => lastError,
    capture: (opts = {}) => (supported
      ? request({ cmd: 'capture', region: opts.region ?? 'band', saveTo: opts.saveTo ?? null }).then(normalizeCapture)
      : Promise.resolve(UNAVAILABLE('OCR is Windows-only'))),
    ping: () => (supported ? request({ cmd: 'ping' }) : Promise.resolve(UNAVAILABLE('OCR is Windows-only'))),
    stop() {
      const proc = child; child = null;
      if (!proc) return;
      try { proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/ocr/worker.test.js`
Expected: 8 passing.

- [ ] **Step 7: Write `scripts/ocr-capture.js`** (manual calibration tool)

```js
// Usage: node scripts/ocr-capture.js [--full] [--save data/debug/frame.png] [--json out.json]
// Captures once with the same worker the app uses, prints lines with positions, exits.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createOcrWorker } from '../src/ocr/worker.js';
import { parseArgs } from '../src/config.js';

const args = parseArgs(process.argv.slice(2));
const worker = createOcrWorker({ log: (m) => console.error(m) });
if (!worker.isAvailable()) { console.error('OCR is Windows-only'); process.exit(2); }
const saveTo = args.save ? path.resolve(args.save) : null;
if (saveTo) await fs.mkdir(path.dirname(saveTo), { recursive: true });
const r = await worker.capture({ region: args.full === 'true' ? 'full' : 'band', saveTo });
worker.stop();
if (!r.ok) { console.error('capture failed:', r.error); process.exit(1); }
console.log(`frame ${r.w}x${r.h} window=${r.window} ms=${r.ms} lines=${r.lines.length}${saveTo ? ` saved=${saveTo}` : ''}`);
for (const l of r.lines) console.log(String(l.x).padStart(5), String(l.y).padStart(5), String(l.w).padStart(5), String(l.h).padStart(3), ' ', l.text);
if (args.json) { await fs.writeFile(path.resolve(args.json), JSON.stringify(r, null, 2)); console.log('wrote', args.json); }
```

- [ ] **Step 8: Run the tool once** (Windows)

Run: `node scripts/ocr-capture.js --full`
Expected: a `frame WxH window=false ms=… lines=N` header followed by lines of on-screen text. (`window=true` only while a game is running.)

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test` → all passing.
```bash
git add src/ocr/worker.ps1 src/ocr/worker.js scripts/ocr-capture.js test/ocr/worker.test.js
git commit -m "feat: persistent windows ocr worker and capture tool"
```

---

### Task 2: Offer matching (pure)

**Files:**
- Create: `src/ocr/match.js`, `test/ocr/match.test.js`

**Interfaces:**
- Consumes: OCR lines `{ text, x, y, w, h }` (full-frame px) from Task 1; augment names/rarity from `ChampData.augments.all` and/or an extra list.
- Produces: `normalizeText(s)`, `levenshtein(a, b)`, `scoreName(normA, normB) → 0..1`, `buildAugmentIndex(entries[]) → Index` (entries `{ id, name, rarity }`, deduped by id), `slotForX(cx, frameW) → 'left'|'center'|'right'`, `matchOffer(lines, index, { frameW, frameH, minScore = 0.8 }) → { cards: [left, center, right], rarity, confidence, matched } | null`. Card = `{ slot, augmentId: number|null, name: string|null, rarity: string|null, ocrText: string|null, score: number, x: number|null, y: number|null }`.

- [ ] **Step 1: Write the failing test** `test/ocr/match.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, levenshtein, scoreName, buildAugmentIndex, slotForX, matchOffer } from '../../src/ocr/match.js';
import { fixture } from '../helpers/fixtures.js';

const aug = fixture('aramkit', 'resources-augments.json');
const entries = Object.entries(aug).map(([id, a]) => ({ id: Number(id), name: a.name, rarity: a.rarity }));
const index = buildAugmentIndex(entries);
const idOf = (name) => entries.find((e) => e.name === name).id;
const FRAME = { frameW: 3440, frameH: 1440 };
const line = (text, x, y, w = 220, h = 34) => ({ text, x, y, w, h });
// Three card titles at plausible ultrawide positions (band x 516..2924, y 288..1080)
const L = 1180, C = 1610, R = 2040, Y = 640;

test('normalizeText and levenshtein', () => {
  assert.equal(normalizeText("Kai'Sa: Void-Seeker!"), 'kaisavoidseeker');
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(scoreName('mysticpunch', 'mysticpunch'), 1);
  assert.ok(scoreName('mystlcpunch', 'mysticpunch') > 0.9);
  assert.equal(scoreName('', 'x'), 0);
});

test('buildAugmentIndex dedupes by id and keeps rarity', () => {
  const idx = buildAugmentIndex([{ id: 1, name: 'Ab Cd', rarity: 'gold' }, { id: 1, name: 'Ab Cd', rarity: 'gold' }, { id: 2, name: 'Cde', rarity: null }, { id: 3, name: 'X', rarity: 'gold' }]);
  assert.equal(idx.length, 2, 'duplicate id dropped; 1-letter name dropped (norm shorter than 3)');
  assert.deepEqual(idx[0], { id: 1, name: 'Ab Cd', rarity: 'gold', norm: 'abcd' });
  assert.equal(idx[1].rarity, 'unknown');
});

test('slotForX thresholds', () => {
  assert.equal(slotForX(1000, 3440), 'left');
  assert.equal(slotForX(1720, 3440), 'center');
  assert.equal(slotForX(2500, 3440), 'right');
});

test('three clean titles → three cards in x order with rarity and confidence', () => {
  const lines = [line('Mystic Punch', L, Y), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.deepEqual(o.cards.map((c) => c.slot), ['left', 'center', 'right']);
  assert.deepEqual(o.cards.map((c) => c.augmentId), [idOf('Mystic Punch'), idOf('Zealot'), idOf('Final Form')]);
  assert.equal(o.cards[0].name, 'Mystic Punch');
  assert.equal(o.cards[0].ocrText, 'Mystic Punch');
  assert.ok(o.confidence > 0.99);
  assert.equal(o.rarity, aug[idOf('Mystic Punch')].rarity);
});

test('OCR typos still match; noise outside the band or wrong height is ignored', () => {
  const lines = [
    line('Mystlc Punch', L, Y), line('Zealot', C, Y), line('Flnal Form', R, Y),
    line('Mystic Punch', 100, 50),                // outside band (top-left HUD)
    line('Zealot', C, 1400),                      // outside band (bottom)
    line('Final Form', L, 700, 800, 120),         // too tall
    line('Final Form', R, 720, 60, 8),            // too small
    line('Deals 40% more damage to towers', L, 720, 400, 24), // body text, no name match
  ];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.deepEqual(o.cards.map((c) => c.name), ['Mystic Punch', 'Zealot', 'Final Form']);
  assert.ok(o.cards[0].score >= 0.8 && o.cards[0].score < 1);
});

test('a wrapped two-line title is merged within its column', () => {
  const name = entries.map((e) => e.name).find((n) => n.includes(': '));  // e.g. "Transmute: Chaos"
  const [a, b] = name.split(': ');
  const lines = [line(a + ':', L, Y, 160), line(b, L + 4, Y + 40, 120), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.cards[0].name, name);
  assert.equal(o.matched, 3);
});

test('two matches: the missing slot is null and confidence drops', () => {
  const lines = [line('Mystic Punch', L, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 2);
  assert.equal(o.cards[1].slot, 'center');
  assert.equal(o.cards[1].augmentId, null);
  assert.equal(o.cards[0].augmentId, idOf('Mystic Punch'));
  assert.ok(o.confidence < 0.7);
});

test('fewer than two matches → null', () => {
  assert.equal(matchOffer([line('Mystic Punch', L, Y)], index, FRAME), null);
  assert.equal(matchOffer([line('Buy Boots', L, Y), line('Recall', C, Y)], index, FRAME), null);
  assert.equal(matchOffer([], index, FRAME), null);
});

test('same name in two clusters keeps both; best score per cluster wins', () => {
  const lines = [line('Mystic Punch', L, Y), line('Mystic Punch', L + 10, Y + 60), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.equal(o.cards[0].name, 'Mystic Punch');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ocr/match.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/ocr/match.js`**

```js
// Pure: OCR lines → offered augment cards. No I/O.
export const BAND = Object.freeze({ x0: 0.15, x1: 0.85, y0: 0.20, y1: 0.75 });
export const TITLE_H = Object.freeze({ min: 0.009, max: 0.04 });   // fraction of frame height
export const CLUSTER_RADIUS = 0.06;                                 // fraction of frame width
const SLOTS = ['left', 'center', 'right'];

export function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function scoreName(norm, cand) {
  if (!norm || !cand) return 0;
  if (norm === cand) return 1;
  return 1 - levenshtein(norm, cand) / Math.max(norm.length, cand.length);
}

export function buildAugmentIndex(entries) {
  const seen = new Map();
  for (const e of entries ?? []) {
    const id = Number(e?.id);
    if (!Number.isInteger(id) || seen.has(id) || !e.name) continue;
    seen.set(id, { id, name: String(e.name), rarity: e.rarity ?? 'unknown', norm: normalizeText(e.name) });
  }
  return [...seen.values()].filter((e) => e.norm.length >= 3);
}

export function slotForX(cx, frameW) {
  const f = cx / frameW;
  return f < 0.42 ? 'left' : f > 0.58 ? 'right' : 'center';
}

function bestMatch(norm, index, minScore) {
  let best = null;
  for (const e of index) {
    const s = scoreName(norm, e.norm);
    if (s >= minScore && (!best || s > best.score || (s === best.score && e.norm.length > best.entry.norm.length))) best = { entry: e, score: s };
  }
  return best;
}

export function matchOffer(lines, index, { frameW, frameH, minScore = 0.8, band = BAND } = {}) {
  if (!frameW || !frameH || !Array.isArray(lines) || !index?.length) return null;
  const inBand = (l) => {
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    return cx >= band.x0 * frameW && cx <= band.x1 * frameW && cy >= band.y0 * frameH && cy <= band.y1 * frameH
      && l.h >= TITLE_H.min * frameH && l.h <= TITLE_H.max * frameH && normalizeText(l.text).length >= 3;
  };
  const cands = lines.filter(inBand).map((l) => ({ ...l, cx: l.x + l.w / 2, cy: l.y + l.h / 2 }));

  // x-clusters
  const clusters = [];
  for (const l of cands.sort((a, b) => a.cx - b.cx)) {
    const c = clusters.find((k) => Math.abs(k.cx - l.cx) <= CLUSTER_RADIUS * frameW);
    if (c) { c.lines.push(l); c.cx = c.lines.reduce((s, x) => s + x.cx, 0) / c.lines.length; }
    else clusters.push({ cx: l.cx, lines: [l] });
  }

  // best match per cluster, trying single lines and vertical pairs (wrapped titles)
  const scored = [];
  for (const c of clusters) {
    const ls = c.lines.sort((a, b) => a.cy - b.cy);
    let best = null;
    const consider = (text, x, y) => {
      const m = bestMatch(normalizeText(text), index, minScore);
      if (m && (!best || m.score > best.score)) best = { ...m, ocrText: text, x, y };
    };
    for (let i = 0; i < ls.length; i++) {
      consider(ls[i].text, ls[i].x, ls[i].y);
      if (i + 1 < ls.length && ls[i + 1].cy - ls[i].cy < ls[i].h * 1.8) consider(`${ls[i].text} ${ls[i + 1].text}`, ls[i].x, ls[i].y);
    }
    if (best) scored.push({ cx: c.cx, ...best });
  }
  if (scored.length < 2) return null;

  const top = scored.sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.cx - b.cx);
  const cards = SLOTS.map((slot) => ({ slot, augmentId: null, name: null, rarity: null, ocrText: null, score: 0, x: null, y: null }));
  const used = new Set();
  for (const m of top) {
    let slot = slotForX(m.cx, frameW);
    if (used.has(slot)) slot = SLOTS.find((s) => !used.has(s));
    if (!slot) break;
    used.add(slot);
    cards[SLOTS.indexOf(slot)] = { slot, augmentId: m.entry.id, name: m.entry.name, rarity: m.entry.rarity, ocrText: m.ocrText, score: m.score, x: m.x, y: m.y };
  }
  const matched = cards.filter((c) => c.augmentId != null);
  const tally = {};
  for (const c of matched) tally[c.rarity] = (tally[c.rarity] || 0) + 1;
  const rarity = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  const confidence = (matched.reduce((s, c) => s + c.score, 0) / matched.length) * (matched.length / 3);
  return { cards, rarity, confidence, matched: matched.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ocr/match.test.js`
Expected: 9 passing. If the "wrapped title" test cannot find a name containing `': '` in the fixture, pick any two-word name and split on the space instead — adjust the test, not the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/ocr/match.js test/ocr/match.test.js
git commit -m "feat: ocr line to augment offer matching"
```

---

### Task 3: Advice (pure)

**Files:**
- Create: `src/ocr/advice.js`, `test/ocr/advice.test.js`

**Interfaces:**
- Consumes: `matchOffer` result (Task 2), `shapeAugments`/`compareRows` from `src/rank/augments.js`, `ChampData`.
- Produces: `advise(match, champData, { stage = 'auto', level = null }) → { cards: [{ ...card, row: Row|null, verdict: 'pick'|'reroll'|'keep'|'unread' }], pickSlot: 'left'|'center'|'right'|null, note: string|null, stageUsed: 1|2|3|4|'all'|null }`.

- [ ] **Step 1: Write the failing test** `test/ocr/advice.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advise } from '../../src/ocr/advice.js';

const row = (id, over) => ({ id, name: `A${id}`, rarity: 'gold', tier: 'B', rank: 1, winRate: 0.55, pickRate: 0.1, games: 5000, globalWinRate: 0.5, icon: null, ...over });
const champ = (rows) => ({ champion: { id: 1, winRate: 0.5 }, augments: { all: rows, stages: { 1: [], 2: [], 3: [], 4: [] } } });
const card = (slot, augmentId) => ({ slot, augmentId, name: augmentId ? `A${augmentId}` : null, rarity: 'gold', ocrText: 'x', score: 0.9, x: 1, y: 1 });
const match = (ids) => ({ cards: ['left', 'center', 'right'].map((s, i) => card(s, ids[i])), rarity: 'gold', confidence: 0.9, matched: ids.filter(Boolean).length });

test('best card is pick; weak card is reroll; decent card is keep', () => {
  const d = champ([row(1, { tier: 'S', winRate: 0.6 }), row(2, { tier: 'B', winRate: 0.55 }), row(3, { tier: 'D', winRate: 0.4 })]);
  const a = advise(match([1, 2, 3]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'keep', 'reroll']);
  assert.equal(a.pickSlot, 'left');
  assert.equal(a.note, null);
  assert.equal(a.cards[0].row.id, 1);
  assert.equal(a.stageUsed, 'all');
});

test('negative lift makes a non-best card reroll', () => {
  const d = champ([row(1, { tier: 'A', winRate: 0.58 }), row(2, { tier: 'B', winRate: 0.48, globalWinRate: 0.5 })]);
  const a = advise(match([1, 2, null]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'reroll', 'unread']);
});

test('all weak → reroll all with note, no pick', () => {
  const d = champ([row(1, { tier: 'C' }), row(2, { tier: 'D' }), row(3, { tier: null })]);
  const a = advise(match([1, 2, 3]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['reroll', 'reroll', 'reroll']);
  assert.equal(a.pickSlot, null);
  assert.equal(a.note, 'Reroll all, then pick the best');
});

test('card known by name but absent from champion data is keep; no data at all → note', () => {
  const d = champ([row(1, { tier: 'A' })]);
  const a = advise(match([1, 99, null]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'keep', 'unread']);
  assert.equal(a.cards[1].row, null);
  const none = advise(match([98, 99, null]), d);
  assert.equal(none.pickSlot, null);
  assert.equal(none.note, 'No data for these augments');
  const noChamp = advise(match([1, 2, 3]), null);
  assert.equal(noChamp.note, 'Champion data not loaded');
  assert.equal(noChamp.stageUsed, null);
});

test('stage rows are used when the stage has data', () => {
  const d = champ([row(1, { tier: 'D' }), row(2, { tier: 'A' })]);
  d.augments.stages[2] = [row(1, { tier: 'S' }), row(2, { tier: 'C' })];
  const a = advise(match([1, 2, null]), d, { stage: 'auto', level: 8 });
  assert.equal(a.stageUsed, 2);
  assert.equal(a.pickSlot, 'left');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ocr/advice.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/ocr/advice.js`**

```js
import { shapeAugments, compareRows } from '../rank/augments.js';

const WEAK = new Set(['C', 'D']);
const isWeak = (row) => row.tier == null || WEAK.has(row.tier);

export function advise(match, champData, { stage = 'auto', level = null } = {}) {
  const shaped = champData ? shapeAugments(champData, { stage, level }) : null;
  const rowsById = new Map();
  if (shaped) for (const col of [...Object.values(shaped.columns), shaped.unknown]) for (const r of col) rowsById.set(r.id, r);

  const cards = match.cards.map((c) => ({
    ...c,
    row: c.augmentId != null ? rowsById.get(c.augmentId) ?? null : null,
    verdict: c.augmentId != null ? 'keep' : 'unread',
  }));
  const withRows = cards.filter((c) => c.row);
  if (withRows.length === 0) {
    return { cards, pickSlot: null, note: shaped ? 'No data for these augments' : 'Champion data not loaded', stageUsed: shaped ? shaped.stageUsed : null };
  }
  const best = withRows.slice().sort((a, b) => compareRows(a.row, b.row))[0];
  const rerollAll = isWeak(best.row);
  for (const c of cards) {
    if (!c.row) continue;
    if (rerollAll) c.verdict = 'reroll';
    else if (c === best) c.verdict = 'pick';
    else c.verdict = isWeak(c.row) || (c.row.lift != null && c.row.lift < 0) ? 'reroll' : 'keep';
  }
  return { cards, pickSlot: rerollAll ? null : best.slot, note: rerollAll ? 'Reroll all, then pick the best' : null, stageUsed: shaped.stageUsed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ocr/advice.test.js`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/ocr/advice.js test/ocr/advice.test.js
git commit -m "feat: offer pick and reroll advice"
```

---

### Task 4: Config options + AppState offer/ocr fields

**Files:**
- Modify: `src/config.js`, `test/config.test.js`, `src/server/state.js`, `test/server/state.test.js`

**Interfaces:**
- Consumes: existing `loadConfig`, `createAppState`, `buildPayload`.
- Produces: config fields `ocrEnabled: boolean`, `ocrIdleMs`, `ocrActiveMs`, `ocrRegion: 'band'|'full'`, `ocrDebug: boolean`; `loadConfig({ env, argv, platform = process.platform })`.
  State additions: `EMPTY_OCR`, `state.setOffer(offer|null)`, `state.getOffer()`, `state.setOcrStatus(patch)`, `state.getChampData() → ChampData|null` (only when its champion id equals the current game's), payload fields `offer` and `ocr`. Offer is cleared automatically when the game phase leaves `ingame`.

- [ ] **Step 1: Add failing config tests** (append to `test/config.test.js`)

```js
test('ocr defaults depend on platform', () => {
  assert.equal(loadConfig({ env: {}, argv: [], platform: 'win32' }).ocrEnabled, true);
  assert.equal(loadConfig({ env: {}, argv: [], platform: 'linux' }).ocrEnabled, false);
  const c = loadConfig({ env: {}, argv: [], platform: 'win32' });
  assert.equal(c.ocrIdleMs, 1500);
  assert.equal(c.ocrActiveMs, 500);
  assert.equal(c.ocrRegion, 'band');
  assert.equal(c.ocrDebug, false);
});

test('ocr overrides from env and argv', () => {
  const c = loadConfig({ env: { OCR_ENABLED: 'false', OCR_IDLE_MS: '2000', OCR_ACTIVE_MS: '250', OCR_REGION: 'full', OCR_DEBUG: '1' }, argv: [], platform: 'win32' });
  assert.equal(c.ocrEnabled, false);
  assert.equal(c.ocrIdleMs, 2000);
  assert.equal(c.ocrActiveMs, 250);
  assert.equal(c.ocrRegion, 'full');
  assert.equal(c.ocrDebug, true);
  const d = loadConfig({ env: { OCR_ENABLED: '0' }, argv: ['--ocr=true', '--ocr-debug'], platform: 'linux' });
  assert.equal(d.ocrEnabled, true);
  assert.equal(d.ocrDebug, true);
  assert.throws(() => loadConfig({ env: { OCR_REGION: 'left' }, argv: [], platform: 'win32' }), /Invalid ocr region/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.js`
Expected: the two new tests FAIL (`ocrEnabled` undefined).

- [ ] **Step 3: Extend `src/config.js`**

Add to `DEFAULTS`: `ocrIdleMs: 1500, ocrActiveMs: 500, ocrRegion: 'band', ocrDebug: false` (no `ocrEnabled` default — it depends on platform). Change the signature to `export function loadConfig({ env = {}, argv = [], platform = process.platform } = {})` and add before `return c;`:

```js
  const bool = (v) => !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
  c.ocrEnabled = platform === 'win32';
  const ocr = pick('ocr', 'OCR_ENABLED');
  if (ocr !== undefined) c.ocrEnabled = bool(ocr);
  const idle = pick('ocr-idle-ms', 'OCR_IDLE_MS');
  if (idle !== undefined) c.ocrIdleMs = positiveInt(idle, 'ocr-idle-ms');
  const active = pick('ocr-active-ms', 'OCR_ACTIVE_MS');
  if (active !== undefined) c.ocrActiveMs = positiveInt(active, 'ocr-active-ms');
  const region = pick('ocr-region', 'OCR_REGION');
  if (region !== undefined) {
    if (!['band', 'full'].includes(region)) throw new Error(`Invalid ocr region: ${region}`);
    c.ocrRegion = region;
  }
  const debug = pick('ocr-debug', 'OCR_DEBUG');
  if (debug !== undefined) c.ocrDebug = bool(debug);
```

(`--ocr` alone parses as `'true'` via `parseArgs`, which `bool` accepts.)

- [ ] **Step 4: Run config tests**

Run: `node --test test/config.test.js`
Expected: all passing (previous 5 + 2).

- [ ] **Step 5: Add failing state tests** (append to `test/server/state.test.js`; it already imports `createAppState`, `buildPayload`, `EMPTY_GAME`, `yasuo`, `fakeRepo`, `game`)

```js
test('payload carries offer and ocr with safe defaults', () => {
  const p = buildPayload({ game: EMPTY_GAME, loading: false, champData: null, view: { stage: 'auto', bracket: 'all' }, source: null, stale: false, errors: [] });
  assert.equal(p.offer, null);
  assert.deepEqual(p.ocr, { enabled: false, running: false, lastCaptureMs: null, lastCaptureAt: null, lastError: null });
});

test('setOffer shows in snapshot and clears when the phase leaves ingame', async () => {
  const s = createAppState({ repository: fakeRepo() });
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 7 }));
  const offer = { detectedAt: 1, cards: [], pickSlot: null, note: null };
  s.setOffer(offer);
  assert.equal(s.snapshot().offer, offer);
  assert.equal(s.getOffer(), offer);
  await s.setGame(game({ phase: 'ingame', championId: 157, level: 8 }));
  assert.equal(s.snapshot().offer, offer, 'level change keeps the offer');
  await s.setGame(game({ phase: 'none', championId: 157 }));
  assert.equal(s.snapshot().offer, null);
});

test('setOcrStatus merges partial updates', () => {
  const s = createAppState({ repository: fakeRepo() });
  s.setOcrStatus({ enabled: true });
  s.setOcrStatus({ lastCaptureMs: 210, lastError: 'x' });
  assert.deepEqual(s.snapshot().ocr, { enabled: true, running: false, lastCaptureMs: 210, lastCaptureAt: null, lastError: 'x' });
});

test('getChampData returns data only for the current champion', async () => {
  const s = createAppState({ repository: fakeRepo() });
  assert.equal(s.getChampData(), null);
  await s.setGame(game({ championId: 157 }));
  assert.equal(s.getChampData().champion.id, 157);
  await s.setGame(game({ championId: 62 }));
  assert.equal(s.getChampData().champion.id, 62);
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `node --test test/server/state.test.js`
Expected: new tests FAIL (`offer` undefined / `setOffer` not a function).

- [ ] **Step 7: Modify `src/server/state.js`**

Add after the imports:
```js
export const EMPTY_OCR = Object.freeze({ enabled: false, running: false, lastCaptureMs: null, lastCaptureAt: null, lastError: null });
```
Change `buildPayload`'s parameter list to `({ game, loading, champData, view, source, stale, errors, offer = null, ocr = EMPTY_OCR })` and add `offer,` and `ocr,` to the returned object (after `errors`).

Inside `createAppState`, add state:
```js
  let offer = null;
  let ocr = { ...EMPTY_OCR };
```
In `setGame`, after `game = { ...next };` add:
```js
      if (game.phase !== 'ingame') offer = null;
```
Pass `offer` and `ocr` into `buildPayload` inside `snapshot()` (`offer, ocr: { ...ocr }`), and add to the returned object:
```js
    getChampData: () => (current && current.id === game.championId ? current.data : null),
    getOffer: () => offer,
    setOffer(next) { offer = next ?? null; },
    setOcrStatus(patch = {}) { ocr = { ...ocr, ...patch }; },
```
(`preview()` keeps `offer: null`, default.)

- [ ] **Step 8: Run state tests, then the suite, then commit**

Run: `node --test test/server/state.test.js` → all passing. `npm test` → all passing.
```bash
git add src/config.js test/config.test.js src/server/state.js test/server/state.test.js
git commit -m "feat: ocr config options and offer state"
```

---

### Task 5: Offer watcher (loop, gating, debounce)

**Files:**
- Create: `src/ocr/watcher.js`, `test/ocr/watcher.test.js`

**Interfaces:**
- Consumes: worker (Task 1: `isAvailable()`, `lastError()`, `capture({ region, saveTo })`), `matchOffer`/`buildAugmentIndex` (Task 2), `advise` (Task 3), state (Task 4: `getGame()`, `getView()`, `getChampData()`, `setOffer()`, `setOcrStatus()`, `pushError()`).
- Produces: `createOfferWatcher({ worker, state, getExtraAugments = () => [], now?, setTimer = setTimeout, clearTimer = clearTimeout, idleMs = 1500, activeMs = 500, region = 'band', debugDir = null, fs = null, path = null, log? }) → { tick(), start(), stop(), setEnabled(bool), isEnabled(), captureOnce({ region?, save? }) → { capture, match, advice, savedTo } }`.
- Published `Offer` = `{ detectedAt, frames, stage, rarity, confidence, cards, pickSlot, note }`.

- [ ] **Step 1: Write the failing test** `test/ocr/watcher.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOfferWatcher } from '../../src/ocr/watcher.js';

const FRAME = { w: 3440, h: 1440 };
const rows = [
  { id: 1, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1, winRate: 0.65, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 2, name: 'Final Form', rarity: 'prismatic', tier: 'B', rank: 2, winRate: 0.55, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 3, name: 'Clown College', rarity: 'prismatic', tier: 'D', rank: 3, winRate: 0.45, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
  { id: 4, name: 'Zealot', rarity: 'gold', tier: 'A', rank: 1, winRate: 0.6, pickRate: 0.1, games: 9000, globalWinRate: 0.5, icon: null },
];
const champData = { champion: { id: 157, winRate: 0.5 }, augments: { all: rows, stages: { 1: [], 2: [], 3: [], 4: [] } } };
const titles = (a, b, c) => ({ ok: true, ...FRAME, window: true, ms: 200, lines: [a, b, c].filter(Boolean).map((t, i) => ({ text: t, x: 1180 + i * 430, y: 640, w: 220, h: 34 })) });
const EMPTY = { ok: true, ...FRAME, window: true, ms: 200, lines: [] };

function setup({ phase = 'ingame', level = 7, available = true, frames = [], enabled = true } = {}) {
  const queue = frames.slice();
  const captures = [];
  const worker = { isAvailable: () => available, lastError: () => (available ? null : 'dead'), capture: async (o) => { captures.push(o); return queue.length ? queue.shift() : EMPTY; } };
  const st = { game: { phase, level, championId: 157 }, view: { stage: 'auto', bracket: 'all' }, offers: [], statuses: [], errors: [] };
  const state = {
    getGame: () => st.game, getView: () => st.view, getChampData: () => champData,
    setOffer: (o) => st.offers.push(o), setOcrStatus: (p) => st.statuses.push(p), pushError: (scope, m) => st.errors.push(`${scope}: ${m}`),
  };
  const timers = [];
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const w = createOfferWatcher({ worker, state, setTimer, clearTimer: () => {}, now: () => 1000, idleMs: 1500, activeMs: 500 });
  w.setEnabled(enabled);
  return { w, st, captures, timers, queue };
}

test('not in game: no capture, status updated, no offer', async () => {
  const { w, st, captures } = setup({ phase: 'none' });
  await w.tick();
  assert.equal(captures.length, 0);
  assert.deepEqual(st.offers, []);
  assert.equal(st.statuses.at(-1).enabled, true);
});

test('disabled or unavailable worker: no capture', async () => {
  const a = setup({ enabled: false }); await a.w.tick(); assert.equal(a.captures.length, 0);
  const b = setup({ available: false }); await b.w.tick(); assert.equal(b.captures.length, 0);
  assert.equal(b.st.statuses.at(-1).lastError, 'dead');
});

test('two agreeing frames publish one offer with advice; a third identical frame does not republish', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f, f] });
  await w.tick(); assert.equal(st.offers.length, 0);
  await w.tick(); assert.equal(st.offers.length, 1);
  await w.tick(); assert.equal(st.offers.length, 1);
  const o = st.offers[0];
  assert.equal(o.frames, 2);
  assert.equal(o.rarity, 'prismatic');
  assert.equal(o.pickSlot, 'left');
  assert.deepEqual(o.cards.map((c) => c.verdict), ['pick', 'keep', 'reroll']);
  assert.equal(o.detectedAt, 1000);
  assert.equal(o.stage, 'all');
});

test('a different offer replaces the published one after two agreeing frames', async () => {
  const f1 = titles('Mystic Punch', 'Final Form', 'Clown College');
  const f2 = titles('Zealot', 'Final Form', null);
  const { w, st } = setup({ frames: [f1, f1, f2, f2] });
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(st.offers.length, 2);
  assert.equal(st.offers[1].cards[0].name, 'Zealot');
  assert.equal(st.offers[1].cards[2].verdict, 'unread');
});

test('two frames without a match clear the offer; one does not', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f, EMPTY, f, EMPTY, EMPTY] });
  await w.tick(); await w.tick();
  assert.equal(st.offers.length, 1);
  await w.tick(); assert.equal(st.offers.length, 1, 'single empty frame ignored');
  await w.tick(); assert.equal(st.offers.length, 1, 'same offer again, no republish');
  await w.tick(); await w.tick();
  assert.equal(st.offers.at(-1), null);
});

test('capture failure records one error per distinct message and status lastError', async () => {
  const bad = { ok: false, error: 'timeout', lines: [] };
  const { w, st } = setup({ frames: [bad, bad, { ok: false, error: 'worker exited (1)', lines: [] }] });
  await w.tick(); await w.tick(); await w.tick();
  assert.deepEqual(st.errors, ['ocr: capture failed: timeout', 'ocr: capture failed: worker exited (1)']);
  assert.equal(st.statuses.at(-1).lastError, 'worker exited (1)');
});

test('cadence: idle delay until an offer is published, then active delay', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, timers, queue } = setup({ frames: [] });
  w.start();
  assert.equal(timers[0].ms, 1500);
  queue.push(f, f);
  await w.tick(); await w.tick();
  await timers[0].fn();            // scheduled tick runs and reschedules
  assert.equal(timers.at(-1).ms, 500);
  w.stop();
});

test('captureOnce returns capture, match and advice without publishing', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st, captures } = setup({ frames: [f] });
  const r = await w.captureOnce({ region: 'full' });
  assert.equal(captures[0].region, 'full');
  assert.equal(r.capture.ok, true);
  assert.equal(r.match.matched, 3);
  assert.equal(r.advice.pickSlot, 'left');
  assert.equal(r.savedTo, null);
  assert.deepEqual(st.offers, []);
});

test('phase leaving ingame clears a published offer on the next tick', async () => {
  const f = titles('Mystic Punch', 'Final Form', 'Clown College');
  const { w, st } = setup({ frames: [f, f] });
  await w.tick(); await w.tick();
  st.game = { phase: 'none', level: null, championId: 157 };
  await w.tick();
  assert.equal(st.offers.at(-1), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ocr/watcher.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/ocr/watcher.js`**

```js
import { matchOffer, buildAugmentIndex } from './match.js';
import { advise } from './advice.js';

export function createOfferWatcher({
  worker, state, getExtraAugments = () => [], now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  idleMs = 1500, activeMs = 500, region = 'band',
  debugDir = null, fs = null, path = null, log = () => {},
}) {
  let enabled = false;
  let stopped = true;
  let timer = null;
  let busy = false;
  let lastKey = null;
  let agree = 0;
  let noMatch = 0;
  let publishedKey = null;
  let lastErrorMessage = null;
  let indexCache = { data: undefined, extra: undefined, index: [] };

  function indexFor(champData) {
    const extra = getExtraAugments();
    if (indexCache.data === champData && indexCache.extra === extra) return indexCache.index;
    const entries = [
      ...((champData && champData.augments && champData.augments.all) || []).map((r) => ({ id: r.id, name: r.name, rarity: r.rarity })),
      ...(extra || []),
    ];
    indexCache = { data: champData, extra, index: buildAugmentIndex(entries) };
    return indexCache.index;
  }

  function status(patch = {}) {
    state.setOcrStatus({ enabled, running: !stopped && enabled && worker.isAvailable(), ...patch });
  }

  function clearOffer() {
    if (publishedKey) { publishedKey = null; state.setOffer(null); }
    lastKey = null; agree = 0; noMatch = 0;
  }

  function reportError(message) {
    if (message !== lastErrorMessage) { lastErrorMessage = message; state.pushError('ocr', message); }
    status({ lastError: message.replace(/^capture failed: /, '') });
  }

  function adviceFor(match, champData) {
    const game = state.getGame();
    return advise(match, champData, { stage: state.getView().stage, level: game.level });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const game = state.getGame();
      if (!enabled || !worker.isAvailable() || game.phase !== 'ingame') {
        clearOffer();
        status({ lastError: worker.isAvailable() ? null : worker.lastError() });
        return;
      }
      const cap = await worker.capture({ region });
      status({ lastCaptureMs: cap.ok ? cap.ms : null, lastCaptureAt: now(), lastError: cap.ok ? null : cap.error });
      if (!cap.ok) { reportError(`capture failed: ${cap.error}`); return; }
      lastErrorMessage = null;
      const champData = state.getChampData();
      const match = matchOffer(cap.lines, indexFor(champData), { frameW: cap.w, frameH: cap.h });
      if (!match) { noMatch++; if (noMatch >= 2) clearOffer(); return; }
      noMatch = 0;
      const key = match.cards.map((c) => c.augmentId ?? '-').join(',');
      if (key === lastKey) agree++; else { lastKey = key; agree = 1; }
      if (agree >= 2 && key !== publishedKey) {
        const a = adviceFor(match, champData);
        publishedKey = key;
        state.setOffer({ detectedAt: now(), frames: agree, stage: a.stageUsed, rarity: match.rarity, confidence: match.confidence, cards: a.cards, pickSlot: a.pickSlot, note: a.note });
        log(`[ocr] offer: ${a.cards.map((c) => `${c.slot}=${c.name ?? '?'}:${c.verdict}`).join(' ')}${a.note ? ` (${a.note})` : ''}`);
        if (debugDir && fs && path) fs.writeFile(path.join(debugDir, `offer-${now()}.json`), JSON.stringify({ capture: cap, match }, null, 2)).catch(() => {});
      }
    } catch (e) {
      reportError(e && e.message ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    // The callback returns the promise so tests can `await timers[i].fn()`.
    timer = setTimer(() => tick().finally(schedule), publishedKey ? activeMs : idleMs);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      if (debugDir && fs) fs.mkdir(debugDir, { recursive: true }).catch(() => {});
      status();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      clearOffer();
      status({ running: false });
    },
    setEnabled(v) { enabled = !!v; if (!enabled) clearOffer(); status(); },
    isEnabled: () => enabled,
    async captureOnce({ region: r = region, save = false } = {}) {
      let saveTo = null;
      if (save && debugDir && fs && path) {
        await fs.mkdir(debugDir, { recursive: true });
        saveTo = path.join(debugDir, `capture-${now()}.png`);
      }
      const cap = await worker.capture({ region: r, saveTo });
      const champData = state.getChampData();
      const match = cap.ok ? matchOffer(cap.lines, indexFor(champData), { frameW: cap.w, frameH: cap.h }) : null;
      if (saveTo) await fs.writeFile(saveTo.replace(/\.png$/, '.json'), JSON.stringify({ capture: cap, match }, null, 2));
      return { capture: cap, match, advice: match ? adviceFor(match, champData) : null, savedTo: saveTo };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ocr/watcher.test.js`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/ocr/watcher.js test/ocr/watcher.test.js
git commit -m "feat: offer watcher with phase gating and frame debounce"
```

---

### Task 6: HTTP routes + main wiring

**Files:**
- Modify: `src/server/http.js`, `test/server/http.test.js`, `src/main.js`

**Interfaces:**
- Consumes: watcher (Task 5), worker (Task 1), config (Task 4), state (Task 4).
- Produces: `createServer({ state, champIndex, publicDir, watcher = null })`; routes `POST /api/ocr/capture` body `{ region?: 'band'|'full', save?: boolean }` → `{ capture, match, advice, savedTo }` (200 when the capture succeeded, 502 when not, 503 when no watcher); `POST /api/ocr` body `{ enabled: boolean }` → snapshot (400 when `enabled` is not boolean, 503 when no watcher).

- [ ] **Step 1: Add failing http tests** (append to `test/server/http.test.js`; the file already has `base`, `get`, `post`, `state`, `champIndex`, `publicDir` and a running `server` — add a second server that has a watcher)

```js
const watcherCalls = [];
let captureOk = true;
const fakeWatcher = {
  captureOnce: async (o) => { watcherCalls.push(['capture', o]); return { capture: { ok: captureOk, error: captureOk ? undefined : 'boom', lines: [] }, match: null, advice: null, savedTo: o.save ? 'data/debug/x.png' : null }; },
  setEnabled: (v) => { watcherCalls.push(['enabled', v]); },
};
const server2 = createServer({ state, champIndex, publicDir, watcher: fakeWatcher });
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${server2.address().port}`;
after(() => server2.close());
const post2 = async (p, body) => { const r = await fetch(base2 + p, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test('POST /api/ocr/capture and /api/ocr without a watcher → 503', async () => {
  assert.equal((await post('/api/ocr/capture', {})).status, 503);
  assert.equal((await post('/api/ocr', { enabled: true })).status, 503);
});

test('POST /api/ocr/capture forwards region and save; unknown region falls back to band', async () => {
  const ok = await post2('/api/ocr/capture', { region: 'full', save: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.savedTo, 'data/debug/x.png');
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'full', save: true }]);
  const dflt = await post2('/api/ocr/capture', {});
  assert.equal(dflt.status, 200);
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'band', save: false }]);
  await post2('/api/ocr/capture', { region: 'left', save: 'yes' });
  assert.deepEqual(watcherCalls.at(-1), ['capture', { region: 'band', save: false }]);
});

test('POST /api/ocr/capture maps a failed capture to 502', async () => {
  captureOk = false;
  const r = await post2('/api/ocr/capture', {});
  captureOk = true;
  assert.equal(r.status, 502);
  assert.equal(r.body.capture.error, 'boom');
});

test('POST /api/ocr toggles the watcher and validates the body', async () => {
  const r = await post2('/api/ocr', { enabled: false });
  assert.equal(r.status, 200);
  assert.deepEqual(watcherCalls.at(-1), ['enabled', false]);
  assert.equal((await post2('/api/ocr', { enabled: 'yes' })).status, 400);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/server/http.test.js`
Expected: new tests FAIL (404 instead of 503/200).

- [ ] **Step 3: Modify `src/server/http.js`**

Change the signature to `export function createServer({ state, champIndex, publicDir, watcher = null })` and add these routes before the final `return send(res, 404, …)`:

```js
      if (req.method === 'POST' && p === '/api/ocr/capture') {
        if (!watcher) return send(res, 503, { error: 'OCR not configured' });
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await watcher.captureOnce({ region: body.region === 'full' ? 'full' : 'band', save: body.save === true });
        return send(res, result.capture && result.capture.ok ? 200 : 502, result);
      }
      if (req.method === 'POST' && p === '/api/ocr') {
        if (!watcher) return send(res, 503, { error: 'OCR not configured' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
        watcher.setEnabled(body.enabled);
        return send(res, 200, state.snapshot());
      }
```

- [ ] **Step 4: Run http tests**

Run: `node --test test/server/http.test.js` → all passing.

- [ ] **Step 5: Wire `src/main.js`**

Add imports next to the other `./game/...` imports:
```js
import { createOcrWorker } from './ocr/worker.js';
import { createOfferWatcher } from './ocr/watcher.js';
```
Immediately after the line `detector.start();` insert:
```js
  let extraAugments = [];
  try {
    const res = await aramkit.resources();
    extraAugments = Object.entries(res.augments ?? {}).map(([id, a]) => ({ id: Number(id), name: a.name, rarity: a.rarity }));
  } catch { /* names come from champion data only */ }
  const ocrWorker = createOcrWorker({ log });
  const watcher = createOfferWatcher({
    worker: ocrWorker, state, getExtraAugments: () => extraAugments,
    idleMs: cfg.ocrIdleMs, activeMs: cfg.ocrActiveMs, region: cfg.ocrRegion,
    debugDir: cfg.ocrDebug ? path.join('data', 'debug') : null, fs, path, log,
  });
  watcher.setEnabled(cfg.ocrEnabled);
  watcher.start();
  log(`ocr: enabled=${cfg.ocrEnabled} available=${ocrWorker.isAvailable()} region=${cfg.ocrRegion}`);
```
Change `createServer({ state, champIndex, publicDir: … })` to include `watcher`, and change the returned `stop` to `stop: () => { watcher.stop(); ocrWorker.stop(); detector.stop(); server.close(); }`. (`fs` here is the `promises` API already imported for the lockfile; `path` is already imported.)

- [ ] **Step 6: Smoke test**

Run: `node src/main.js --port 3777` → log shows `ocr: enabled=true available=true region=band`. Then:
```
curl -s -X POST http://localhost:3777/api/ocr/capture -d "{}"
```
Expected: JSON with `capture.ok: true`, `capture.lines` (whatever is on screen), `match: null` (no game). `curl -s http://localhost:3777/api/state` shows `ocr.enabled: true`, `ocr.running: true`. `curl -s -X POST http://localhost:3777/api/ocr -d "{\"enabled\":false}"` → `ocr.enabled: false`. Ctrl+C exits cleanly (no orphan `powershell.exe`: check with `tasklist | findstr powershell` before/after).

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` → all passing.
```bash
git add src/server/http.js test/server/http.test.js src/main.js
git commit -m "feat: ocr routes and watcher wiring"
```

---

### Task 7: Offer view UI, augment descriptions, README

**Files:**
- Modify: `src/data/aramkit/normalize.js`, `test/data/aramkit/normalize.test.js`, `public/index.html`, `public/style.css`, `public/app.js`, `README.md`

**Interfaces:**
- Consumes: payload `offer` (Task 5 shape) and `ocr` (Task 4).
- Produces: `AugmentRow.description: string|null` from the aramkit tooltip; offer view in the page.

- [ ] **Step 1: Failing normalizer test** — in `test/data/aramkit/normalize.test.js`, change the Mystic Punch assertion so it tolerates the new field and checks it:

```js
  const { description, ...rest } = data.augments.all.find((a) => a.id === 1058);
  assert.deepEqual(rest, {
    id: 1058, name: 'Mystic Punch', rarity: 'prismatic', tier: 'S', rank: 1,
    winRate: 0.6517, pickRate: 0.1477, games: 112923, globalWinRate: 0.5128,
    icon: 'https://data.aramkit.com/assets/augment/1058-9450203898b2.webp',
  });
  assert.equal(typeof description, 'string');
  assert.ok(description.length > 20);
```
And in the "unknown resource ids degrade" test add `assert.equal(mp.description, null);`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/data/aramkit/normalize.test.js` → the two edited tests FAIL (`description` undefined).

- [ ] **Step 3: Implement in `src/data/aramkit/normalize.js`**

Add a helper above `normalizeAramkit`:
```js
// Flatten aramkit tooltip blocks ({ blocks: [{ spans: [{ text }] }] }) to plain text.
export function flattenTooltip(tooltip) {
  const blocks = tooltip && Array.isArray(tooltip.blocks) ? tooltip.blocks : [];
  const text = blocks.map((b) => (Array.isArray(b.spans) ? b.spans.map((s) => s.text ?? '').join('') : '')).join(' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}
```
In `augRow`, add `description: flattenTooltip(r?.tooltip),` after `icon`.

- [ ] **Step 4: Run normalizer tests** → all passing. Also run `node --test test/rank/augments.test.js test/server/state.test.js` (rows are spread through, nothing else asserts exact row shape).

- [ ] **Step 5: `public/index.html`** — add the offer section between `</header>` and `<main id="main">`:

```html
  <section id="offer" hidden>
    <div class="offer-head">
      <div id="offer-title">Augment offer</div>
      <div id="offer-meta" class="muted"></div>
      <div class="spacer"></div>
      <button id="offer-dismiss">Show list</button>
    </div>
    <div id="offer-note" class="offer-note" hidden></div>
    <div id="offer-cards" class="offer-cards"></div>
  </section>
```
Also add an OCR status chip into the header controls row, after `#meta`: `<span id="ocr-chip" class="chip" hidden></span>`.

- [ ] **Step 6: `public/style.css`** — append:

```css
.chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #2c343f; color: var(--muted); }
.chip.on { color: var(--good); } .chip.err { color: var(--bad); }
#offer { padding: 12px 14px; }
.offer-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
#offer-title { font-size: 20px; font-weight: 700; }
.offer-note { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; background: #4a3a1f; color: #ffe2a8; font-weight: 600; }
.offer-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.card { position: relative; border-radius: 14px; padding: 18px 16px 16px; background: linear-gradient(180deg, #1b2129, #12161c); border: 3px solid var(--silver); min-height: 420px; display: flex; flex-direction: column; align-items: center; text-align: center; }
.card.gold { border-color: var(--gold); }
.card.prismatic { border-image: linear-gradient(135deg, #7fe3ff, #c86bff, #7fe3ff) 1; }
.card.pick { box-shadow: 0 0 0 3px #fff, 0 0 28px rgba(79, 209, 139, .6); }
.card.reroll { opacity: .78; }
.card.unread { border-style: dashed; opacity: .6; }
.card img.icon { width: 96px; height: 96px; border-radius: 12px; margin: 6px 0 10px; }
.card .name { font-size: 22px; font-weight: 800; margin-bottom: 8px; }
.card .desc { color: var(--muted); font-size: 14px; line-height: 1.35; max-height: 7.5em; overflow: hidden; }
.card .stats { margin-top: auto; padding-top: 12px; font-size: 15px; display: flex; gap: 10px; align-items: center; }
.card .stats .wr { font-size: 22px; font-weight: 800; }
.ribbon { position: absolute; top: -14px; left: 50%; transform: translateX(-50%); padding: 4px 14px; border-radius: 8px; font-weight: 800; letter-spacing: .06em; }
.ribbon.pick { background: var(--good); color: #062; } .ribbon.reroll { background: var(--bad); color: #fff; } .ribbon.keep { background: #2c343f; color: var(--muted); } .ribbon.unread { background: #2c343f; color: var(--muted); }
.card .ocr { margin-top: 6px; font-size: 12px; color: var(--muted); }
```

- [ ] **Step 7: `public/app.js`** — offer rendering. Add near the other `let` state: `let dismissedOfferAt = null;`. In `render(p, state)`, add at the end:

```js
  renderOcrChip(p.ocr);
  const offer = p.offer;
  const showOffer = offer && dismissedOfferAt !== offer.detectedAt;
  $('#offer').hidden = !showOffer;
  $('#main').hidden = !!showOffer;
  if (showOffer) renderOffer(offer);
```
Add the two functions:

```js
function renderOcrChip(o) {
  const el = $('#ocr-chip');
  if (!o) { el.hidden = true; return; }
  el.hidden = false;
  if (!o.enabled) { el.textContent = 'OCR off'; el.className = 'chip'; return; }
  if (o.lastError) { el.textContent = `OCR: ${o.lastError}`; el.className = 'chip err'; return; }
  el.textContent = o.running ? `OCR on${o.lastCaptureMs != null ? ` · ${o.lastCaptureMs} ms` : ''}` : 'OCR idle';
  el.className = 'chip on';
}

function renderOffer(o) {
  const stage = o.stage && o.stage !== 'all' ? `Stage ${o.stage} · ` : '';
  $('#offer-title').textContent = `${stage}${o.rarity === 'unknown' ? '' : o.rarity[0].toUpperCase() + o.rarity.slice(1) + ' '}offer`;
  $('#offer-meta').textContent = `confidence ${Math.round((o.confidence ?? 0) * 100)} % · ${o.frames} frames`;
  $('#offer-note').hidden = !o.note;
  $('#offer-note').textContent = o.note ?? '';
  $('#offer-cards').innerHTML = o.cards.map((c) => {
    const r = c.row;
    const rarity = c.rarity ?? o.rarity ?? 'silver';
    const verdict = c.verdict ?? 'unread';
    const stats = r
      ? `<div class="stats"><span class="tier ${esc(r.tier ?? '')}">${esc(r.tier ?? '·')}</span><span class="wr">${pct(r.winRate)}</span>${r.lift == null ? '' : `<span class="lift ${r.lift >= 0 ? 'pos' : 'neg'}">${signed(r.lift)}</span>`}<span class="games">${kfmt(r.games)}${r.games != null ? ' games' : ''}</span></div>`
      : `<div class="stats muted">${c.augmentId != null ? 'no data for this champion' : 'not recognised'}</div>`;
    return `<div class="card ${esc(rarity)} ${esc(verdict)}">
      <div class="ribbon ${esc(verdict)}">${verdict.toUpperCase()}</div>
      ${r && r.icon ? img(r.icon, 'icon') : ''}
      <div class="name">${esc(c.name ?? '?')}</div>
      <div class="desc">${esc(r && r.description ? r.description : '')}</div>
      ${stats}
      ${c.ocrText && c.ocrText !== c.name ? `<div class="ocr">read as "${esc(c.ocrText)}"</div>` : ''}
    </div>`;
  }).join('');
}
```
Wire the dismiss button and Escape near the other control handlers:
```js
$('#offer-dismiss').addEventListener('click', () => { const o = JSON.parse(lastRendered || '{}').offer; dismissedOfferAt = o ? o.detectedAt : null; lastRendered = ''; tick(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#offer').hidden) $('#offer-dismiss').click(); });
```
`kfmt(null)` already returns `''` and `pct(null)` returns `'–'`.

- [ ] **Step 8: Manual check without a game** — start the server, open the page. The header shows the `OCR on · N ms` chip. Simulate an offer by temporarily posting one from the browser console is not possible (no route), so verify the view with a one-off node script:

```js
// node -e "…" against a running server is not needed; instead run this quick DOM-free check:
node --input-type=module -e "
import { advise } from './src/ocr/advice.js';
import { normalizeAramkit } from './src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from './test/helpers/fixtures.js';
const d = normalizeAramkit(fixture('aramkit','champion-details-157-all.json'), aramkitResources(), { version:'x', bracket:'all', fetchedAt:0 });
const m = { cards: [1058, 2009, 1077].map((id, i) => ({ slot: ['left','center','right'][i], augmentId: id, name: d.augments.all.find(a=>a.id===id)?.name, rarity: 'gold', ocrText: 'x', score: 0.9 })), rarity: 'gold', confidence: 0.9, matched: 3 };
console.log(JSON.stringify(advise(m, d, { stage: 'auto', level: 7 }).cards.map(c => [c.slot, c.name, c.verdict, c.row?.tier, c.row?.description?.slice(0,40)]), null, 1));
"
```
Expected: three cards with verdicts and non-empty descriptions. Visual check of the cards happens on the first real game (Step 10).

- [ ] **Step 9: README** — add a section after "Page":

```markdown
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
`OCR_REGION=band|full`, `--ocr-debug` (saves frames that produced an offer to `data/debug/`).
Runtime toggle: `POST /api/ocr {"enabled":false}`.

Calibration / troubleshooting: `node scripts/ocr-capture.js --full --save data/debug/f.png`
prints every line the OCR sees with coordinates. During an augment screen, run
`curl -X POST localhost:3777/api/ocr/capture -d "{\"save\":true}"` to store the frame and
its match result under `data/debug/` — attach these when reporting a missed offer.
```

- [ ] **Step 10: First real-game verification (user-driven)** — next ARAM Mayhem game: watch the server log for `[ocr] offer: left=… center=… right=…` at levels 3/7/11/15 and the page switching to cards. If an offer is missed, run the `/api/ocr/capture` command above during the screen and keep the JSON as `test/fixtures/ocr/real-<n>.json` for a follow-up tuning task (band, height, `minScore`).

- [ ] **Step 11: Run the suite and commit**

Run: `npm test` → all passing.
```bash
git add src/data/aramkit/normalize.js test/data/aramkit/normalize.test.js public/index.html public/style.css public/app.js README.md
git commit -m "feat: offer view with pick and reroll cards; augment descriptions"
```

---

## Plan self-review notes

- Spec coverage: §4 files (T1–T7), §5 model (T2 cards, T4 payload, T5 offer, T7 description), §6.1–6.2 worker (T1), §6.3 match (T2), §6.4 advice (T3), §6.5 watcher (T5), §6.6 state/server (T4, T6), §6.7 page (T7), §7 config (T4), §8 errors (T1 respawn budget, T5 error dedupe + status, T7 chip), §9 tests (each task; real fixture collection is a user-driven step in T7), §10 milestones (task order).
- Deliberately not implemented: the §8 "no text seen for 30 s while in game" hint. The OCR chip already shows `lastCaptureMs`; add the hint if the first real game shows black frames.
- Naming: the `Offer.cards[].row` is the shaped row (with `lift`, `lowSample`, `description`); `Offer.stage` is `stageUsed` from `shapeAugments`.
- Ordering: execute after the Blitz-fallback merge; Task 6's `main.js` edits are anchored on `detector.start();` and the `createServer(` call, which exist in both versions.
