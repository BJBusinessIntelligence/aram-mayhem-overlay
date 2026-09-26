import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseView(q) {
  const out = {};
  if (q.stage !== undefined) {
    const s = String(q.stage);
    if (s === 'auto' || s === 'all') out.stage = s;
    else if (['1', '2', '3', '4'].includes(s)) out.stage = Number(s);
    else throw new Error(`invalid stage: ${s}`);
  }
  if (q.bracket !== undefined) {
    if (!['all', 'high'].includes(q.bracket)) throw new Error(`invalid bracket: ${q.bracket}`);
    out.bracket = q.bracket;
  }
  return out;
}

export function createServer({ state, champIndex, publicDir, watcher = null }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = Object.fromEntries(url.searchParams);
      const p = url.pathname;

      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        return send(res, 200, await fs.readFile(path.join(publicDir, file)), type);
      }
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, state.snapshot());
      if (req.method === 'GET' && p === '/api/champions') return send(res, 200, champIndex.search(q.q ?? '', 10));

      const m = p.match(/^\/api\/champ\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const view = parseView(q);
        const payload = await state.preview(Number(m[1]), { bracket: view.bracket ?? 'all', stage: view.stage ?? 'auto', force: q.force === '1' });
        return send(res, 200, payload);
      }
      if (req.method === 'POST' && p === '/api/view') {
        const body = JSON.parse((await readBody(req)) || '{}');
        await state.setView(parseView(body));
        return send(res, 200, state.snapshot());
      }
      if (req.method === 'POST' && p === '/api/refresh') {
        await state.refresh();
        return send(res, 200, state.snapshot());
      }
      if ((req.method === 'GET' || req.method === 'POST') && p === '/api/ocr/capture') {
        if (!watcher) return send(res, 503, { error: 'OCR not configured' });
        const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
        // Query params win over the JSON body so a plain `curl.exe -X POST ".../capture?save=1"`
        // (no body, PowerShell-safe) works the same as a POST body under any shell.
        const region = (q.region !== undefined ? q.region : body.region) === 'full' ? 'full' : 'band';
        const save = q.save !== undefined ? (q.save === '1' || q.save === 'true') : body.save === true;
        let result;
        try {
          result = await watcher.captureOnce({ region, save });
        } catch (e) {
          return send(res, 502, { error: e && e.message ? e.message : String(e) });
        }
        const summary = {
          lines: (result.capture && result.capture.lines) ? result.capture.lines.length : 0,
          matched: result.match ? result.match.matched : 0,
          rarity: result.match ? result.match.rarity : null,
          savedTo: result.savedTo ?? null,
        };
        return send(res, result.capture && result.capture.ok ? 200 : 502, { ...result, summary });
      }
      if (req.method === 'POST' && p === '/api/ocr') {
        if (!watcher) return send(res, 503, { error: 'OCR not configured' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
        watcher.setEnabled(body.enabled);
        return send(res, 200, state.snapshot());
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e && e.name === 'DataUnavailable' ? 503 : 400;
      return send(res, status, { error: e && e.message ? e.message : String(e) });
    }
  });
}
