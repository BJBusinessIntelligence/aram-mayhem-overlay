import { EMPTY_GAME, EMPTY_LINEUP, stageFromLevel } from '../data/model.js';

const lineupKey = (l) => JSON.stringify([l.held, l.bench, l.allies, l.enemies]);
const idsFromRiot = (names, champIndex) => (names ?? []).map((n) => champIndex.byRiotId(n)?.id).filter((id) => Number.isInteger(id));

export function reduceGameState(prev, { lcu, live }, champIndex, now = Date.now) {
  const next = { ...prev, lcuConnected: !!lcu?.connected, liveConnected: !!live?.connected, error: null, updatedAt: now() };

  let lineup = EMPTY_LINEUP;
  if (live?.connected) {
    next.phase = 'ingame';
    next.level = live.level ?? null;
    next.stage = stageFromLevel(live.level);
    next.gameMode = live.gameMode ?? null;
    next.riotId = live.championRiotId ?? null;
    const champ = champIndex.byRiotId(live.championRiotId);
    if (champ) next.championId = champ.id;
    else { next.championId = null; next.error = `unknown champion "${live.championRiotId}"`; }
    lineup = { held: next.championId, bench: [], allies: idsFromRiot(live.allies, champIndex), enemies: idsFromRiot(live.enemies, champIndex) };
  } else if (lcu?.connected && lcu.phase === 'ChampSelect' && (lcu.championId || lcu.champSelect?.held || lcu.champSelect?.bench?.length)) {
    // A lock, a hover, or an offered subset (opening pick) all count as champ select. championId
    // stays the LOCKED champion; a hover only drives the lineup.
    next.phase = 'champselect';
    next.championId = lcu.championId ?? null;
    next.riotId = lcu.championId ? champIndex.byId(lcu.championId)?.riotId ?? null : null;
    next.level = null; next.stage = null; next.gameMode = null;
    const cs = lcu.champSelect ?? {};
    lineup = { held: lcu.championId ?? cs.held ?? null, bench: cs.bench ?? [], allies: cs.allies ?? [], enemies: [] };
  } else if (lcu?.connected && (lcu.phase === 'InProgress' || lcu.phase === 'Reconnect')) {
    next.phase = 'loading';
    next.level = null; next.stage = null;
    // loading: keep the previous lineup (allies from champ select) until the live client appears
    lineup = prev.lineup ?? EMPTY_LINEUP;
  } else {
    next.phase = 'none';
    next.level = null; next.stage = null; next.gameMode = null;
  }

  if (lcu?.connected && lcu.queueId != null) next.queueId = lcu.queueId;
  else if (next.phase === 'none') next.queueId = null;

  next.lineup = lineup;
  next.lineupRev = lineupKey(lineup) === lineupKey(prev.lineup ?? EMPTY_LINEUP) ? (prev.lineupRev ?? 0) : (prev.lineupRev ?? 0) + 1;
  return next;
}

const COMPARE = ['phase', 'queueId', 'championId', 'riotId', 'level', 'stage', 'gameMode', 'lcuConnected', 'liveConnected', 'error', 'lineupRev'];
export function sameState(a, b) {
  return COMPARE.every((k) => a?.[k] === b?.[k]);
}

export function createDetector({ lcu, live, champIndex, onChange, pollMs = 2000, now = Date.now, initial = EMPTY_GAME }) {
  let state = { ...initial };
  let timer = null;
  let busy = false;

  async function tick() {
    if (busy) return state;
    busy = true;
    try {
      const [l, v] = await Promise.all([lcu.snapshot(), live.snapshot()]);
      const next = reduceGameState(state, { lcu: l, live: v }, champIndex, now);
      const changed = !sameState(state, next);
      state = next;
      if (changed) { try { await onChange(next); } catch { /* reported by the store */ } }
      return state;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() { if (!timer) timer = setInterval(() => { tick().catch(() => {}); }, pollMs); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    getState: () => state,
  };
}
