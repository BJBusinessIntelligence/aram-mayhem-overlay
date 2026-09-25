import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageFromLevel, assertChampData, NormalizeError, HttpError, DataUnavailable, EMPTY_GAME } from '../../src/data/model.js';

test('stageFromLevel boundaries', () => {
  assert.equal(stageFromLevel(1), 1);
  assert.equal(stageFromLevel(6), 1);
  assert.equal(stageFromLevel(7), 2);
  assert.equal(stageFromLevel(10), 2);
  assert.equal(stageFromLevel(11), 3);
  assert.equal(stageFromLevel(14), 3);
  assert.equal(stageFromLevel(15), 4);
  assert.equal(stageFromLevel(18), 4);
  assert.equal(stageFromLevel(null), null);
  assert.equal(stageFromLevel(0), null);
  assert.equal(stageFromLevel('7'), null);
});

test('assertChampData rejects bad shapes', () => {
  assert.throws(() => assertChampData(null), NormalizeError);
  assert.throws(() => assertChampData({ champion: {} }), /champion\.id/);
  assert.throws(() => assertChampData({ champion: { id: 1 }, augments: { all: [] } }), /no augments/);
  const ok = { champion: { id: 1 }, augments: { all: [{ id: 5 }] } };
  assert.equal(assertChampData(ok), ok);
});

test('error classes carry data', () => {
  const h = new HttpError(404, 'http://x');
  assert.equal(h.status, 404);
  assert.match(h.message, /404/);
  const d = new DataUnavailable([new Error('a'), new Error('b')]);
  assert.equal(d.errors.length, 2);
  assert.match(d.message, /a; b/);
});

test('EMPTY_GAME is frozen with phase none', () => {
  assert.equal(EMPTY_GAME.phase, 'none');
  assert.equal(Object.isFrozen(EMPTY_GAME), true);
});
