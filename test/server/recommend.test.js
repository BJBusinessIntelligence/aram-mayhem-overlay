import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommender } from '../../src/server/recommend.js';
import { createChampionIndex } from '../../src/data/champions.js';
import { normalizeAramkit, combatFromAverages } from '../../src/data/aramkit/normalize.js';
import { normalizeCdragonChampion } from '../../src/data/cdragon/champion.js';
import { fixture, aramkitResources } from '../helpers/fixtures.js';

const champIndex = createChampionIndex(fixture('aramkit', 'resources-champions.json'));
const yasuo = normalizeAramkit(fixture('aramkit', 'champion-details-157-all.json'), aramkitResources(), { version: '16.19', bracket: 'all', fetchedAt: 0 });
const rankingsRaw = fixture('aramkit', 'champion-rankings-all.json');
const rankings = { version: '16.19', byId: Object.fromEntries(rankingsRaw.rows.map((r) => [r.id, { id: r.id, rank: r.rank, tier: r.tier, winRate: r.winRate, pickRate: r.pickRate, games: r.sampleCount }])) };
const averages = { version: '16.19', combat: combatFromAverages(fixture('aramkit', 'champion-performance-averages-all.json').averages) };
const CD = { 157: '157.json', 54: '54.json', 99: '99.json', 222: '222.json' };

function deps({ failChamp = [], failCdragon = [], failRankings = false } = {}) {
  const calls = { champ: [], cdragon: [] };
  return {
    calls,
    repository: { async getChamp(id, bracket) { calls.champ.push([id, bracket]); if (failChamp.includes(id)) throw new Error(`no data for ${id}`); return { data: { ...yasuo, champion: { ...yasuo.champion, id, name: champIndex.byId(id)?.name ?? `#${id}` } }, stale: false, source: 'aramkit' }; } },
    aramkit: { async rankings() { if (failRankings) throw new Error('rankings down'); return rankings; }, async averages() { return averages; } },
    cdragonChampions: { async get(id) { calls.cdragon.push(id); if (failCdragon.includes(id) || !CD[id]) throw new Error('HTTP 404'); return normalizeCdragonChampion(fixture('cdragon', 'champions', CD[id])); } },
    cdragon: { async load() { return { itemsById: { 3065: { id: 3065, categories: ['Health', 'SpellBlock'] } } }; } },
    champIndex,
  };
}

test('champ select: candidates for held + bench, allies profiled, every champion fetched once', async () => {
  const d = deps();
  const rec = createRecommender({ ...d, overrides: { Malphite: { engage: 1 } }, synergyRules: [{ a: 'Yasuo', b: 'Malphite', delta: 0.5, reason: 'knock-up' }] });
  const r = await rec.compute({ held: 157, bench: [99, 54], allies: [54, 222, 1, 62], enemies: [], bracket: 'all' });
  assert.equal(r.recommend.context, 'champselect');
  assert.deepEqual(r.recommend.candidates.map((c) => c.id).sort((a, b) => a - b), [54, 99, 157]);
  assert.equal(r.recommend.candidates.find((c) => c.id === 157).held, true);
  assert.equal(r.recommend.team.knownAllies, 4);
  assert.equal(r.profiles.allies.length, 4);
  assert.equal(r.profiles.enemies.length, 0);
  assert.deepEqual(r.itemCategories, { 3065: ['Health', 'SpellBlock'] });
  assert.equal(new Set(d.calls.champ.map(([id]) => id)).size, d.calls.champ.length, 'no duplicate champion fetches');
  assert.ok(r.recommend.candidates.find((c) => c.id === 157).reasons.includes('knock-up'));
  assert.ok(r.recommend.warnings.some((w) => /Annie|Wukong/.test(w)), 'missing cdragon data for 1/62 is a warning, not a failure');
});

test('in game: no candidates, enemies profiled, context ingame', async () => {
  const rec = createRecommender(deps());
  const r = await rec.compute({ held: 157, bench: [], allies: [54], enemies: [99, 222], bracket: 'all' });
  assert.equal(r.recommend.context, 'ingame');
  assert.deepEqual(r.recommend.candidates.map((c) => c.id), [157]);
  assert.equal(r.profiles.enemies.length, 2);
});

test('degradation: rankings down → strength fallback with warning; champ fetch failure → warning, profile still built from cdragon', async () => {
  const rec = createRecommender(deps({ failRankings: true, failChamp: [99] }));
  const r = await rec.compute({ held: 157, bench: [99], allies: [54], enemies: [], bracket: 'all' });
  assert.ok(r.recommend.warnings.some((w) => /rankings unavailable/.test(w)));
  const lux = r.recommend.candidates.find((c) => c.id === 99);
  assert.ok(lux, 'Lux still ranked');
  assert.equal(lux.name, 'Lux');
  assert.ok(lux.warnings.includes('combat stats unavailable'));
});

test('debug dump writes recommend-<ts>.json and prunes', async () => {
  const writes = []; const rms = [];
  const fs = { mkdir: async () => {}, writeFile: async (p, d) => writes.push(p), readdir: async () => ['recommend-1.json', 'recommend-2.json', 'recommend-3.json'], rm: async (p) => rms.push(p) };
  const path = await import('node:path');
  const rec = createRecommender({ ...deps(), debugDir: 'data/debug', autoDump: true, fs, path, now: () => 3, maxDumps: 2 });
  await rec.compute({ held: 157, bench: [], allies: [], enemies: [], bracket: 'all' });
  assert.ok(writes[0].endsWith('recommend-3.json'));
  assert.ok(rms.some((p) => p.endsWith('recommend-1.json')));
});
