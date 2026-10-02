export const RARITIES = Object.freeze(['prismatic', 'gold', 'silver']);
export const STAGES = Object.freeze([1, 2, 3, 4]);
export const TIER_ORDER = Object.freeze({ S: 0, A: 1, B: 2, C: 3, D: 4 });

export const EMPTY_LINEUP = Object.freeze({ held: null, bench: [], allies: [], enemies: [] });

export const EMPTY_GAME = Object.freeze({
  phase: 'none',          // none | champselect | loading | ingame
  queueId: null,
  championId: null,
  riotId: null,           // champion internal name, e.g. MonkeyKing
  level: null,
  stage: null,
  gameMode: null,
  lcuConnected: false,
  liveConnected: false,
  error: null,
  updatedAt: 0,
  lineup: EMPTY_LINEUP,   // champion ids: { held, bench, allies, enemies }
  lineupRev: 0,           // bumps whenever lineup content changes
});

export function stageFromLevel(level) {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return null;
  if (level < 7) return 1;
  if (level < 11) return 2;
  if (level < 15) return 3;
  return 4;
}

export class NormalizeError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'NormalizeError'; Object.assign(this, extra); }
}

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} for ${url}`); this.name = 'HttpError'; this.status = status; this.url = url; }
}

export class DataUnavailable extends Error {
  constructor(errors = []) {
    super(`No data source available: ${errors.map((e) => e.message).join('; ')}`);
    this.name = 'DataUnavailable';
    this.errors = errors;
  }
}

export function assertChampData(d) {
  if (!d || typeof d !== 'object') throw new NormalizeError('ChampData missing');
  if (!d.champion || !Number.isInteger(d.champion.id)) throw new NormalizeError('ChampData.champion.id missing');
  if (!d.augments || !Array.isArray(d.augments.all) || d.augments.all.length === 0) throw new NormalizeError('ChampData has no augments');
  return d;
}
