import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createOcrWorker } from '../../src/ocr/worker.js';
import { buildAugmentIndex, matchOffer } from '../../src/ocr/match.js';
import { fixture } from '../helpers/fixtures.js';

test('Windows OCR recovers three titles from the recorded zero-lines screenshot', {
  skip: process.platform !== 'win32' && 'requires Windows.Media.Ocr', timeout: 15000,
}, async t => {
  const worker = createOcrWorker();
  t.after(() => worker.stop());
  const cap = await worker.capture({
    imagePath: fileURLToPath(new URL('../fixtures/ocr/unreadable-band.png', import.meta.url)),
    frameW: 3440, frameH: 1440, offsetX: 516, offsetY: 288,
  });
  assert.equal(cap.ok, true, cap.error);
  const index = buildAugmentIndex(Object.entries(fixture('aramkit', 'resources-augments.json'))
    .map(([id, a]) => ({ id: Number(id), name: a.name, rarity: a.rarity })));
  const match = matchOffer(cap.lines, index, { frameW: cap.w, frameH: cap.h });
  assert.deepEqual(match?.cards.map(c => c.name), ['Final Form', 'Cruelty', 'Ult Bot']);
  assert.ok(match.cards.every(c => c.y > 570 && c.y < 610), 'crop and resize return full-frame coordinates');
});

test('Windows OCR survives a debug screenshot write failure', {
  skip: process.platform !== 'win32' && 'requires Windows.Media.Ocr', timeout: 15000,
}, async t => {
  const worker = createOcrWorker();
  t.after(() => worker.stop());
  const cap = await worker.capture({
    imagePath: fileURLToPath(new URL('../fixtures/ocr/unreadable-band.png', import.meta.url)),
    frameW: 3440, frameH: 1440, offsetX: 516, offsetY: 288,
    // Saving an image over an existing directory must fail without breaking recognition.
    saveTo: fileURLToPath(new URL('../fixtures/ocr/', import.meta.url)),
  });
  assert.equal(cap.ok, true, cap.error);
  assert.equal(typeof cap.saveError, 'string');
  assert.ok(cap.lines.some(l => l.text === 'Final Form'));
});
