import { EMPTY_GAME } from '../data/model.js';
import { shapeAugments } from '../rank/augments.js';
import { pickBuild } from '../rank/builds.js';

export const EMPTY_OCR = Object.freeze({ enabled: false, running: false, lastCaptureMs: null, lastCaptureAt: null, lastError: null });

export function buildPayload({ game, loading, champData, view, source, stale, errors, offer = null, ocr = EMPTY_OCR, recommend = null, buildContext = null }) {
  const augments = champData ? shapeAugments(champData, { stage: view.stage, level: game.level }) : null;
  return {
    game,
    loading,
    champ: champData ? { ...champData.champion, source } : null,
    view: { stage: view.stage, bracket: view.bracket, stageUsed: augments ? augments.stageUsed : null },
    augments: augments ? { columns: augments.columns, unknown: augments.unknown } : null,
    build: champData ? pickBuild(champData, { context: buildContext }) : null,
    meta: champData
      ? { source, version: champData.sourceVersion, dataDate: champData.dataDate, fetchedAt: champData.fetchedAt, bracket: champData.bracket, stale: !!stale }
      : null,
    errors,
    offer,
    ocr,
    recommend,
  };
}

export function createAppState({ repository, recommender = null, now = Date.now, maxErrors = 10, log = () => {} }) {
  let game = { ...EMPTY_GAME };
  const view = { stage: 'auto', bracket: 'all' };
  let current = null; // { id, bracket, data, source, stale }
  let loading = false;
  let loadSeq = 0;
  const errors = [];
  let offer = null;
  let ocr = { ...EMPTY_OCR };
  let recommend = null;      // { rev, context, team, candidates, warnings }
  let buildContext = null;   // { allies, enemies, itemCategories }
  let pendingRecommend = Promise.resolve();
  let recSeq = 0;

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

  // A result is dropped when a newer compute has started (recSeq) or the lineup moved on
  // (lineupRev). The sequence alone is not enough to tell which lineup a result belongs to, and
  // the revision alone cannot separate two computes at the same revision — e.g. two bracket
  // changes in flight at once, where the slower earlier one must not overwrite the newer one.
  async function loadRecommend(g) {
    const rev = g.lineupRev;
    const seq = ++recSeq;
    const superseded = () => seq !== recSeq || game.lineupRev !== rev;
    try {
      const r = await recommender.compute({ ...g.lineup, bracket: view.bracket });
      if (superseded()) return;
      recommend = { rev, ...r.recommend };
      buildContext = { allies: r.profiles.allies, enemies: g.phase === 'ingame' ? r.profiles.enemies : null, itemCategories: r.itemCategories };
      for (const w of r.recommend.warnings ?? []) log(`[recommend] ${w}`);
    } catch (e) {
      if (superseded()) return;
      recommend = null; buildContext = null;
      pushError('recommend', e.message);
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
      const prevRev = game.lineupRev;
      game = { ...next };
      if (game.phase !== 'ingame') offer = null;
      if (next.error && next.error !== prevError) pushError('game', next.error);
      if (recommender) {
        // recSeq++ makes the clear authoritative: a compute already in flight cannot restore it.
        if (game.phase === 'none') { recommend = null; buildContext = null; recSeq++; }
        else if (game.phase !== 'loading' && game.lineupRev !== prevRev) pendingRecommend = loadRecommend(game);
      }
      return Promise.all([ensureLoaded(), pendingRecommend]).then(() => undefined);
    },
    setView(patch = {}) {
      const prevBracket = view.bracket;
      if (patch.stage !== undefined) view.stage = patch.stage;
      if (patch.bracket !== undefined) view.bracket = patch.bracket;
      // The bracket feeds rankings, averages and per-champion data, so a change invalidates the recommendation.
      if (recommender && view.bracket !== prevBracket && game.lineupRev > 0 && game.phase !== 'none') pendingRecommend = loadRecommend(game);
      return Promise.all([ensureLoaded(), pendingRecommend]).then(() => undefined);
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
        offer,
        ocr: { ...ocr },
        recommend,
        buildContext,
      });
    },
    async preview(id, { bracket = 'all', stage = 'auto', force = false } = {}) {
      const r = await repository.getChamp(id, bracket, { force });
      return buildPayload({ game, loading: false, champData: r.data, view: { stage, bracket }, source: r.source, stale: r.stale, errors: (r.errors ?? []).map((e) => ({ scope: 'data', message: e.message, at: now() })) });
    },
    async previewRecommend({ held = null, bench = [], allies = [], enemies = [] }) {
      if (!recommender) throw new Error('recommender not configured');
      const r = await recommender.compute({ held, bench, allies, enemies, bracket: view.bracket });
      let build = null;
      if (held) {
        const data = (await repository.getChamp(held, view.bracket)).data;
        build = pickBuild(data, { context: { allies: r.profiles.allies, enemies: enemies.length ? r.profiles.enemies : null, itemCategories: r.itemCategories } });
      }
      return { recommend: { rev: null, preview: true, ...r.recommend }, build };
    },
    getChampData: () => (current && current.id === game.championId ? current.data : null),
    getOffer: () => offer,
    setOffer(next) { offer = next ?? null; },
    setOcrStatus(patch = {}) { ocr = { ...ocr, ...patch }; },
  };
}
