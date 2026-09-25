import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChampionIndex } from '../../src/data/champions.js';
import { fixture } from '../helpers/fixtures.js';

const index = createChampionIndex(fixture('aramkit', 'resources-champions.json'));

test('size and byId', () => {
  assert.equal(index.size, 173);
  assert.equal(index.byId(157).name, 'Yasuo');
  assert.equal(index.byId('157').riotId, 'Yasuo');
  assert.equal(index.byId(999999), null);
});

test('byRiotId is case-insensitive and maps Wukong', () => {
  assert.equal(index.byRiotId('monkeyking').id, 62);
  assert.equal(index.byRiotId('MonkeyKing').name, 'Wukong');
  assert.equal(index.byRiotId(null), null);
  assert.equal(index.byRiotId('Nope'), null);
});

test('search is prefix on name, riotId, slug', () => {
  assert.ok(index.search('ya').some((c) => c.name === 'Yasuo'));
  assert.ok(index.search('monkey').some((c) => c.name === 'Wukong'));
  assert.ok(index.search('wuk').some((c) => c.name === 'Wukong'));
  assert.deepEqual(index.search(''), []);
  assert.equal(index.search('a', 3).length, 3);
});

test('empty resource gives empty index', () => {
  const e = createChampionIndex({});
  assert.equal(e.size, 0);
  assert.equal(e.byId(1), null);
  assert.deepEqual(e.all(), []);
});
