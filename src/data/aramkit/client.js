import { HttpError } from '../model.js';

export const ARAMKIT_BASE = 'https://data.aramkit.com';
export const VERSIONS_URL = `${ARAMKIT_BASE}/data/versions.json`;
const FETCH_TIMEOUT_MS = 8000;

export function aramkitUrls(entry) {
  if (!entry || !entry.dataPath || !entry.resourcePath) throw new Error('aramkit version entry missing dataPath/resourcePath');
  return {
    champion: (id, bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-details/${id}.json`,
    resource: (name) => `${ARAMKIT_BASE}/${entry.resourcePath}/en-US/resources/${name}.json`,
    icon: (p) => (p ? `${ARAMKIT_BASE}/${p}` : null),
    rankings: (bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-rankings.json`,
    averages: (bracket) => `${ARAMKIT_BASE}/${entry.dataPath}/stats/${bracket}/champion-performance-averages.json`,
  };
}

export function pickLatest(versions) {
  const list = versions && Array.isArray(versions.versions) ? versions.versions : [];
  if (list.length === 0) throw new Error('aramkit versions.json has no versions');
  return list.find((v) => v.version === versions.latest) ?? list[0];
}

export function createAramkitClient({
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
    versions: () => fetchJson(VERSIONS_URL),
    latestVersion: async () => pickLatest(await fetchJson(VERSIONS_URL)),
    champion: (id, bracket, entry) => fetchJson(aramkitUrls(entry).champion(id, bracket)),
    resource: (name, entry) => fetchJson(aramkitUrls(entry).resource(name)),
    rankings: (bracket, entry) => fetchJson(aramkitUrls(entry).rankings(bracket)),
    averages: (bracket, entry) => fetchJson(aramkitUrls(entry).averages(bracket)),
  };
}
