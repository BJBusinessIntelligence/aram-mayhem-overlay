import { buildProfile } from '../rank/profiles.js';
import { rankCandidates, teamSummary } from '../rank/lineup.js';
import { WEIGHTS } from '../rank/weights.js';
import { pruneDumps } from '../util/dumps.js';

const unique = (ids) => [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];

// Fetches everything the pure ranking engine needs (rankings, bracket averages, per-champion
// aramkit data, CommunityDragon playstyles, item categories) and assembles a recommendation.
// Every source may fail independently: a failure becomes a warning, never a rejection.
export function createRecommender({
  repository, aramkit, cdragonChampions, cdragon, champIndex,
  overrides = {}, synergyRules = [], weights = WEIGHTS,
  debugDir = null, autoDump = false, fs = null, path = null, maxDumps = 50, now = Date.now, log = () => {},
}) {
  async function settle(p) { try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; } }

  async function compute({ held = null, bench = [], allies = [], enemies = [], bracket = 'all' }) {
    const warnings = [];
    const ids = unique([held, ...bench, ...allies, ...enemies]);
    const [rk, av] = await Promise.all([settle(aramkit.rankings(bracket)), settle(aramkit.averages(bracket))]);
    const rankings = rk.ok ? rk.value : null;
    if (!rk.ok) warnings.push(`rankings unavailable: ${rk.error.message}`);
    const averages = av.ok ? av.value.combat : null;
    if (!av.ok) warnings.push(`averages unavailable: ${av.error.message}`);

    const champData = {}; const profiles = {};
    await Promise.all(ids.map(async (id) => {
      const info = champIndex.byId(id);
      const label = info?.name ?? `#${id}`;
      const [cd, cg] = await Promise.all([settle(repository.getChamp(id, bracket)), settle(cdragonChampions.get(id))]);
      if (cd.ok) champData[id] = cd.value.data; else warnings.push(`${label}: ${cd.error.message}`);
      if (!cg.ok) warnings.push(`${label}: profile unavailable (${cg.error.message})`);
      const c = champData[id]?.champion ?? null;
      profiles[id] = buildProfile({
        id, riotId: info?.riotId ?? c?.riotId ?? null, name: c?.name ?? label, icon: c?.icon ?? info?.icon ?? null,
        cdragon: cg.ok ? cg.value : null, combat: c?.combat ?? null, averages, override: overrides[info?.riotId] ?? null,
      });
    }));

    if (rankings === null && Object.keys(champData).length === 0 && ids.length > 0) {
      throw new Error('no champion data available: ' + warnings.join('; '));
    }

    const allyProfiles = allies.map((id) => profiles[id]).filter(Boolean);
    const enemyProfiles = enemies.map((id) => profiles[id]).filter(Boolean);
    const candidates = rankCandidates({ held, bench, allies: allyProfiles, rankings, profiles, champData, rules: synergyRules, weights });
    let itemCategories = {};
    try {
      const res = await cdragon.load();
      itemCategories = Object.fromEntries(Object.values(res.itemsById ?? {}).map((i) => [i.id, Array.isArray(i.categories) ? i.categories : []]));
    } catch (e) { warnings.push(`item categories unavailable: ${e.message}`); }

    const result = {
      recommend: { context: enemies.length ? 'ingame' : 'champselect', team: teamSummary(allyProfiles), candidates, warnings },
      profiles: { allies: allyProfiles, enemies: enemyProfiles },
      itemCategories,
    };
    if (autoDump && debugDir && fs && path) {
      try {
        await fs.mkdir(debugDir, { recursive: true });
        await fs.writeFile(path.resolve(debugDir, `recommend-${now()}.json`), JSON.stringify({ input: { held, bench, allies, enemies, bracket }, profiles, recommend: result.recommend }, null, 2));
        await pruneDumps(fs, path, debugDir, 'recommend-', maxDumps);
      } catch (e) { log(`[recommend] debug dump failed: ${e.message}`); }
    }
    return result;
  }

  return { compute };
}
