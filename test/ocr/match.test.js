import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, levenshtein, scoreName, buildAugmentIndex, slotForX, matchOffer } from '../../src/ocr/match.js';
import { fixture } from '../helpers/fixtures.js';

const aug = fixture('aramkit', 'resources-augments.json');
const entries = Object.entries(aug).map(([id, a]) => ({ id: Number(id), name: a.name, rarity: a.rarity }));
const index = buildAugmentIndex(entries);
const idOf = (name) => entries.find((e) => e.name === name).id;
const FRAME = { frameW: 3440, frameH: 1440 };
const line = (text, x, y, w = 220, h = 34) => ({ text, x, y, w, h });
// Three card titles at plausible ultrawide positions (band x 516..2924, y 288..1080)
const L = 1180, C = 1610, R = 2040, Y = 640;

test('normalizeText and levenshtein', () => {
  assert.equal(normalizeText("Kai'Sa: Void-Seeker!"), 'kaisavoidseeker');
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(scoreName('mysticpunch', 'mysticpunch'), 1);
  assert.ok(scoreName('mystlcpunch', 'mysticpunch') > 0.9);
  assert.equal(scoreName('', 'x'), 0);
});

test('buildAugmentIndex dedupes by id and keeps rarity', () => {
  const idx = buildAugmentIndex([{ id: 1, name: 'Ab Cd', rarity: 'gold' }, { id: 1, name: 'Ab Cd', rarity: 'gold' }, { id: 2, name: 'Cde', rarity: null }, { id: 3, name: 'X', rarity: 'gold' }]);
  assert.equal(idx.length, 2, 'duplicate id dropped; 1-letter name dropped (norm shorter than 3)');
  assert.deepEqual(idx[0], { id: 1, name: 'Ab Cd', rarity: 'gold', norm: 'abcd' });
  assert.equal(idx[1].rarity, 'unknown');
});

test('slotForX thresholds', () => {
  assert.equal(slotForX(1000, 3440), 'left');
  assert.equal(slotForX(1720, 3440), 'center');
  assert.equal(slotForX(2500, 3440), 'right');
});

test('three clean titles → three cards in x order with rarity and confidence', () => {
  const lines = [line('Mystic Punch', L, Y), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.deepEqual(o.cards.map((c) => c.slot), ['left', 'center', 'right']);
  assert.deepEqual(o.cards.map((c) => c.augmentId), [idOf('Mystic Punch'), idOf('Zealot'), idOf('Final Form')]);
  assert.equal(o.cards[0].name, 'Mystic Punch');
  assert.equal(o.cards[0].ocrText, 'Mystic Punch');
  assert.ok(o.confidence > 0.99);
  assert.equal(o.rarity, aug[idOf('Mystic Punch')].rarity);
});

test('OCR typos still match; noise outside the band or wrong height is ignored', () => {
  const lines = [
    line('Mystlc Punch', L, Y), line('Zealot', C, Y), line('Flnal Form', R, Y),
    line('Mystic Punch', 100, 50),                // outside band (top-left HUD)
    line('Zealot', C, 1400),                      // outside band (bottom)
    line('Final Form', L, 700, 800, 120),         // too tall
    line('Final Form', R, 720, 60, 8),            // too small
    line('Deals 40% more damage to towers', L, 720, 400, 24), // body text, no name match
  ];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.deepEqual(o.cards.map((c) => c.name), ['Mystic Punch', 'Zealot', 'Final Form']);
  assert.ok(o.cards[0].score >= 0.8 && o.cards[0].score < 1);
});

test('a wrapped two-line title is merged within its column', () => {
  const name = entries.map((e) => e.name).find((n) => n.includes(': '));  // e.g. "Transmute: Chaos"
  let [a, b] = name ? name.split(': ') : [null, null];
  if (!name) {
    // If no ':' found, pick any two-word name and split on space
    const twoWord = entries.map((e) => e.name).find((n) => n.includes(' '));
    if (twoWord) [a, b] = twoWord.split(' ');
  }
  const lines = [line(a + ':', L, Y, 160), line(b, L + 4, Y + 40, 120), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.cards[0].name, name || (a && b ? a + ' ' + b : null));
  assert.equal(o.matched, 3);
});

test('two matches: the missing slot is null and confidence drops', () => {
  const lines = [line('Mystic Punch', L, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 2);
  assert.equal(o.cards[1].slot, 'center');
  assert.equal(o.cards[1].augmentId, null);
  assert.equal(o.cards[0].augmentId, idOf('Mystic Punch'));
  assert.ok(o.confidence < 0.7);
});

test('fewer than two matches → null', () => {
  assert.equal(matchOffer([line('Mystic Punch', L, Y)], index, FRAME), null);
  assert.equal(matchOffer([line('Buy Boots', L, Y), line('Recall', C, Y)], index, FRAME), null);
  assert.equal(matchOffer([], index, FRAME), null);
});

test('slot collision: three matches clustered inside the fuzzy-center window still land in cx order', () => {
  const cxAt = (frac, w = 220) => frac * FRAME.frameW - w / 2;
  // 43%, 50%, 57% of width all resolve to 'center' via slotForX (forcing the collision path),
  // while staying far enough apart (> the 6%-of-width cluster radius) to form three x-clusters.
  const lines = [line('Mystic Punch', cxAt(0.43), Y), line('Zealot', cxAt(0.50), Y), line('Final Form', cxAt(0.57), Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.deepEqual(o.cards.map((c) => c.slot), ['left', 'center', 'right']);
  assert.deepEqual(o.cards.map((c) => c.name), ['Mystic Punch', 'Zealot', 'Final Form']);
});

test('same name in two clusters keeps both; best score per cluster wins', () => {
  const lines = [line('Mystic Punch', L, Y), line('Mystic Punch', L + 10, Y + 60), line('Zealot', C, Y), line('Final Form', R, Y)];
  const o = matchOffer(lines, index, FRAME);
  assert.equal(o.matched, 3);
  assert.equal(o.cards[0].name, 'Mystic Punch');
});
