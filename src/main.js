import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createCache } from './data/cache.js';
import { createAramkitClient } from './data/aramkit/client.js';
import { createAramkitAdapter } from './data/aramkit/adapter.js';
import { createAramggClient } from './data/aramgg/client.js';
import { createAramggAdapter } from './data/aramgg/adapter.js';
import { createRepository } from './data/repository.js';
import { createChampionIndex } from './data/champions.js';
import { createAppState } from './server/state.js';
import { createServer } from './server/http.js';
import { httpsGetJson } from './util/httpsJson.js';
import { readLockfile } from './game/lockfile.js';
import { createLcuClient } from './game/lcu.js';
import { createLiveClient } from './game/liveclient.js';
import { createDetector } from './game/detector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cfg = loadConfig({ env, argv });
  const cache = createCache({ dir: cfg.cacheDir, ttlMs: cfg.cacheTtlMs });
  const aramkit = createAramkitAdapter({ client: createAramkitClient(), cache });

  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    champIndex = createChampionIndex({});
    log(`WARN champion index unavailable: ${e.message}`);
  }

  const aramgg = createAramggAdapter({ client: createAramggClient({ apiKey: cfg.aramggApiKey }), cache, apiKey: cfg.aramggApiKey, champIndex });
  const [primary, fallback] = cfg.primarySource === 'aramgg' ? [aramgg, aramkit] : [aramkit, aramgg];
  const repository = createRepository({ primary, fallback, cache });
  log(`data: primary=${primary.name} fallback=${fallback.enabled ? fallback.name : 'disabled'}`);

  const state = createAppState({ repository, log });
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

  const server = createServer({ state, champIndex, publicDir: path.join(here, '..', 'public') });
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const url = `http://localhost:${cfg.port}`;
  log(`overlay: ${url}`);
  if (cfg.open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return { server, detector, stop: () => { detector.stop(); server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((app) => { process.on('SIGINT', () => { app.stop(); process.exit(0); }); })
    .catch((e) => { console.error(e); process.exit(1); });
}
