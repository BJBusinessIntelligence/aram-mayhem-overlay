import http from 'node:http';
import https from 'node:https';

function request(url, { method, payload, headers = {}, timeoutMs = 1500, rejectUnauthorized = false }) {
  const mod = url.startsWith('http:') ? http : https;
  // Fixed-length body: without content-length, Node sends Transfer-Encoding: chunked,
  // which some servers (the League client's) reject.
  const reqHeaders = payload == null ? headers : { ...headers, 'content-length': Buffer.byteLength(payload) };
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers: reqHeaders, rejectUnauthorized, timeout: timeoutMs }, (res) => {
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
    if (payload != null) req.write(payload);
    req.end();
  });
}

// GET a JSON document. rejectUnauthorized=false is intended ONLY for 127.0.0.1
// (League client / Live Client Data use self-signed certificates).
export function httpsGetJson(url, { headers = {}, timeoutMs = 1500, rejectUnauthorized = false } = {}) {
  return request(url, { method: 'GET', payload: null, headers, timeoutMs, rejectUnauthorized });
}

// Send a JSON body (PATCH/PUT/POST) and parse the JSON reply. Same TLS caveat as httpsGetJson.
export function httpsSendJson(url, { method = 'POST', body = null, headers = {}, timeoutMs = 3000, rejectUnauthorized = false } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return request(url, { method, payload, headers: { 'content-type': 'application/json', ...headers }, timeoutMs, rejectUnauthorized });
}
