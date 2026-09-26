import path from 'node:path';

export const DEFAULTS = Object.freeze({
  port: 3777,
  pollMs: 2000,
  cacheDir: path.join('data', 'cache'),
  cacheTtlMs: 24 * 60 * 60 * 1000,
  lockfilePath: 'C:\\Riot Games\\League of Legends\\lockfile',
  primarySource: 'aramkit',
  open: false,
  ocrIdleMs: 1500,
  ocrActiveMs: 500,
  ocrRegion: 'band',
  ocrDebug: false,
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

export function loadConfig({ env = {}, argv = [], platform = process.platform } = {}) {
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
  const src = pick('primary', 'PRIMARY_SOURCE');
  if (src !== undefined) {
    if (!['aramkit', 'blitz'].includes(src)) throw new Error(`Invalid primary source: ${src}`);
    c.primarySource = src;
  }
  if (args.open === 'true') c.open = true;

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

  return c;
}
