export function pickedChampion(cs) {
  const me = (cs?.myTeam ?? []).find((p) => p && p.cellId === cs.localPlayerCellId);
  const id = me?.championId;
  return Number.isInteger(id) && id > 0 ? id : null;
}

const validId = (id) => Number.isInteger(id) && id > 0;

// ARAM champ select: every ally already holds a champion; the bench lists swap options.
export function extractChampSelect(cs) {
  const team = Array.isArray(cs?.myTeam) ? cs.myTeam : [];
  const me = team.find((p) => p && p.cellId === cs.localPlayerCellId);
  const held = validId(me?.championId) ? me.championId : null;
  const allies = team.filter((p) => p && p !== me && validId(p.championId)).map((p) => p.championId);
  const bench = (Array.isArray(cs?.benchChampions) ? cs.benchChampions : []).map((b) => b?.championId).filter(validId);
  return { held, bench, allies };
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
            champSelect = extractChampSelect(cs);
          } catch { /* not picked yet */ }
        }
        return { connected: true, phase, queueId, championId, champSelect };
      } catch {
        return { connected: false };
      }
    },
  };
}
