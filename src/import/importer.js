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
  let lastFingerprint = null;
  let last = { lastChampion: null, lastSpells: null, lastItemSetAt: null, lastError: null };

  function status(patch = {}) {
    last = { ...last, ...patch };
    state.setImportStatus({ enabled, running: !stopped && enabled, ...last });
  }

  async function tick() {
    if (busy || !enabled) return;
    const g = state.getGame();
    const held = g?.lineup?.held ?? null;
    if (!ACTIVE.has(g?.phase) || !held) return;
    busy = true;
    try {
      let data;
      try { data = (await repository.getChamp(held, state.getView().bracket)).data; }
      catch (e) { status({ lastError: e.message }); return; }
      const build = pickBuild(data, { context: state.getBuildContext() });
      const plan = planImport({ champ: data.champion, build, enemies: (g.lineup.enemies ?? []).length });
      // fingerprint() covers the phase, spells and block items; the champion is prepended because
      // the item set is keyed per champion (title and uid), so a swap to a champion whose planned
      // build happens to be identical still needs its own write.
      const fp = `${data.champion.id}|${fingerprint(plan, g.phase)}`;
      if (fp === lastFingerprint) return;
      const name = data.champion.name;
      let allOk = true;
      if (g.phase === 'champselect' && plan.spells) {
        const r = await writer.setSpells(plan.spells.ids);
        const label = plan.spells.names.join(' + ');
        if (r.ok) { log(`[import] spells ${label} for ${name}`); status({ lastChampion: name, lastSpells: label, lastError: null }); }
        else { allOk = false; log(`[import] spells failed: ${r.error}`); status({ lastError: `spells: ${r.error}` }); }
      }
      if (plan.itemSet) {
        const r = await writer.upsertItemSet(plan.itemSet);
        if (r.ok) { log(`[import] item set ${plan.itemSet.title} (${plan.itemSet.blocks.length} blocks)`); status({ lastChampion: name, lastItemSetAt: now(), ...(allOk ? { lastError: null } : {}) }); }
        else { allOk = false; log(`[import] item set failed: ${r.error}`); status({ lastError: `item set: ${r.error}` }); }
      }
      if (allOk) lastFingerprint = fp; // a failure keeps it unset so the next tick retries
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
    setEnabled(v) { enabled = !!v; if (!enabled) lastFingerprint = null; status(); },
    isEnabled: () => enabled,
    getStatus: () => ({ enabled, running: !stopped && enabled, ...last }),
  };
}
