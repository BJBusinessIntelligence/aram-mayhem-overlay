import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport, fingerprint, HEALTH_POTION, AMO_PREFIX } from '../../src/import/plan.js';
import { pickBuild } from '../../src/rank/builds.js';
import { normalizeAramkit } from '../../src/data/aramkit/normalize.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const data = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const build = pickBuild(data);
const ids = (block) => block.items.map((i) => i.id);

test('plans spells and an AMO item set from the real Yasuo build', () => {
  const p = planImport({ champ: data.champion, build });
  assert.deepEqual(p.spells, { ids: [32, 4], names: ['Mark', 'Flash'] }); // reversed: second-best-pick spell on D, Flash on F
  const s = p.itemSet;
  assert.equal(s.title, `${AMO_PREFIX}Yasuo`);
  assert.equal(s.uid, 'amo-157');
  assert.deepEqual(s.associatedChampions, [157]);
  assert.equal(s.type, 'custom'); assert.equal(s.map, 'any'); assert.equal(s.mode, 'any');
  assert.deepEqual(s.associatedMaps, []); assert.equal(s.sortrank, 0); assert.equal(s.startedFrom, 'blank'); assert.deepEqual(s.preferredItemSlots, []);
  assert.deepEqual(s.blocks.map((b) => b.type), ['Start', 'Boots', 'Core (in order)', 'Later']);
  assert.deepEqual(ids(s.blocks[0]), ['1038', String(HEALTH_POTION)]);
  assert.deepEqual(ids(s.blocks[1]), ['3006']);
  assert.deepEqual(ids(s.blocks[2]), ['3032', '123430', '6333']);
  assert.deepEqual(ids(s.blocks[3]), ['3153', '3031', '3065', '6665', '3033', '3143']);
  for (const b of s.blocks) { assert.equal(b.hideIfSummonerSpell, ''); assert.equal(b.showIfSummonerSpell, ''); for (const i of b.items) { assert.equal(typeof i.id, 'string'); assert.equal(i.count, 1); } }
});

test('situational block only when enemies are known; duplicates removed within a block', () => {
  const sit = { ...build, situational: [{ item: { id: 3075, name: 'Thornmail' } }, { item: { id: 3075, name: 'Thornmail' } }, { item: { id: 3047, name: 'Steelcaps' } }] };
  const none = planImport({ champ: data.champion, build: sit, enemies: 0 });
  assert.ok(!none.itemSet.blocks.some((b) => b.type.startsWith('Situational')));
  const some = planImport({ champ: data.champion, build: sit, enemies: 5 });
  const last = some.itemSet.blocks.at(-1);
  assert.equal(last.type, 'Situational vs 5 enemies');
  assert.deepEqual(ids(last), ['3075', '3047']);
});

test('no primary → no spells and no item set; one spell id → no spells', () => {
  assert.deepEqual(planImport({ champ: data.champion, build: null }), { spells: null, itemSet: null });
  const one = planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, spellIds: [4] } } });
  assert.equal(one.spells, null);
  assert.ok(one.itemSet);
});

test('fingerprint changes with phase, spells or any block item and not otherwise', () => {
  const a = planImport({ champ: data.champion, build });
  const f = fingerprint(a, 'champselect');
  assert.equal(fingerprint(planImport({ champ: data.champion, build }), 'champselect'), f);
  assert.notEqual(fingerprint(a, 'ingame'), f);
  assert.notEqual(fingerprint(planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, spellIds: [4, 6] } } }), 'champselect'), f);
  assert.notEqual(fingerprint(planImport({ champ: data.champion, build: { ...build, primary: { ...build.primary, later: [] } } }), 'champselect'), f);
  assert.equal(typeof fingerprint({ spells: null, itemSet: null }, 'ingame'), 'string');
});
