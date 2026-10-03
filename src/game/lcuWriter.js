// The only module that writes to the League client. Two operations, both idempotent:
// summoner spells (champ select only) and one item set per champion (merged into the user's list).
export function mergeItemSets(existing, itemSet) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const i = list.findIndex((s) => s && ((itemSet.title && s.title === itemSet.title) || (itemSet.uid && s.uid === itemSet.uid)));
  if (i === -1) list.push(itemSet); else list[i] = itemSet;
  return list;
}

const ok2xx = (status) => status >= 200 && status < 300;

export function createLcuWriter({ readLockfile, getJson, sendJson, now = Date.now, log = () => {}, debugDump = null }) {
  let summonerMemo = null; // { port, summonerId, accountId }
  let summonerKey = null;  // `${port}|${password}` the memo was read with; the password never enters the memo

  async function session() {
    let lock = null;
    try { lock = await readLockfile(); } catch { lock = null; }
    if (!lock) return null;
    const headers = { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' };
    const base = `https://127.0.0.1:${lock.port}`;
    return {
      get: (p) => getJson(`${base}${p}`, { headers, timeoutMs: 3000, rejectUnauthorized: false }),
      send: (method, p, body) => sendJson(`${base}${p}`, { method, body, headers, timeoutMs: 3000, rejectUnauthorized: false }),
      port: lock.port,
      key: `${lock.port}|${lock.password}`,
    };
  }

  const fail = (status, error) => ({ ok: false, status, error });

  async function summoner(s) {
    // A restarted client can reuse the port with a new password, and that is a different account
    // session, so the memo is only good while both halves of the lockfile match.
    if (summonerMemo && summonerKey === s.key) return summonerMemo;
    const r = await s.get('/lol-summoner/v1/current-summoner');
    if (r.status !== 200 || !r.body || !Number.isInteger(r.body.summonerId)) throw new Error(`summoner lookup failed: HTTP ${r.status}`);
    summonerKey = s.key;
    summonerMemo = { port: s.port, summonerId: r.body.summonerId, accountId: r.body.accountId ?? null };
    return summonerMemo;
  }

  return {
    async summoner() {
      try { const s = await session(); if (!s) return fail(0, 'client not running'); return { ok: true, status: 200, ...(await summoner(s)) }; }
      catch (e) { return fail(0, String(e?.message ?? e)); }
    },
    async setSpells(ids) {
      try {
        const s = await session(); if (!s) return fail(0, 'client not running');
        const r = await s.send('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: ids[0], spell2Id: ids[1] });
        return ok2xx(r.status) ? { ok: true, status: r.status } : fail(r.status, `HTTP ${r.status}`);
      } catch (e) { return fail(0, String(e?.message ?? e)); }
    },
    async upsertItemSet(itemSet) {
      try {
        const s = await session(); if (!s) return fail(0, 'client not running');
        const { summonerId } = await summoner(s);
        const path = `/lol-item-sets/v1/item-sets/${summonerId}/sets`;
        const got = await s.get(path);
        if (got.status !== 200 || !got.body || typeof got.body !== 'object' || Array.isArray(got.body)) return fail(got.status, `item sets GET failed: HTTP ${got.status}`);
        const body = { ...got.body, itemSets: mergeItemSets(got.body.itemSets, itemSet), timestamp: now() };
        if (debugDump) { try { await debugDump({ get: got.body, put: body }); } catch (e) { log(`[import] debug dump failed: ${e.message}`); } }
        const put = await s.send('PUT', path, body);
        return ok2xx(put.status) ? { ok: true, status: put.status } : fail(put.status, `item sets PUT failed: HTTP ${put.status}`);
      } catch (e) { return fail(0, String(e?.message ?? e)); }
    },
  };
}
