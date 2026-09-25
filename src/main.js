import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createCache } from './data/cache.js';
import { createAramkitClient } from './data/aramkit/client.js';
import { createAramkitAdapter } from './data/aramkit/adapter.js';
import { createRepository } from './data/repository.js';
import { createChampionIndex } from './data/champions.js';
import { createAppState } from './server/state.js';
import { createServer } from './server/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function main({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const cfg = loadConfig({ env, argv });
  const cache = createCache({ dir: cfg.cacheDir, ttlMs: cfg.cacheTtlMs });
  const aramkit = createAramkitAdapter({ client: createAramkitClient(), cache });
  const repository = createRepository({ primary: aramkit, fallback: null, cache });

  let champIndex;
  try {
    champIndex = await aramkit.championIndex();
    log(`champion index: ${champIndex.size} champions (aramkit ${await aramkit.version()})`);
  } catch (e) {
    champIndex = createChampionIndex({});
    log(`WARN champion index unavailable: ${e.message}`);
  }

  const state = createAppState({ repository, log });
  if (champIndex.size === 0) state.pushError('startup', 'champion index unavailable; search and detection disabled until aramkit is reachable');

  const server = createServer({ state, champIndex, publicDir: path.join(here, '..', 'public') });
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const url = `http://localhost:${cfg.port}`;
  log(`overlay: ${url}`);
  if (cfg.open) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return { server, stop: () => server.close() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
