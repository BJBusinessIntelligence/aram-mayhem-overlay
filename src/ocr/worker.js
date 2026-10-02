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
    ...(msg.saveError ? { saveError: String(msg.saveError) } : {}),
    ...(msg.region ? { region: msg.region } : {}),
    ...(msg.color ? { color: msg.color } : {}),
    ...(Array.isArray(msg.passes) ? { passes: msg.passes } : {}),
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
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      // Synchronous spawn failure (e.g. powershell.exe missing): count it toward the respawn
      // budget (already pushed above) but leave `child` unset so the caller resolves ok:false
      // instead of the promise rejecting.
      lastError = e.message; log(`[ocr] ${lastError}`);
      return;
    }
    child = proc;
    if (proc.stdout.setEncoding) proc.stdout.setEncoding('utf8');
    // Guard every handler by current-child identity: once a child is superseded (killed on
    // timeout, or already resolved via exit), any of its events still in flight (a stale
    // stdout 'data' chunk, or its delayed 'exit') must not settle a *later* request's pending
    // promise. Without this, a slow-to-die child can steal the next capture's reply.
    proc.stdout.on('data', (chunk) => { if (child === proc) onData(chunk); });
    proc.stderr.on('data', (d) => { lastError = String(d).trim().slice(0, 200); });
    proc.on('exit', (code) => {
      const isCurrent = child === proc;
      if (isCurrent) child = null;
      log(`[ocr] worker exited (${code})`);
      if (isCurrent) settlePending({ ok: false, error: `worker exited (${code})` });
    });
    proc.on('error', (e) => {
      const isCurrent = child === proc;
      if (isCurrent) child = null;
      lastError = e.message;
      if (isCurrent) settlePending({ ok: false, error: e.message });
    });
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
      catch (e) {
        // A synchronous write failure means this child is broken: discard it (so it never gets
        // reused) and don't leave a zombie process around, rather than just failing this request.
        lastError = e.message;
        if (child === proc) child = null;
        try { proc.kill(); } catch { /* already gone */ }
        settlePending({ ok: false, error: e.message });
      }
    });
    queue = queue.then(run, run);
    return queue;
  }

  return {
    isAvailable: () => supported && !dead,
    lastError: () => lastError,
    capture: (opts = {}) => (supported
      ? request({ cmd: 'capture', region: opts.region ?? 'band', saveTo: opts.saveTo ?? null,
        ...(opts.imagePath ? { imagePath: opts.imagePath, frameW: opts.frameW, frameH: opts.frameH, offsetX: opts.offsetX, offsetY: opts.offsetY } : {}),
      }).then(normalizeCapture)
      : Promise.resolve(UNAVAILABLE('OCR is Windows-only'))),
    ping: () => (supported ? request({ cmd: 'ping' }) : Promise.resolve(UNAVAILABLE('OCR is Windows-only'))),
    stop() {
      const proc = child; child = null;
      if (pending) settlePending({ ok: false, error: 'stopped' });
      if (!proc) return;
      try { proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}
