import { shapeAugments, compareRows } from '../rank/augments.js';

const WEAK = new Set(['C', 'D']);
const isWeak = (row) => row.tier == null || WEAK.has(row.tier);

export function advise(match, champData, { stage = 'auto', level = null } = {}) {
  const shaped = champData ? shapeAugments(champData, { stage, level }) : null;
  const rowsById = new Map();
  if (shaped) for (const col of [...Object.values(shaped.columns), shaped.unknown]) for (const r of col) rowsById.set(r.id, r);

  const cards = match.cards.map((c) => ({
    ...c,
    row: c.augmentId != null ? rowsById.get(c.augmentId) ?? null : null,
    verdict: c.augmentId != null ? 'keep' : 'unread',
  }));
  const withRows = cards.filter((c) => c.row);
  if (withRows.length === 0) {
    return { cards, pickSlot: null, note: shaped ? 'No data for these augments' : 'Champion data not loaded', stageUsed: shaped ? shaped.stageUsed : null };
  }
  const best = withRows.slice().sort((a, b) => compareRows(a.row, b.row))[0];
  const rerollAll = isWeak(best.row);
  for (const c of cards) {
    if (!c.row) continue;
    if (rerollAll) c.verdict = 'reroll';
    else if (c === best) c.verdict = 'pick';
    else c.verdict = isWeak(c.row) || (c.row.lift != null && c.row.lift < 0) ? 'reroll' : 'keep';
  }
  return { cards, pickSlot: rerollAll ? null : best.slot, note: rerollAll ? 'Reroll all, then pick the best' : null, stageUsed: shaped.stageUsed };
}
