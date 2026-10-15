/**
 * Minimal client for the Clockworks Analytics REST API (Azure API Management on rest.buildingsapi.net).
 * No npm dependencies. Every call sends the subscription key in Ocp-Apim-Subscription-Key.
 *
 *   core-base  clients, buildings, equipment, task records   (GET, paged 1,000 per page with links.next)
 *   core-diag  POST /diagnostics                              (diagnostic records with priorities and cost)
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

class CwError extends Error {}

function cwClient(cfg) {
  const base = String(cfg.baseUrl || 'https://rest.buildingsapi.net').replace(/\/+$/, '');
  const key = cfg.subscriptionKey || '';
  const timeout = Number(cfg.timeoutS || 30) * 1000;
  let calls = 0;

  function request(method, pathOrUrl, body) {
    const u = new URL(/^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      Accept: 'application/vnd.api+json, application/json',
      'Ocp-Apim-Subscription-Key': key,
      ApiVersion: String(cfg.apiVersion || '1.0'),
    };
    if (cfg.apiDocVersion) headers.ApiDocVersion = String(cfg.apiDocVersion);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const mod = u.protocol === 'https:' ? https : http;
    calls++;
    return new Promise((resolve, reject) => {
      const req = mod.request(u, { method, headers, timeout }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            let msg = text.slice(0, 300);
            try { const j = JSON.parse(text); msg = j.message || j.Message || j.error || msg; } catch (e) { /* raw */ }
            const hint = res.statusCode === 401 ? ' (check the subscription key)'
              : res.statusCode === 403 ? ' (the key is not allowed this resource)'
              : res.statusCode === 429 ? ' (rate limited: poll less often)' : '';
            const err = new CwError(`Clockworks ${method} ${u.pathname} -> HTTP ${res.statusCode}${hint}: ${msg}`);
            err.status = res.statusCode; err.body = text.slice(0, 2000);
            return reject(err);
          }
          try { resolve(text ? JSON.parse(text) : {}); }
          catch (e) { reject(new CwError(`Clockworks ${method} ${u.pathname}: response was not JSON`)); }
        });
      });
      req.on('timeout', () => req.destroy(new CwError(`Clockworks ${method} ${u.pathname} timed out after ${timeout / 1000} s`)));
      req.on('error', e => reject(e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT'
        ? new CwError(`Cannot reach ${u.host} (${e.code}): check outbound internet access from the Abound Normalizer host`) : e));
      if (data) req.write(data);
      req.end();
    });
  }

  /** Follow links.next until done (or the deadline passes). Returns flattened records. */
  async function all(method, path, body, deadline = Infinity) {
    const out = [];
    let doc = await request(method, path, body);
    for (let guard = 0; ; guard++) {
      out.push(...records(doc));
      const next = doc && doc.links && doc.links.next;
      if (!next || guard > 500 || Date.now() > deadline) break;
      doc = await request(method === 'POST' ? 'POST' : 'GET', next, method === 'POST' ? body : undefined);
    }
    return out;
  }

  return {
    base, get calls() { return calls; },
    request,
    get: p => request('GET', p),
    post: (p, b) => request('POST', p, b),
    all,
  };
}

/**
 * JSON:API document → plain records. Each record is { id, type, ...attributes }.
 * Also accepts flat arrays and { data: [...] } with flat items. Records in "included"
 * (used by some nested routes) are returned too, after the primary data.
 */
function records(doc) {
  if (!doc) return [];
  const flat = x => (x && typeof x === 'object' && x.attributes ? { id: x.id, type: x.type, ...x.attributes } : x);
  let data = Array.isArray(doc) ? doc : doc.data !== undefined ? doc.data : doc.value !== undefined ? doc.value : [];
  if (!Array.isArray(data)) data = [data];
  data = data.flat(); // one documented sample nests the array
  const out = data.filter(Boolean).map(flat);
  if (Array.isArray(doc.included)) out.push(...doc.included.map(flat));
  return out;
}

/** Case-insensitive field read: f(rec, 'TotalPriority', 'Priority'). */
function f(rec, ...names) {
  if (!rec) return undefined;
  for (const n of names) {
    if (n in rec) return rec[n];
    const k = Object.keys(rec).find(x => x.toLowerCase() === n.toLowerCase());
    if (k) return rec[k];
  }
  return undefined;
}

module.exports = { cwClient, records, f, CwError };
