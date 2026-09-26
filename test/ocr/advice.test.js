import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advise } from '../../src/ocr/advice.js';

const row = (id, over) => ({ id, name: `A${id}`, rarity: 'gold', tier: 'B', rank: 1, winRate: 0.55, pickRate: 0.1, games: 5000, globalWinRate: 0.5, icon: null, ...over });
const champ = (rows) => ({ champion: { id: 1, winRate: 0.5 }, augments: { all: rows, stages: { 1: [], 2: [], 3: [], 4: [] } } });
const card = (slot, augmentId) => ({ slot, augmentId, name: augmentId ? `A${augmentId}` : null, rarity: 'gold', ocrText: 'x', score: 0.9, x: 1, y: 1 });
const match = (ids) => ({ cards: ['left', 'center', 'right'].map((s, i) => card(s, ids[i])), rarity: 'gold', confidence: 0.9, matched: ids.filter(Boolean).length });

test('best card is pick; weak card is reroll; decent card is keep', () => {
  const d = champ([row(1, { tier: 'S', winRate: 0.6 }), row(2, { tier: 'B', winRate: 0.55 }), row(3, { tier: 'D', winRate: 0.4 })]);
  const a = advise(match([1, 2, 3]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'keep', 'reroll']);
  assert.equal(a.pickSlot, 'left');
  assert.equal(a.note, null);
  assert.equal(a.cards[0].row.id, 1);
  assert.equal(a.stageUsed, 'all');
});

test('negative lift makes a non-best card reroll', () => {
  const d = champ([row(1, { tier: 'A', winRate: 0.58 }), row(2, { tier: 'B', winRate: 0.48, globalWinRate: 0.5 })]);
  const a = advise(match([1, 2, null]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'reroll', 'unread']);
});

test('all weak → reroll all with note, no pick', () => {
  const d = champ([row(1, { tier: 'C' }), row(2, { tier: 'D' }), row(3, { tier: null })]);
  const a = advise(match([1, 2, 3]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['reroll', 'reroll', 'reroll']);
  assert.equal(a.pickSlot, null);
  assert.equal(a.note, 'Reroll all, then pick the best');
});

test('card known by name but absent from champion data is keep; no data at all → note', () => {
  const d = champ([row(1, { tier: 'A' })]);
  const a = advise(match([1, 99, null]), d);
  assert.deepEqual(a.cards.map((c) => c.verdict), ['pick', 'keep', 'unread']);
  assert.equal(a.cards[1].row, null);
  const none = advise(match([98, 99, null]), d);
  assert.equal(none.pickSlot, null);
  assert.equal(none.note, 'No data for these augments');
  const noChamp = advise(match([1, 2, 3]), null);
  assert.equal(noChamp.note, 'Champion data not loaded');
  assert.equal(noChamp.stageUsed, null);
});

test('stage rows are used when the stage has data', () => {
  const d = champ([row(1, { tier: 'D' }), row(2, { tier: 'A' })]);
  d.augments.stages[2] = [row(1, { tier: 'S' }), row(2, { tier: 'C' })];
  const a = advise(match([1, 2, null]), d, { stage: 'auto', level: 8 });
  assert.equal(a.stageUsed, 2);
  assert.equal(a.pickSlot, 'left');
});
