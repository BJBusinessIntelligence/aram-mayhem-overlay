import { MAYHEM_QUEUES } from '../data/model.js';
import { pickBuild } from '../rank/builds.js';
import { planImport, fingerprint } from './plan.js';

const ACTIVE = new Set(['champselect', 'ingame']);

// Polls the app state and pushes the held champion's spells and item set into the League client
// whenever the planned content changes. Mirrors the OCR watcher's loop and status pattern.
export function createImporter({ state, repository, writer, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 1000, now = Date.now, log = () => {} }) {
  let enabled = false;
  let stopped = true;
  let timer = null;
  let busy = false;
  let spellsFp = null;
  let itemSetFp = null;
  let last = { lastChampion: null, lastSpells: null, lastItemSetAt: null, lastError: null };

  // Forget what has been written so the next tick re-imports from scratch.
  function forget() { spellsFp = null; itemSetFp = null; }

  function status(patch = {}) {
    last = { ...last, ...patch };
    state.setImportStatus({ enabled, running: !stopped && enabled, ...last });
  }

  async function tick() {
    if (busy || !enabled) return;
    const g = state.getGame();
    const held = g?.lineup?.held ?? null;
    if (!ACTIVE.has(g?.phase) || !held) return;
    // Builds and spells here are Mayhem-only advice, so a normal ARAM or draft game is left alone.
    if (!MAYHEM_QUEUES.includes(g.queueId)) return;
    busy = true;
    try {
      let data;
      try { data = (await repository.getChamp(held, state.getView().bracket)).data; }
      catch (e) { status({ lastError: e.message }); return; }
      const build = pickBuild(data, { context: state.getBuildContext() });
      const plan = planImport({ champ: data.champion, build, enemies: (g.lineup.enemies ?? []).length });
      // Each write is gated on its own content, so a changed build does not re-PATCH identical
      // spells and new spells do not re-PUT an identical item set. The champion is part of both
      // keys: the item set is keyed per champion (title and uid), so a swap to a champion whose
      // planned build happens to be identical still needs its own write.
      // Both keys are remembered after the attempt, success or failure: a failed write is retried
      // only when the plan changes, never every second, and the chip keeps showing lastError.
      const name = data.champion.name;
      let allOk = true;
      if (g.phase === 'champselect' && plan.spells) {
        const fp = `${data.champion.id}|${plan.spells.ids.join('+')}`;
        if (fp !== spellsFp) {
          spellsFp = fp;
          const r = await writer.setSpells(plan.spells.ids);
          const label = plan.spells.names.join(' + ');
          if (r.ok) { log(`[import] spells ${label} for ${name}`); status({ lastChampion: name, lastSpells: label, lastError: null }); }
          else { allOk = false; log(`[import] spells failed: ${r.error}`); status({ lastError: `spells: ${r.error}` }); }
        }
      }
      if (plan.itemSet) {
        // fingerprint() without the spells yields `${phase}|-|${blocks}`: the block items and the
        // phase (the in-game plan carries the situational block) with no spell noise.
        const fp = `${data.champion.id}|${fingerprint({ itemSet: plan.itemSet }, g.phase)}`;
        if (fp !== itemSetFp) {
          itemSetFp = fp;
          const r = await writer.upsertItemSet(plan.itemSet);
          if (r.ok) { log(`[import] item set ${plan.itemSet.title} (${plan.itemSet.blocks.length} blocks)`); status({ lastChampion: name, lastItemSetAt: now(), ...(allOk ? { lastError: null } : {}) }); }
          else { log(`[import] item set failed: ${r.error}`); status({ lastError: `item set: ${r.error}` }); }
        }
      }
    } catch (e) {
      // Nothing here is expected to throw (the writer contracts resolve, getChamp is handled
      // above), so this covers the unforeseen - malformed cached data reaching pickBuild, say.
      // tick() must still resolve: it is awaited directly as well as from schedule().
      const message = String(e?.message ?? e);
      log(`[import] tick failed: ${message}`);
      status({ lastError: `tick: ${message}` });
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(() => { tick().catch((e) => log(`[import] tick failed: ${e.message}`)).finally(schedule); }, intervalMs);
  }

  return {
    tick,
    start() { if (!stopped) return; stopped = false; status(); schedule(); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; status(); },
    setEnabled(v) { enabled = !!v; if (!enabled) forget(); status(); },
    isEnabled: () => enabled,
    getStatus: () => ({ enabled, running: !stopped && enabled, ...last }),
  };
}
