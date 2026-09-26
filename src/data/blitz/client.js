import { HttpError } from '../model.js';

export const BLITZ_BASE = 'https://data.v2.iesdev.com/api/v1/query_objects/prod/lol/';
const FETCH_TIMEOUT_MS = 8000;

export function createBlitzClient({
  fetch = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIntervalMs = 500,
  userAgent = 'aram-mayhem-overlay/0.1 (personal tool)',
} = {}) {
  let lastAt = -Infinity;
  let chain = Promise.resolve();
  const inflight = new Map();

  function fetchJson(url) {
    if (inflight.has(url)) return inflight.get(url);
    const run = chain.catch(() => {}).then(async () => {
      const wait = lastAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.status !== 200) throw new HttpError(res.status, url);
      return res.json();
    });
    chain = run;
    const tracked = run.finally(() => inflight.delete(url));
    inflight.set(url, tracked);
    return tracked;
  }

  return {
    fetchJson,
    championMayhem: (id) => fetchJson(`${BLITZ_BASE}aram_mayhem_champion?champion_id=${id}`),
    builds: (id) => fetchJson(`${BLITZ_BASE}champion_builds_tags?champion_id=${id}&queue_id=HOWLING_ABYSS_ARAM`),
  };
}
