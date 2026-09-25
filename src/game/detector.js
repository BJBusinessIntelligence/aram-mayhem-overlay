import { EMPTY_GAME, stageFromLevel } from '../data/model.js';

export function reduceGameState(prev, { lcu, live }, champIndex, now = Date.now) {
  const next = { ...prev, lcuConnected: !!lcu?.connected, liveConnected: !!live?.connected, error: null, updatedAt: now() };

  if (live?.connected) {
    next.phase = 'ingame';
    next.level = live.level ?? null;
    next.stage = stageFromLevel(live.level);
    next.gameMode = live.gameMode ?? null;
    next.riotId = live.championRiotId ?? null;
    const champ = champIndex.byRiotId(live.championRiotId);
    if (champ) next.championId = champ.id;
    else { next.championId = null; next.error = `unknown champion "${live.championRiotId}"`; }
  } else if (lcu?.connected && lcu.phase === 'ChampSelect' && lcu.championId) {
    next.phase = 'champselect';
    next.championId = lcu.championId;
    next.riotId = champIndex.byId(lcu.championId)?.riotId ?? null;
    next.level = null; next.stage = null; next.gameMode = null;
  } else if (lcu?.connected && (lcu.phase === 'InProgress' || lcu.phase === 'Reconnect')) {
    next.phase = 'loading';
    next.level = null; next.stage = null;
  } else {
    next.phase = 'none';
    next.level = null; next.stage = null; next.gameMode = null;
  }

  if (lcu?.connected && lcu.queueId != null) next.queueId = lcu.queueId;
  else if (next.phase === 'none') next.queueId = null;
  return next;
}

const COMPARE = ['phase', 'queueId', 'championId', 'riotId', 'level', 'stage', 'gameMode', 'lcuConnected', 'liveConnected', 'error'];
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
