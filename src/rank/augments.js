import { RARITIES, TIER_ORDER, stageFromLevel } from '../data/model.js';

export function resolveStage(champData, { stage = 'auto', level = null } = {}) {
  const wanted = stage === 'auto' ? stageFromLevel(level) : stage;
  if (wanted === null || wanted === undefined || wanted === 'all') return 'all';
  const n = Number(wanted);
  if (![1, 2, 3, 4].includes(n)) return 'all';
  const rows = champData?.augments?.stages?.[n];
  return Array.isArray(rows) && rows.length > 0 ? n : 'all';
}

const tierRank = (t) => (t != null && Object.prototype.hasOwnProperty.call(TIER_ORDER, t) ? TIER_ORDER[t] : 99);

export function compareRows(a, b) {
  if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
  const ta = tierRank(a.tier);
  const tb = tierRank(b.tier);
  if (ta !== tb) return ta - tb;
  const wa = a.winRate ?? -1;
  const wb = b.winRate ?? -1;
  if (wa !== wb) return wb - wa;
  return (b.games ?? 0) - (a.games ?? 0);
}

export function shapeAugments(champData, { stage = 'auto', level = null, minGames = 200 } = {}) {
  const stageUsed = resolveStage(champData, { stage, level });
  const rows = stageUsed === 'all' ? champData.augments.all : champData.augments.stages[stageUsed];
  const columns = Object.fromEntries(RARITIES.map((r) => [r, []]));
  const unknown = [];
  for (const r of rows) {
    const lift = r.globalWinRate == null || r.winRate == null ? null : r.winRate - r.globalWinRate;
    const shaped = { ...r, lift, lowSample: typeof r.games === 'number' && r.games < minGames };
    (columns[shaped.rarity] ?? unknown).push(shaped);
  }
  for (const r of RARITIES) columns[r].sort(compareRows);
  unknown.sort(compareRows);
  return { stageUsed, columns, unknown };
}
