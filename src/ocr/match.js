// Pure: OCR lines → offered augment cards. No I/O.
export const BAND = Object.freeze({ x0: 0.15, x1: 0.85, y0: 0.20, y1: 0.75 });
export const TITLE_H = Object.freeze({ min: 0.009, max: 0.04 });   // fraction of frame height
export const CLUSTER_RADIUS = 0.06;                                 // fraction of frame width
const SLOTS = ['left', 'center', 'right'];

export function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function scoreName(norm, cand) {
  if (!norm || !cand) return 0;
  if (norm === cand) return 1;
  return 1 - levenshtein(norm, cand) / Math.max(norm.length, cand.length);
}

export function buildAugmentIndex(entries) {
  const seen = new Map();
  for (const e of entries ?? []) {
    const id = Number(e?.id);
    if (!Number.isInteger(id) || seen.has(id) || !e.name) continue;
    seen.set(id, { id, name: String(e.name), rarity: e.rarity ?? 'unknown', norm: normalizeText(e.name) });
  }
  return [...seen.values()].filter((e) => e.norm.length >= 3);
}

export function slotForX(cx, frameW) {
  const f = cx / frameW;
  return f < 0.42 ? 'left' : f > 0.58 ? 'right' : 'center';
}

function bestMatch(norm, index, minScore) {
  let best = null;
  for (const e of index) {
    const s = scoreName(norm, e.norm);
    if (s >= minScore && (!best || s > best.score || (s === best.score && e.norm.length > best.entry.norm.length))) best = { entry: e, score: s };
  }
  return best;
}

export function matchOffer(lines, index, { frameW, frameH, minScore = 0.8, band = BAND } = {}) {
  if (!frameW || !frameH || !Array.isArray(lines) || !index?.length) return null;
  const inBand = (l) => {
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    return cx >= band.x0 * frameW && cx <= band.x1 * frameW && cy >= band.y0 * frameH && cy <= band.y1 * frameH
      && l.h >= TITLE_H.min * frameH && l.h <= TITLE_H.max * frameH && normalizeText(l.text).length >= 3;
  };
  const cands = lines.filter(inBand).map((l) => ({ ...l, cx: l.x + l.w / 2, cy: l.y + l.h / 2 }));

  // x-clusters
  const clusters = [];
  for (const l of cands.sort((a, b) => a.cx - b.cx)) {
    const c = clusters.find((k) => Math.abs(k.cx - l.cx) <= CLUSTER_RADIUS * frameW);
    if (c) { c.lines.push(l); c.cx = c.lines.reduce((s, x) => s + x.cx, 0) / c.lines.length; }
    else clusters.push({ cx: l.cx, lines: [l] });
  }

  // best match per cluster, trying single lines and vertical pairs (wrapped titles)
  const scored = [];
  for (const c of clusters) {
    const ls = c.lines.sort((a, b) => a.cy - b.cy);
    let best = null;
    const consider = (text, x, y) => {
      const m = bestMatch(normalizeText(text), index, minScore);
      if (m && (!best || m.score > best.score)) best = { ...m, ocrText: text, x, y };
    };
    for (let i = 0; i < ls.length; i++) {
      consider(ls[i].text, ls[i].x, ls[i].y);
      if (i + 1 < ls.length && ls[i + 1].cy - ls[i].cy < ls[i].h * 1.8) consider(`${ls[i].text} ${ls[i + 1].text}`, ls[i].x, ls[i].y);
    }
    if (best) scored.push({ cx: c.cx, ...best });
  }
  if (scored.length < 2) return null;

  const top = scored.sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.cx - b.cx);
  const cards = SLOTS.map((slot) => ({ slot, augmentId: null, name: null, rarity: null, ocrText: null, score: 0, x: null, y: null }));
  const used = new Set();
  // With all three top matches present, cx order alone determines slot order — no fuzzy-band
  // collision can move a righter card into a lefter slot. With only two matches, fall back to
  // `slotForX`, resolving a same-slot collision by giving the later (righter, since `top` is
  // cx-ascending) match the next free slot to the right of the taken one.
  if (top.length === 3) {
    top.forEach((m, i) => {
      const slot = SLOTS[i];
      used.add(slot);
      cards[i] = { slot, augmentId: m.entry.id, name: m.entry.name, rarity: m.entry.rarity, ocrText: m.ocrText, score: m.score, x: m.x, y: m.y };
    });
  } else {
    for (const m of top) {
      let slot = slotForX(m.cx, frameW);
      if (used.has(slot)) {
        const idx = SLOTS.indexOf(slot);
        slot = SLOTS.slice(idx + 1).find((s) => !used.has(s)) ?? SLOTS.find((s) => !used.has(s));
      }
      if (!slot) break;
      used.add(slot);
      cards[SLOTS.indexOf(slot)] = { slot, augmentId: m.entry.id, name: m.entry.name, rarity: m.entry.rarity, ocrText: m.ocrText, score: m.score, x: m.x, y: m.y };
    }
  }
  const matched = cards.filter((c) => c.augmentId != null);
  const tally = {};
  for (const c of matched) tally[c.rarity] = (tally[c.rarity] || 0) + 1;
  const rarity = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  const confidence = (matched.reduce((s, c) => s + c.score, 0) / matched.length) * (matched.length / 3);
  return { cards, rarity, confidence, matched: matched.length };
}
