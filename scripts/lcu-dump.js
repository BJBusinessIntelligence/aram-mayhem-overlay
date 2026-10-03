// Usage: node scripts/lcu-dump.js            one snapshot now (run during champ select)
//        node scripts/lcu-dump.js --watch    poll every 1 s; save a snapshot whenever the champ-select
//                                            session changes (timer phase, picks, bench); stop when the
//                                            phase leaves ChampSelect. Start it BEFORE queueing.
// Saves raw LCU JSON to data/debug/ for fixtures and for mapping the initial (subset) pick phase.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, parseArgs } from '../src/config.js';
import { readLockfile } from '../src/game/lockfile.js';
import { httpsGetJson } from '../src/util/httpsJson.js';

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig({ env: process.env, argv: process.argv.slice(2) });
const lock = await readLockfile(cfg.lockfilePath, { fs });
if (!lock) { console.error('League client not running (no lockfile)'); process.exit(2); }
const headers = { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' };
const get = (p) => httpsGetJson(`https://127.0.0.1:${lock.port}${p}`, { headers, timeoutMs: 3000, rejectUnauthorized: false }).catch((e) => ({ status: 0, body: String(e.message) }));
const ENDPOINTS = [
  ['phase', '/lol-gameflow/v1/gameflow-phase'],
  ['gameflow', '/lol-gameflow/v1/session'],
  ['champSelect', '/lol-champ-select/v1/session'],
  ['subset', '/lol-lobby-team-builder/champ-select/v1/subset-champion-list'],
  ['pickable', '/lol-champ-select/v1/pickable-champion-ids'],
  ['currentChampion', '/lol-champ-select/v1/current-champion'],
  ['teamBuilderPickable', '/lol-lobby-team-builder/champ-select/v1/pickable-champion-ids'],
];

async function snapshot() {
  const out = { at: new Date().toISOString() };
  for (const [k, p] of ENDPOINTS) out[k] = await get(p);
  return out;
}
// What changes between interesting moments of a champ select: timer phase, everyone's picks/intents, bench, pickable set.
function key(s) {
  const cs = s.champSelect?.body ?? {};
  return JSON.stringify([s.phase?.body, cs.timer?.phase, (cs.myTeam ?? []).map((p) => [p.cellId, p.championId, p.championPickIntent]),
    (cs.benchChampions ?? []).map((b) => b.championId), s.pickable?.body, s.subset?.body]);
}
async function save(s, tag) {
  await fs.mkdir(path.join('data', 'debug'), { recursive: true });
  const file = path.join('data', 'debug', `lcu-champ-select-${Date.now()}${tag}.json`);
  await fs.writeFile(file, JSON.stringify(s, null, 2));
  const cs = s.champSelect?.body ?? {};
  console.log('wrote', file, 'phase', s.phase?.body, 'timer', cs.timer?.phase ?? '-', 'subset', JSON.stringify(s.subset?.body).slice(0, 80));
}

if (args.watch !== 'true') { await save(await snapshot(), ''); process.exit(0); }

console.log('watching for champ select (Ctrl+C to stop)…');
let last = null; let seen = false;
for (;;) {
  const s = await snapshot();
  const inSelect = s.phase?.body === 'ChampSelect';
  if (inSelect) {
    seen = true;
    const k = key(s);
    if (k !== last) { last = k; await save(s, '-watch'); }
  } else if (seen) { console.log('champ select over (phase', s.phase?.body + ')'); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));
}
