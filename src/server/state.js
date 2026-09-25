import { EMPTY_GAME } from '../data/model.js';
import { shapeAugments } from '../rank/augments.js';
import { pickBuild } from '../rank/builds.js';

export function buildPayload({ game, loading, champData, view, source, stale, errors }) {
  const augments = champData ? shapeAugments(champData, { stage: view.stage, level: game.level }) : null;
  return {
    game,
    loading,
    champ: champData ? { ...champData.champion, source } : null,
    view: { stage: view.stage, bracket: view.bracket, stageUsed: augments ? augments.stageUsed : null },
    augments: augments ? { columns: augments.columns, unknown: augments.unknown } : null,
    build: champData ? pickBuild(champData) : null,
    meta: champData
      ? { source, version: champData.sourceVersion, dataDate: champData.dataDate, fetchedAt: champData.fetchedAt, bracket: champData.bracket, stale: !!stale }
      : null,
    errors,
  };
}

export function createAppState({ repository, now = Date.now, maxErrors = 10, log = () => {} }) {
  let game = { ...EMPTY_GAME };
  const view = { stage: 'auto', bracket: 'all' };
  let current = null; // { id, bracket, data, source, stale }
  let loading = false;
  let loadSeq = 0;
  const errors = [];

  function pushError(scope, message) {
    errors.unshift({ scope, message, at: now() });
    errors.splice(maxErrors);
    log(`[${scope}] ${message}`);
  }

  async function load(id, bracket, { force = false } = {}) {
    const seq = ++loadSeq;
    loading = true;
    try {
      const r = await repository.getChamp(id, bracket, { force });
      if (seq !== loadSeq) return; // superseded by a newer request
      current = { id, bracket, data: r.data, source: r.source, stale: r.stale };
      for (const e of r.errors ?? []) pushError('data', e.message);
    } catch (e) {
      if (seq === loadSeq) { current = null; pushError('data', e.message); }
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function ensureLoaded({ force = false } = {}) {
    const id = game.championId;
    if (!id) return Promise.resolve();
    if (!force && current && current.id === id && current.bracket === view.bracket) return Promise.resolve();
    return load(id, view.bracket, { force });
  }

  return {
    getGame: () => game,
    getView: () => ({ ...view }),
    pushError,
    setGame(next) {
      const prevError = game.error;
      game = { ...next };
      if (next.error && next.error !== prevError) pushError('game', next.error);
      return ensureLoaded();
    },
    setView(patch = {}) {
      if (patch.stage !== undefined) view.stage = patch.stage;
      if (patch.bracket !== undefined) view.bracket = patch.bracket;
      return ensureLoaded();
    },
    refresh: () => ensureLoaded({ force: true }),
    snapshot() {
      const matches = current && current.id === game.championId;
      return buildPayload({
        game, loading,
        champData: matches ? current.data : null,
        view,
        source: matches ? current.source : null,
        stale: matches ? current.stale : false,
        errors: errors.slice(),
      });
    },
    async preview(id, { bracket = 'all', stage = 'auto', force = false } = {}) {
      const r = await repository.getChamp(id, bracket, { force });
      return buildPayload({ game, loading: false, champData: r.data, view: { stage, bracket }, source: r.source, stale: r.stale, errors: (r.errors ?? []).map((e) => ({ scope: 'data', message: e.message, at: now() })) });
    },
  };
}
