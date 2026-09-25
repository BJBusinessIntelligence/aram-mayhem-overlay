import path from 'node:path';
import { promises as nodeFs } from 'node:fs';

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

export function createCache({ dir, ttlMs, fs = nodeFs, now = Date.now }) {
  const filePath = (key) => path.join(dir, ...key.map(safe)) + '.json';

  async function remove(p) {
    try { await fs.rm(p, { force: true }); } catch { /* ignore */ }
  }

  async function get(key) {
    const p = filePath(key);
    let text;
    try { text = await fs.readFile(p, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { await remove(p); return null; }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fetchedAt !== 'number' || !('value' in parsed)) {
      await remove(p);
      return null;
    }
    return { value: parsed.value, fetchedAt: parsed.fetchedAt, fresh: now() - parsed.fetchedAt < ttlMs };
  }

  async function set(key, value) {
    const p = filePath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ fetchedAt: now(), value }), 'utf8');
  }

  return { get, set, filePath };
}
