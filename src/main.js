import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createCache } from './data/cache.js';
import { createAramkitClient } from './data/aramkit/client.js';
import { createAramkitAdapter } from './data/aramkit/adapter.js';
import { createCdragonResources } from './data/cdragon/resources.js';
import { createBlitzClient } from './data/blitz/client.js';
import { createBlitzAdapter } from './data/blitz/adapter.js';
import { createRepository } from './data/repository.js';
import { createChampionIndex, createChampionIndexFromCdragon } from './data/champions.js';
import { createCdragonChampions } from './data/cdragon/champion.js';
import { createAppState } from './server/state.js';
import { createRecommender } from './server/recommend.js';
import { createServer } from './server/http.js';
import { httpsGetJson, httpsSendJson } from './util/httpsJson.js';
import { pruneDumps } from './util/dumps.js';
import { readLockfile } from './game/lockfile.js';
import { createLcuClient } from './game/lcu.js';
import { createLiveClient } from './game/liveclient.js';
import { createDetector } from './game/detector.js';
import { createOcrWorker } from './ocr/worker.js';
import { createOfferWatcher } from './ocr/watcher.js';
import { createLcuWriter } from './game/lcuWriter.js';
import { createImporter } from './import/importer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cfg = loadConfig({ env, argv });
  const cache = createCache({ dir: cfg.cacheDir, ttlMs: cfg.cacheTtlMs });
  const aramkit = createAramkitAdapter({ client: createAramkitClient(), cache });
  const cdragon = createCdragonResources({ cache, log });

  // Startup order: aramkit's own champion list, then CommunityDragon's champion-summary as a
  // fallback (also used by the blitz data source), then an empty index (search/detection disabled).
  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    log(`WARN champion index unavailable (aramkit): ${e.message}`);
    try {
      const res = await cdragon.load();
      champIndex = createChampionIndexFromCdragon(res.champions);
      log(`champion index: ${champIndex.size} champions (communitydragon fallback)`);
    } catch (e2) {
      champIndex = createChampionIndex({});
      log(`WARN champion index unavailable (communitydragon): ${e2.message}`);
    }
  }

  const blitz = createBlitzAdapter({ client: createBlitzClient(), resources: cdragon });
  const [primary, fallback] = cfg.primarySource === 'blitz' ? [blitz, aramkit] : [aramkit, blitz];
  const repository = createRepository({ primary, fallback, cache });
  log(`data: primary=${primary.name} fallback=${fallback && fallback.enabled ? fallback.name : 'disabled'}`);

  const cdragonChampions = createCdragonChampions({ cache, log });
  const readJson = async (file, fallback) => {
    try { return JSON.parse(await fs.readFile(path.join(here, '..', 'data', file), 'utf8')); }
    catch (e) { log(`WARN ${file} not loaded: ${e.message}`); return fallback; }
  };
  const recommender = createRecommender({
    repository, aramkit, cdragonChampions, cdragon, champIndex,
    overrides: await readJson('profile-overrides.json', {}), synergyRules: await readJson('synergy-rules.json', []),
    debugDir: path.join('data', 'debug'), autoDump: cfg.recDebug, fs, path, log,
  });
  const state = createAppState({ repository, recommender, log });
  log(`recommend: enabled debug=${cfg.recDebug}`);
  if (champIndex.size === 0) state.pushError('startup', 'champion index unavailable; search and detection disabled until aramkit is reachable');

  const lcu = createLcuClient({ readLockfile: () => readLockfile(cfg.lockfilePath, { fs }), getJson: httpsGetJson });
  const live = createLiveClient({ getJson: httpsGetJson });
  const detector = createDetector({
    lcu, live, champIndex, pollMs: cfg.pollMs,
    onChange: (g) => {
      log(`game: ${g.phase} champ=${g.riotId ?? '-'} lvl=${g.level ?? '-'} queue=${g.queueId ?? '-'}${g.error ? ` error=${g.error}` : ''}`);
      void state.setGame(g); // fire-and-forget: a slow fetch must not block the poll loop; load() swallows its own errors
    },
  });
  detector.start();

  let extraAugments = [];
  try {
    const res = await aramkit.resources();
    extraAugments = Object.entries(res.augments ?? {}).map(([id, a]) => ({ id: Number(id), name: a.name, rarity: a.rarity }));
  } catch { /* names come from champion data only */ }
  const ocrWorker = createOcrWorker({ log });
  const watcher = createOfferWatcher({
    worker: ocrWorker, state, getExtraAugments: () => extraAugments,
    idleMs: cfg.ocrIdleMs, activeMs: cfg.ocrActiveMs, region: cfg.ocrRegion,
    debugDir: path.join('data', 'debug'), autoDump: cfg.ocrDebug, fs, path, log,
  });
  watcher.setEnabled(cfg.ocrEnabled);
  watcher.start();
  log(`ocr: enabled=${cfg.ocrEnabled} available=${ocrWorker.isAvailable()} region=${cfg.ocrRegion}`);

  const writer = createLcuWriter({
    readLockfile: () => readLockfile(cfg.lockfilePath, { fs }), getJson: httpsGetJson, sendJson: httpsSendJson, log,
    debugDump: cfg.importDebug ? async (d) => {
      const dir = path.join('data', 'debug'); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `item-sets-${Date.now()}.json`), JSON.stringify(d, null, 2));
      await pruneDumps(fs, path, dir, 'item-sets-', 50);
    } : null,
  });
  const importer = createImporter({ state, repository, writer, log });
  importer.setEnabled(cfg.importEnabled);
  importer.start();
  log(`import: enabled=${cfg.importEnabled} debug=${cfg.importDebug}`);

  const server = createServer({ state, champIndex, publicDir: path.join(here, '..', 'public'), watcher, importer });
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const url = `http://localhost:${cfg.port}`;
  log(`overlay: ${url}`);
  if (cfg.open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return { server, detector, stop: () => { importer.stop(); watcher.stop(); ocrWorker.stop(); detector.stop(); server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((app) => { process.on('SIGINT', () => { app.stop(); process.exit(0); }); })
    .catch((e) => { console.error(e); process.exit(1); });
}
