export function pickedChampion(cs) {
  const me = (cs?.myTeam ?? []).find((p) => p && p.cellId === cs.localPlayerCellId);
  const id = me?.championId;
  return Number.isInteger(id) && id > 0 ? id : null;
}

const validId = (id) => Number.isInteger(id) && id > 0;

// ARAM Mayhem champ select has two phases. Opening pick (timer BAN_PICK, nobody locked): the client
// offers a subset of champions; hovers show as championPickIntent. Afterwards every ally holds a
// champion and benchChampions lists swap options. `subset` is the team-builder subset list, when known.
export function extractChampSelect(cs, subset = []) {
  const team = Array.isArray(cs?.myTeam) ? cs.myTeam : [];
  const me = team.find((p) => p && p.cellId === cs.localPlayerCellId);
  const chosen = (p) => (validId(p?.championId) ? p.championId : validId(p?.championPickIntent) ? p.championPickIntent : null);
  const picking = cs?.timer?.phase === 'BAN_PICK' && !validId(me?.championId);
  const held = chosen(me);
  const allies = team.filter((p) => p && p !== me).map(chosen).filter((id) => id != null);
  const bench = picking
    ? (Array.isArray(subset) ? subset : []).filter((id) => validId(id) && id !== held)
    : (Array.isArray(cs?.benchChampions) ? cs.benchChampions : []).map((b) => b?.championId).filter(validId);
  return { held, bench, allies, picking };
}

// The team-builder route answers with an array or { subsetChampionIds } during the opening pick,
// and 404 ("no available pickable subset champion data") otherwise.
export function subsetIds(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.subsetChampionIds) ? body.subsetChampionIds : [];
  return list.filter(validId);
}

export function createLcuClient({ readLockfile, getJson, timeoutMs = 1500 }) {
  async function request(lock, path) {
    const { status, body } = await getJson(`https://127.0.0.1:${lock.port}${path}`, {
      headers: { authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64'), accept: 'application/json' },
      timeoutMs,
      rejectUnauthorized: false,
    });
    if (status !== 200) throw new Error(`LCU ${status} ${path}`);
    return body;
  }

  return {
    async snapshot() {
      let lock = null;
      try { lock = await readLockfile(); } catch { lock = null; }
      if (!lock) return { connected: false };
      try {
        const phase = String(await request(lock, '/lol-gameflow/v1/gameflow-phase'));
        let queueId = null;
        let championId = null;
        if (phase !== 'None') {
          try {
            const session = await request(lock, '/lol-gameflow/v1/session');
            const id = session?.gameData?.queue?.id;
            queueId = Number.isInteger(id) ? id : null;
          } catch { /* queue unknown */ }
        }
        let champSelect = null;
        if (phase === 'ChampSelect') {
          try {
            const cs = await request(lock, '/lol-champ-select/v1/session');
            championId = pickedChampion(cs);
            let subset = [];
            try { subset = subsetIds(await request(lock, '/lol-lobby-team-builder/champ-select/v1/subset-champion-list')); }
            catch { /* only served during the opening pick */ }
            champSelect = extractChampSelect(cs, subset);
          } catch { /* session not available */ }
        }
        return { connected: true, phase, queueId, championId, champSelect };
      } catch {
        return { connected: false };
      }
    },
  };
}
