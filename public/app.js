const POLL_MS = 2000;
const noIcons = new URLSearchParams(location.search).has('noicons');
const $ = (s) => document.querySelector(s);

let preview = null;          // { id, stage, bracket } when browsing a champion manually
let lastRendered = '';
let lastRenderKey = '';
let lastLiveChampionId = null;
let dismissedOfferAt = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
const signed = (v) => (v == null ? '' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1));
const kfmt = (n) => (n == null ? '' : n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const img = (src, cls = '') => (src && !noIcons ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '');

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function setBanner(text, kind = '') {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.className = kind;
}

async function tick() {
  try {
    const state = await api('/api/state');
    const liveId = state.game.championId;
    if (preview && liveId && liveId !== lastLiveChampionId) preview = null; // new game detected → back to live
    lastLiveChampionId = liveId;
    const payload = preview
      ? await api(`/api/champ/${preview.id}?stage=${preview.stage}&bracket=${preview.bracket}`)
      : state;
    // The OCR chip (`lastCaptureAt` etc.) changes every tick while in game; excluding it from the
    // render-skip key keeps the rest of the page (open <details>, text selection) stable between
    // real changes, while renderOcrChip below still updates on every poll.
    const key = JSON.stringify({ ...payload, ocr: undefined });
    if (key !== lastRenderKey) { lastRenderKey = key; lastRendered = JSON.stringify(payload); render(payload, state); }
    else renderOcrChip(payload.ocr);
  } catch (e) {
    setBanner(`Server unreachable: ${e.message}`);
  }
}

function render(p, state) {
  $('#live-btn').hidden = !preview;
  $('#capture-btn').hidden = !p.ocr || !p.ocr.enabled;
  const g = p.game;
  const c = p.champ;
  const icon = $('#champ-icon');
  if (c && c.icon && !noIcons) { icon.src = c.icon; icon.hidden = false; } else icon.hidden = true;
  $('#champ-title').innerHTML = c
    ? `${esc(c.name)} <span class="tier ${esc(c.tier ?? '')}">${esc(c.tier ?? '?')}</span> <span class="muted">${pct(c.winRate)} WR · ${kfmt(c.games)} games</span>`
    : (g.lcuConnected || g.liveConnected ? 'Waiting for champion…' : 'Waiting for League…');
  const phase = { none: 'Not in game', champselect: 'Champ select', loading: 'Loading screen', ingame: 'In game' }[g.phase] ?? g.phase;
  const queue = g.queueId === 2400 ? 'ARAM Mayhem' : g.queueId === 2450 ? 'Mayhem Classic' : g.queueId ? `queue ${g.queueId}` : '';
  $('#game-info').textContent = [preview ? 'Preview' : phase, queue, g.gameMode, g.level ? `lvl ${g.level}` : ''].filter(Boolean).join(' · ');

  const view = p.view;
  for (const b of document.querySelectorAll('#stage-tabs button')) {
    const s = b.dataset.stage;
    b.classList.toggle('active', String(view.stage) === s);
    b.textContent = s === 'auto' ? `Auto${view.stage === 'auto' && view.stageUsed ? ` (${view.stageUsed})` : ''}` : s === 'all' ? 'All' : s;
  }
  for (const b of document.querySelectorAll('#bracket-tabs button')) b.classList.toggle('active', view.bracket === b.dataset.bracket);

  const m = p.meta;
  $('#meta').textContent = m ? `${m.source} ${m.version} · bracket ${m.bracket} · data ${m.dataDate ?? '?'} · fetched ${ago(m.fetchedAt)}${m.stale ? ' · STALE' : ''}${p.loading ? ' · loading…' : ''}` : (p.loading ? 'loading…' : '');

  const err = p.errors?.[0];
  if (m && m.stale) setBanner(`Showing stale data: ${err ? err.message : 'sources unreachable'}`, 'warn');
  else if (err && !c) setBanner(`${err.scope}: ${err.message}`);
  else setBanner('');

  for (const r of ['prismatic', 'gold', 'silver']) {
    const rows = p.augments ? p.augments.columns[r] : [];
    $(`#col-${r} .rows`).innerHTML = rows.map(renderAugment).join('') || '<div class="muted">–</div>';
  }
  $('#build').innerHTML = renderBuild(p.build);

  renderOcrChip(p.ocr);
  const offer = p.offer;
  const showOffer = offer && dismissedOfferAt !== offer.detectedAt;
  $('#offer').hidden = !showOffer;
  $('#main').hidden = !!showOffer;
  if (showOffer) renderOffer(offer);
}

function renderOcrChip(o) {
  const el = $('#ocr-chip');
  if (!o) { el.hidden = true; return; }
  el.hidden = false;
  if (!o.enabled) { el.textContent = 'OCR off'; el.className = 'chip'; return; }
  if (o.lastError) { el.textContent = `OCR: ${o.lastError}`; el.className = 'chip err'; return; }
  el.textContent = o.running ? `OCR on${o.lastCaptureMs != null ? ` · ${o.lastCaptureMs} ms` : ''}` : 'OCR idle';
  el.className = 'chip on';
}

function renderOffer(o) {
  const stage = o.stage && o.stage !== 'all' ? `Stage ${o.stage} · ` : '';
  const rarity = o.rarity || 'unknown';
  $('#offer-title').textContent = `${stage}${rarity === 'unknown' ? '' : rarity[0].toUpperCase() + rarity.slice(1) + ' '}offer`;
  $('#offer-meta').textContent = `confidence ${Math.round((o.confidence ?? 0) * 100)} % · ${o.frames} frames`;
  $('#offer-note').hidden = !o.note;
  $('#offer-note').textContent = o.note ?? '';
  $('#offer-cards').innerHTML = o.cards.map((c) => {
    const r = c.row;
    const rarity = c.rarity ?? o.rarity ?? 'silver';
    const verdict = c.verdict ?? 'unread';
    const stats = r
      ? `<div class="stats"><span class="tier ${esc(r.tier ?? '')}">${esc(r.tier ?? '·')}</span><span class="wr">${pct(r.winRate)}</span>${r.lift == null ? '' : `<span class="lift ${r.lift >= 0 ? 'pos' : 'neg'}">${signed(r.lift)}</span>`}<span class="games">${kfmt(r.games)}${r.games != null ? ' games' : ''}</span></div>`
      : `<div class="stats muted">${c.augmentId != null ? 'no data for this champion' : 'not recognised'}</div>`;
    return `<div class="card ${esc(rarity)} ${esc(verdict)}">
      <div class="ribbon ${esc(verdict)}">${esc(verdict.toUpperCase())}</div>
      ${r && r.icon ? img(r.icon, 'icon') : ''}
      <div class="name">${esc(c.name ?? '?')}</div>
      <div class="desc">${esc(r && r.description ? r.description : '')}</div>
      ${stats}
      ${c.ocrText && c.ocrText !== c.name ? `<div class="ocr">read as "${esc(c.ocrText)}"</div>` : ''}
    </div>`;
  }).join('');
}

function renderAugment(a) {
  const lift = a.lift == null ? '' : `<span class="lift ${a.lift >= 0 ? 'pos' : 'neg'}">${signed(a.lift)}</span>`;
  return `<div class="aug${a.lowSample ? ' low' : ''}" title="${esc(a.name)} · pick ${pct(a.pickRate)}">
    ${img(a.icon)}
    <div><div class="name"><span class="tier ${esc(a.tier ?? '')}">${esc(a.tier ?? '·')}</span>${esc(a.name)}</div><div class="games">${kfmt(a.games)} games · pick ${pct(a.pickRate)}</div></div>
    <div class="stats"><div class="wr">${pct(a.winRate)}</div>${lift}</div>
  </div>`;
}

const itemList = (items, sep = '') => items.map((i) => `<span class="item">${img(i.icon)}${esc(i.name)}</span>`).join(sep ? `<span class="arrow">${sep}</span>` : '');

function renderBuild(b) {
  if (!b) return '<div class="muted">–</div>';
  const p = b.primary;
  const alts = b.alternatives.length
    ? `<details class="alts"><summary>Other builds (${b.alternatives.length})</summary>${b.alternatives.map((a) => `<div>${esc(a.name)} · ${pct(a.winRate)} WR · ${pct(a.pickRate, 0)} pick · ${kfmt(a.games)}</div>`).join('')}</details>`
    : '';
  return `<div><strong>${esc(p.name)}</strong> <span class="muted">${pct(p.winRate)} WR · ${pct(p.pickRate, 0)} pick · ${kfmt(p.games)} games</span></div>
  <dl>
    <dt>Start</dt><dd class="items">${itemList(p.starter) || '–'}</dd>
    <dt>Boots</dt><dd class="items">${p.boots ? itemList([p.boots]) : '–'}</dd>
    <dt>Core (route ${pct(p.routeWinRate)} WR)</dt><dd class="items">${itemList(p.core, '›') || '–'}</dd>
    <dt>Later</dt><dd class="items">${itemList(p.later) || '–'}</dd>
    <dt>Spells</dt><dd>${esc(p.spells.join(' + ')) || '–'}</dd>
    <dt>Skills</dt><dd>${esc(p.skillOrder ?? '–')}</dd>
  </dl>${alts}`;
}

// ---- controls ----
async function setView(patch) {
  if (preview) { Object.assign(preview, patch); }
  else await api('/api/view', { method: 'POST', body: JSON.stringify(patch) });
  lastRendered = ''; lastRenderKey = '';
  tick();
}
$('#stage-tabs').addEventListener('click', (e) => { const s = e.target.dataset?.stage; if (s) setView({ stage: s }).catch((e2) => setBanner(e2.message)); });
$('#bracket-tabs').addEventListener('click', (e) => { const b = e.target.dataset?.bracket; if (b) setView({ bracket: b }).catch((e2) => setBanner(e2.message)); });
$('#refresh-btn').addEventListener('click', async () => {
  try {
    if (preview) await api(`/api/champ/${preview.id}?force=1&stage=${preview.stage}&bracket=${preview.bracket}`);
    else await api('/api/refresh', { method: 'POST', body: '{}' });
  } catch (e) { setBanner(e.message); }
  lastRendered = ''; lastRenderKey = ''; tick();
});
$('#live-btn').addEventListener('click', () => { preview = null; lastRendered = ''; lastRenderKey = ''; tick(); });
$('#capture-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/ocr/capture?save=1', { method: 'POST' });
    const s = r.summary ?? {};
    setBanner(`Captured: ${s.lines} lines, ${s.matched} matched → ${s.savedTo}`, 'warn');
  } catch (e) { setBanner(e.message); }
});
$('#offer-dismiss').addEventListener('click', () => { const o = JSON.parse(lastRendered || '{}').offer; dismissedOfferAt = o ? o.detectedAt : null; lastRendered = ''; lastRenderKey = ''; tick(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#offer').hidden) $('#offer-dismiss').click(); });

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const list = $('#search-results');
  if (!q) { list.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/api/champions?q=${encodeURIComponent(q)}`);
      list.innerHTML = results.map((c) => `<li data-id="${c.id}">${esc(c.name)}</li>`).join('');
      list.hidden = results.length === 0;
    } catch (e) { setBanner(e.message); }
  }, 200);
});
$('#search-results').addEventListener('click', (e) => {
  const id = e.target.dataset?.id;
  if (!id) return;
  const current = document.querySelector('#bracket-tabs .active')?.dataset.bracket ?? 'all';
  preview = { id: Number(id), stage: 'all', bracket: current };
  $('#search').value = '';
  $('#search-results').hidden = true;
  lastRendered = ''; lastRenderKey = '';
  tick();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#search-results').hidden = true; });

tick();
setInterval(tick, POLL_MS);
