// Usage: node scripts/ocr-capture.js [--full] [--save data/debug/frame.png] [--json out.json]
// Replay a saved band: --image frame.png --frame-w 3440 --frame-h 1440 --offset-x 516 --offset-y 288
// Captures once with the same worker the app uses, prints lines with positions, exits.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createOcrWorker } from '../src/ocr/worker.js';
import { parseArgs } from '../src/config.js';

const args = parseArgs(process.argv.slice(2));
const worker = createOcrWorker({ log: (m) => console.error(m) });
if (!worker.isAvailable()) { console.error('OCR is Windows-only'); process.exit(2); }
const saveTo = args.save ? path.resolve(args.save) : null;
if (saveTo) await fs.mkdir(path.dirname(saveTo), { recursive: true });
const r = await worker.capture({ region: args.full === 'true' ? 'full' : 'band', saveTo,
  ...(args.image ? { imagePath: path.resolve(args.image), frameW: Number(args['frame-w']), frameH: Number(args['frame-h']), offsetX: Number(args['offset-x'] ?? 0), offsetY: Number(args['offset-y'] ?? 0) } : {}) });
worker.stop();
if (!r.ok) { console.error('capture failed:', r.error); process.exit(1); }
console.log(`frame ${r.w}x${r.h} window=${r.window} ms=${r.ms} lines=${r.lines.length}${saveTo && !r.saveError ? ` saved=${saveTo}` : ''}`);
if (r.color) console.log('capture:', JSON.stringify(r.color));
for (const l of r.lines) console.log(String(l.x).padStart(5), String(l.y).padStart(5), String(l.w).padStart(5), String(l.h).padStart(3), ' ', l.text);
if (args.json) { await fs.writeFile(path.resolve(args.json), JSON.stringify(r, null, 2)); console.log('wrote', args.json); }

if (r.saveError) { console.error('screenshot save failed:', r.saveError); process.exitCode = 1; }
