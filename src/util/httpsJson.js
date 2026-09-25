import http from 'node:http';
import https from 'node:https';

// GET a JSON document. rejectUnauthorized=false is intended ONLY for 127.0.0.1
// (League client / Live Client Data use self-signed certificates).
export function httpsGetJson(url, { headers = {}, timeoutMs = 1500, rejectUnauthorized = false } = {}) {
  const mod = url.startsWith('http:') ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'GET', headers, rejectUnauthorized, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        if (text.length) { try { body = JSON.parse(text); } catch { body = text; } }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}
