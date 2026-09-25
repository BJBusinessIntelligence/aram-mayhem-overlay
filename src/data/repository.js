import { DataUnavailable } from './model.js';

function tagged(adapter, e) {
  const err = new Error(`${adapter.name}: ${e && e.message ? e.message : String(e)}`);
  err.cause = e;
  return err;
}

export function createRepository({ primary, fallback = null, cache }) {
  const inflight = new Map();

  function dedupe(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function getChamp(id, bracket = 'all', { force = false } = {}) {
    const errors = [];
    const stale = [];
    for (const adapter of [primary, fallback]) {
      if (!adapter || !adapter.enabled) continue;
      const b = adapter.supportsBracket(bracket) ? bracket : 'all';
      const key = [adapter.name, b, `champ-${id}`];
      const cached = force ? null : await cache.get(key);

      let version = null;
      // A source whose version endpoint is down is skipped entirely for this attempt (deliberate
      // simplification); a still-fresh stale cache entry below can still serve the response.
      try { version = await adapter.version(); }
      catch (e) { errors.push(tagged(adapter, e)); }

      if (cached && cached.fresh && version && cached.value.sourceVersion === version) {
        return { data: cached.value, stale: false, source: adapter.name, errors };
      }
      if (version) {
        try {
          const data = await dedupe(key.join('/'), () => adapter.champion(id, b));
          await cache.set(key, data);
          return { data, stale: false, source: adapter.name, errors };
        } catch (e) { errors.push(tagged(adapter, e)); }
      }
      if (cached) stale.push({ data: cached.value, stale: true, source: adapter.name });
    }
    if (stale.length) return { ...stale[0], errors };
    throw new DataUnavailable(errors);
  }

  return { getChamp };
}
