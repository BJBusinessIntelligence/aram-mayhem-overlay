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
