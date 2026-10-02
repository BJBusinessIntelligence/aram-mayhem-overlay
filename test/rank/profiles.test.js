import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, TRAITS, EMPTY_PROFILE } from '../../src/rank/profiles.js';
import { normalizeCdragonChampion } from '../../src/data/cdragon/champion.js';
import { combatFromAverages } from '../../src/data/aramkit/normalize.js';
import { fixture } from '../helpers/fixtures.js';

const cd = (id) => normalizeCdragonChampion(fixture('cdragon', 'champions', `${id}.json`));
const averages = combatFromAverages(fixture('aramkit', 'champion-performance-averages-all.json').averages);
const yasuoCombat = { physicalDamage: 35093, magicDamage: 5058, trueDamage: 2087, damageTaken: 37193, damageSelfMitigated: 74028, healsOnTeammates: 1, damageShieldedOnTeammates: 0, timeCcingOthers: 29.3, damageShare: 0.2061 };
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('Malphite without combat stats: neutral ratios, tank/melee rules', () => {
  const p = buildProfile({ id: 54, riotId: 'Malphite', name: 'Malphite', cdragon: cd(54) });
  assert.equal(p.ranged, false);
  assert.deepEqual(p.style, { damage: 0, durability: 1, crowdControl: 1, mobility: 0, utility: 0 });
  near(p.frontline, 0.95);           // 0.4*1 + 0.3*0.5 + 0.3*1 + 0.1 melee
  near(p.engage, 2 / 3);             // mean(mobility 0, cc 1, melee 1) * 1
  near(p.peel, (0 + 1 + 0.4) / 3);   // mean(utility 0, cc 1, melee 0.4) * 1 (mage)
  assert.equal(p.poke, 0);
  near(p.sustain, 0.5);              // neutral ratio
  near(p.cc, 0.75);                  // mean(1, 0.5)
  assert.equal(p.physicalShare, 0.1); // kMagic, no combat
  assert.deepEqual(p.sources, { cdragon: true, aramkit: false, override: false });
  assert.deepEqual(p.warnings, ['combat stats unavailable']);
});

test('Yasuo with combat stats: shares and mitigation ratio from aramkit', () => {
  const p = buildProfile({ id: 157, riotId: 'Yasuo', name: 'Yasuo', cdragon: cd(157), combat: yasuoCombat, averages });
  near(p.physicalShare, 35093 / (35093 + 5058));
  near(p.magicShare, 1 - p.physicalShare);
  near(p.frontline, 0.4 * 0 + 0.3 * Math.min(1, Math.min(2, 74028 / 46272.043) / 2) + 0.3 * 0.6 + 0.1);
  assert.equal(p.sustain, 0);        // heals+shields ≈ 0
  near(p.cc, (0.5 + Math.min(1, (29.3 / 33.9) / 2)) / 2);
  assert.equal(p.poke, 0);           // melee
  near(p.burst, 1);                  // damage 1 × assassin
  assert.equal(p.damageShare, 0.2061);
  assert.deepEqual(p.sources, { cdragon: true, aramkit: true, override: false });
  assert.deepEqual(p.warnings, []);
});

test('Lux and Jinx: ranged poke; peel for mage/support', () => {
  const lux = buildProfile({ id: 99, riotId: 'Lux', name: 'Lux', cdragon: cd(99) });
  near(lux.poke, 1);                 // mean(damage 1, 1 - durability 0) × mage
  near(lux.peel, (0.5 + 0.5 + 1) / 3);
  near(lux.engage, ((0 + 0.5 + 0.3) / 3) * 0.6);
  const jinx = buildProfile({ id: 222, riotId: 'Jinx', name: 'Jinx', cdragon: cd(222) });
  near(jinx.poke, 1);
  near(jinx.peel, ((0 + 0.5 + 1) / 3) * 0.6);
  assert.equal(jinx.physicalShare, 0.9);
});

test('override patches traits and is recorded', () => {
  const p = buildProfile({ id: 54, riotId: 'Malphite', name: 'Malphite', cdragon: cd(54), override: { engage: 1, poke: 0.2, note: 'ult' } });
  assert.equal(p.engage, 1);
  assert.equal(p.poke, 0.2);
  assert.equal(p.sources.override, true);
});

test('no cdragon → style defaults 0.5, roles empty, warning', () => {
  const p = buildProfile({ id: 1, riotId: 'Annie', name: 'Annie', combat: yasuoCombat, averages });
  assert.deepEqual(p.style, { damage: 0.5, durability: 0.5, crowdControl: 0.5, mobility: 0.5, utility: 0.5 });
  assert.equal(p.ranged, false);
  assert.ok(p.warnings.includes('champion profile unavailable'));
  assert.equal(p.sources.cdragon, false);
});

test('EMPTY_PROFILE and TRAITS', () => {
  const e = EMPTY_PROFILE(7, 'X');
  for (const t of TRAITS) assert.equal(e[t], 0);
  assert.deepEqual(TRAITS, ['frontline', 'engage', 'peel', 'sustain', 'cc', 'poke']);
  assert.deepEqual(e.warnings, ['profile unavailable']);
});
