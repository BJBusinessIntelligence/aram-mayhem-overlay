import { matchOffer, buildAugmentIndex } from './match.js';
import { advise } from './advice.js';

// Memoizes the built augment index, keyed on champData identity and the extra-augments list's
// length (not its array identity): a fresh `[]` returned every tick by a default
// `getExtraAugments` would otherwise defeat a reference-identity cache and force a full
// buildAugmentIndex (with a normalizeText pass per entry) on every 500-1500ms tick.
export function createAugmentIndexMemo() {
  let cache = { champData: undefined, extraLen: undefined, index: [] };

  return function memo(champData, extra) {
    const extraLen = extra ? extra.length : 0;
    if (cache.champData === champData && cache.extraLen === extraLen) return cache.index;
    const entries = [
      ...((champData && champData.augments && champData.augments.all) || []).map((r) => ({ id: r.id, name: r.name, rarity: r.rarity })),
      ...(extra || []),
    ];
    cache = { champData, extraLen, index: buildAugmentIndex(entries) };
    return cache.index;
  };
}

export function createOfferWatcher({
  worker, state, getExtraAugments = () => [], now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
  idleMs = 1500, activeMs = 500, region = 'band',
  debugDir = null, autoDump = false, fs = null, path = null, log = () => {},
}) {
  let enabled = false;
  let stopped = true;
  let timer = null;
  let busy = false;
  let lastKey = null;
  let agree = 0;
  let noMatch = 0;
  let publishedKey = null;
  let lastErrorMessage = null;
  const augmentIndexMemo = createAugmentIndexMemo();

  function indexFor(champData) {
    return augmentIndexMemo(champData, getExtraAugments());
  }

  function status(patch = {}) {
    state.setOcrStatus({ enabled, running: !stopped && enabled && worker.isAvailable(), ...patch });
  }

  function clearOffer() {
    if (publishedKey) { publishedKey = null; state.setOffer(null); }
    lastKey = null; agree = 0; noMatch = 0;
  }

  function reportError(message) {
    if (message !== lastErrorMessage) { lastErrorMessage = message; state.pushError('ocr', message); }
    status({ lastError: message.replace(/^capture failed: /, '') });
  }

  function adviceFor(match, champData) {
    const game = state.getGame();
    return advise(match, champData, { stage: state.getView().stage, level: game.level });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const game = state.getGame();
      if (!enabled || !worker.isAvailable() || game.phase !== 'ingame') {
        clearOffer();
        status({ lastError: worker.isAvailable() ? null : worker.lastError() });
        return;
      }
      const cap = await worker.capture({ region });
      status({ lastCaptureMs: cap.ok ? cap.ms : null, lastCaptureAt: now(), lastError: cap.ok ? null : cap.error });
      if (!cap.ok) { reportError(`capture failed: ${cap.error}`); return; }
      lastErrorMessage = null;
      const champData = state.getChampData();
      const match = matchOffer(cap.lines, indexFor(champData), { frameW: cap.w, frameH: cap.h });
      if (!match) { noMatch++; if (noMatch >= 2) clearOffer(); return; }
      noMatch = 0;
      const key = match.cards.map((c) => c.augmentId ?? '-').join(',');
      if (key === lastKey) agree++; else { lastKey = key; agree = 1; }
      if (agree >= 2 && key !== publishedKey) {
        const a = adviceFor(match, champData);
        publishedKey = key;
        state.setOffer({ detectedAt: now(), frames: agree, stage: a.stageUsed, rarity: match.rarity, confidence: match.confidence, cards: a.cards, pickSlot: a.pickSlot, note: a.note });
        log(`[ocr] offer: ${a.cards.map((c) => `${c.slot}=${c.name ?? '?'}:${c.verdict}`).join(' ')}${a.note ? ` (${a.note})` : ''}`);
        if (autoDump && debugDir && fs && path) fs.writeFile(path.resolve(debugDir, `offer-${now()}.json`), JSON.stringify({ capture: cap, match }, null, 2)).catch(() => {});
      }
    } catch (e) {
      reportError(e && e.message ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (stopped) return;
    // The callback returns the promise so tests can `await timers[i].fn()`.
    timer = setTimer(() => tick().finally(schedule), publishedKey ? activeMs : idleMs);
  }

  return {
    tick,
    start() {
      if (!stopped) return;
      stopped = false;
      if (debugDir && fs) fs.mkdir(debugDir, { recursive: true }).catch(() => {});
      status();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      clearOffer();
      status({ running: false });
    },
    setEnabled(v) { enabled = !!v; if (!enabled) clearOffer(); status(); },
    isEnabled: () => enabled,
    async captureOnce({ region: r = region, save = false } = {}) {
      let saveTo = null;
      if (save && debugDir && fs && path) {
        await fs.mkdir(debugDir, { recursive: true });
        saveTo = path.resolve(debugDir, `capture-${now()}.png`);
      }
      const cap = await worker.capture({ region: r, saveTo });
      const champData = state.getChampData();
      const match = cap.ok ? matchOffer(cap.lines, indexFor(champData), { frameW: cap.w, frameH: cap.h }) : null;
      if (saveTo) await fs.writeFile(saveTo.replace(/\.png$/, '.json'), JSON.stringify({ capture: cap, match }, null, 2));
      return { capture: cap, match, advice: match ? adviceFor(match, champData) : null, savedTo: saveTo };
    },
  };
}
