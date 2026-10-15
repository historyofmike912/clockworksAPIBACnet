/**
 * Clockworks Analytics poller. Turns Clockworks FDD results into per-equipment values on the app's
 * own point layer, which the BACnet sync then publishes exactly like any other source point.
 *
 * Each poll cycle walks the configured buildings one at a time:
 *   GET  /core-base/buildings/{id}/equipment      equipment list (names, ids)
 *   POST /core-diag/diagnostics                   diagnostic records for the lookback window (one building per request,
 *                                                 as Clockworks recommends, to keep paging down)
 *   POST /core-base/taskrecords                   open / in-process tasks for the building (optional)
 * and writes, per equipment:
 *   FaultActive (BV), FaultCount, MaxPriority, EnergyPriority, ComfortPriority, MaintenancePriority,
 *   AvoidableCost, OpenTasks (AV)
 * plus building totals and two link-health values (_Clockworks/LinkOK, _Clockworks/MinutesSinceUpdate).
 *
 * A cycle that does not fit in one hook run (80 s limit) carries on from the saved cursor next run.
 * Read-only toward Clockworks: only GET and the documented POST retrieval are used.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cwClient, f } = require('./cwapi');
const E = require('./engine');

const DIR = path.dirname(E.FILES.mapping);
const FILES = {
  state: path.join(DIR, 'clockworks.json'),
  status: path.join(DIR, 'clockworks-status.json'),
  lock: path.join(DIR, 'clockworks.lock'),
};
const NS = '3b0c2a52-8a9e-4f6e-b1d4-6c7e2f0a9d13';
const DAY = 86400000;

const METRICS = [
  ['FaultActive', 'Boolean', '', 'Any diagnostic at or above the priority threshold in the active window'],
  ['FaultCount', 'Float', '', 'Number of analyses with an active fault'],
  ['MaxPriority', 'Float', '', 'Highest priority (max of energy, comfort, maintenance) among active faults'],
  ['EnergyPriority', 'Float', '', 'Highest energy priority among active faults (0-10)'],
  ['ComfortPriority', 'Float', '', 'Highest comfort priority among active faults (0-10)'],
  ['MaintenancePriority', 'Float', '', 'Highest maintenance priority among active faults (0-10)'],
  ['AvoidableCost', 'Float', 'currency1', 'Sum of avoidable cost over the lookback window'],
  ['OpenTasks', 'Float', '', 'Open Clockworks tasks for this equipment'],
];
const BUILDING_METRICS = ['FaultActive', 'FaultCount', 'AvoidableCost', 'OpenTasks'];

function uuidv5(name, ns = NS) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(Buffer.concat([nsb, Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const seg = s => String(s == null ? '' : s).replace(/\//g, '-').trim() || '?';
const ids = s => String(s || '').split(/[,\s;]+/).map(x => x.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n));
const ymd = t => new Date(t).toISOString().slice(0, 10);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const truthy = v => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v));

function config(mapping) { return { ...E.DEFAULT_SETTINGS.clockworks, ...(mapping.settings.clockworks || {}) }; }

// ------------------------------------------------------------------ requests
/** POST /core-diag/diagnostics body, per the Clockworks API documentation:
 *  CID (required, single-element array), BID, StartDate/EndDate ("YYYY-MM-DD", required) and
 *  AnalysisInterval ("HalfDay" | "Daily" | "Weekly" | "Monthly", required). A site can still override it
 *  on Settings with a JSON template using "{CID}", "{BID}", "{StartDate}", "{EndDate}", "{AnalysisInterval}". */
function interval(cfg) { return cfg.analysisInterval || cfg.analysisRange || 'Daily'; }
function diagBody(cfg, cid, bid, start, end) {
  const vars = { '{CID}': cid == null ? [] : [cid], '{BID}': [bid], '{StartDate}': start, '{EndDate}': end,
    '{AnalysisInterval}': interval(cfg), '{AnalysisRange}': interval(cfg) };
  const tpl = String(cfg.diagPayload || '').trim();
  if (!tpl) {
    const b = {};
    if (cid != null) b.CID = [cid];
    Object.assign(b, { BID: [bid], StartDate: start, EndDate: end, AnalysisInterval: interval(cfg) });
    return b;
  }
  const sub = v => (typeof v === 'string' && v in vars ? vars[v]
    : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
  let parsed;
  try { parsed = JSON.parse(tpl); } catch (e) { throw new Error('Diagnostics request template is not valid JSON: ' + e.message); }
  return sub(parsed);
}

async function resolveBuildings(cw, cfg) {
  const want = ids(cfg.buildingIds);
  if (want.length) {
    const out = [];
    for (const id of want) {
      const r = (await cw.all('GET', `/core-base/buildings/${id}`))[0];
      if (!r) throw new Error(`Building ${id} not found or not allowed for this key`);
      out.push({ id: Number(f(r, 'id', 'BID') ?? id), name: f(r, 'BuildingName') || `Building ${id}`, cid: f(r, 'CID') ?? null });
    }
    return out;
  }
  const cids = ids(cfg.clientIds);
  const recs = [];
  if (cids.length) for (const c of cids) recs.push(...(await cw.all('GET', `/core-base/clients/${c}/buildings`)).map(r => ({ ...r, CID: f(r, 'CID') ?? c })));
  else recs.push(...await cw.all('GET', '/core-base/buildings'));
  return recs.filter(r => f(r, 'IsActive') !== false && f(r, 'IsActive') !== 0)
    .map(r => ({ id: Number(f(r, 'id', 'BID')), name: f(r, 'BuildingName') || `Building ${f(r, 'id')}`, cid: f(r, 'CID') ?? null }))
    .filter(b => Number.isFinite(b.id));
}

// ------------------------------------------------------------------ metrics
/** Diagnostic records + equipment + tasks for one building → { equipmentId: { metric: value } }. */
function computeBuilding(cfg, equipment, diags, tasks) {
  const thr = num(cfg.priorityThreshold);
  const activeDays = Math.max(1, num(cfg.activeDays) || 1);
  const dateOf = r => { const t = Date.parse(f(r, 'StartDate', 'Date', 'AnalysisDate') || ''); return isNaN(t) ? null : t; };
  const dates = diags.map(dateOf).filter(t => t !== null);
  const newest = dates.length ? Math.max(...dates) : null;
  const activeFrom = newest === null ? Infinity : newest - (activeDays - 1) * DAY;

  const per = {};
  const blank = () => ({ FaultActive: false, FaultCount: 0, MaxPriority: 0, EnergyPriority: 0, ComfortPriority: 0,
    MaintenancePriority: 0, AvoidableCost: 0, OpenTasks: 0, _aids: new Set() });
  for (const e of equipment) per[e.id] = blank();
  for (const r of diags) {
    const eid = Number(f(r, 'EID'));
    if (!Number.isFinite(eid)) continue;
    const m = per[eid] || (per[eid] = blank());
    m.AvoidableCost += num(f(r, 'CostSavings', 'AvoidableCost', 'Cost'));
    const t = dateOf(r);
    // The API returns the three priorities (0-10) but no total: a diagnostic's priority is the highest of them.
    const ep = num(f(r, 'EnergyPriority')), cp = num(f(r, 'ComfortPriority')), mp = num(f(r, 'MaintenancePriority'));
    const tp = f(r, 'TotalPriority') !== undefined ? num(f(r, 'TotalPriority')) : Math.max(ep, cp, mp);
    if ((t === null || t >= activeFrom) && tp >= thr && tp > 0) {
      m._aids.add(f(r, 'AID') ?? f(r, 'AnalysisName') ?? f(r, 'id'));
      m.MaxPriority = Math.max(m.MaxPriority, tp);
      m.EnergyPriority = Math.max(m.EnergyPriority, ep);
      m.ComfortPriority = Math.max(m.ComfortPriority, cp);
      m.MaintenancePriority = Math.max(m.MaintenancePriority, mp);
    }
  }
  for (const t of tasks) {
    if (!isOpenTask(t)) continue;
    for (const eid of taskEquipment(t)) { const m = per[eid] || (per[eid] = blank()); m.OpenTasks++; }
  }
  for (const m of Object.values(per)) {
    m.FaultCount = m._aids.size; m.FaultActive = m.FaultCount > 0;
    m.AvoidableCost = Math.round(m.AvoidableCost * 100) / 100;
    delete m._aids;
  }
  return { per, newest };
}

function isOpenTask(t) {
  if (f(t, 'DateCompleted')) return false;
  const s = String(f(t, 'Status', 'StatusName', 'TaskStatus') || '');
  return !/complete|closed|resolved|cancel|done|reject/i.test(s);
}
/** Open tasks for one building: POST /core-base/taskrecords filtered by building and status (documented);
 *  falls back to GET /buildings/{id}/taskrecords if the filtered retrieval is refused. */
async function openTasks(cw, b, deadline) {
  const body = { BID: [b.id], Status: ['Open', 'In Process'] };
  if (b.cid != null) body.CID = [b.cid];
  try { return await cw.all('POST', '/core-base/taskrecords', body, deadline); }
  catch (e) {
    if (e.status === 401) throw e; // bad key: no point trying the other route
    return cw.all('GET', `/core-base/buildings/${b.id}/taskrecords`, undefined, deadline);
  }
}
function taskEquipment(t) {
  const one = f(t, 'EID', 'EquipmentID');
  if (one != null) return [Number(one)];
  const list = f(t, 'Equipment');
  if (Array.isArray(list)) return list.map(x => Number(typeof x === 'object' ? f(x, 'EID', 'EquipmentID', 'id') : x)).filter(Number.isFinite);
  return [];
}

// ------------------------------------------------------------------ platform points
function pointFor(cfg, key, p) {
  return {
    uuid: uuidv5(`${cfg.layer}|${key}`), name: p.path, layer: cfg.layer, protocol_id: key,
    parent_name: p.path.split('/').slice(0, -1).join('/'),
    attrs: { cw_path: p.path, cw_key: key, building_id: String(p.bid ?? ''), equipment_id: String(p.eid ?? ''),
      metric_name: p.metric, datatype: p.type, ...(p.unit ? { engUnit: p.unit } : {}) },
  };
}
function valueBody(v) { return typeof v === 'boolean' ? { boolean: v } : { real: Number(v) }; }

async function ensureLayer(api, cfg) {
  try {
    const res = await api.get(`/api/v1/point/layers/${encodeURIComponent(cfg.layer)}`);
    if ((res.layers || []).length) return;
  } catch (e) { if (e.status && e.status !== 404 && e.status !== 400) throw e; }
  const layer = { name: cfg.layer, description: 'Clockworks FDD results from the clockworks-bacnet app', indexed: true,
    structuredComponents: ['cw_path', 'building_id', 'equipment_id', 'metric_name', 'datatype'].map(n => ({ name: n, type: 'TAG' })) };
  try { await api.post('/api/v1/point/layers', { layer: { kind: 'LAYER_BASE', ...layer } }); }
  catch (e) { await api.post('/api/v1/point/layers', { layer }); }
}

/** Write a batch of { key: {path, metric, type, unit, value, bid, eid} } as points + values. */
async function writeValues(api, cfg, st, batch, ts, say) {
  const entries = Object.entries(batch);
  const fresh = entries.filter(([k]) => !st.known[k]);
  for (let i = 0; i < fresh.length; i += 250) {
    const chunk = fresh.slice(i, i + 250);
    await api.post('/api/v1/point/points', { points: chunk.map(([k, p]) => pointFor(cfg, k, p)) });
    for (const [k, p] of chunk) st.known[k] = { uuid: pointFor(cfg, k, p).uuid, path: p.path, type: p.type, unit: p.unit || '' };
    say('info', `added ${chunk.length} new value(s) as points`);
  }
  let written = 0, errors = 0, first = '';
  for (const [k, p] of entries) {
    const known = st.known[k];
    known.path = p.path; known.ts = ts; // the poll time: stale only if polling stops
    if (known.last === p.value) continue;
    try {
      await api.post('/api/v1/point/data', { uuid: known.uuid, values: [{ ts, ...valueBody(p.value) }] });
      known.last = p.value; written++;
    } catch (e) { errors++; if (!first) first = e.message; }
  }
  if (errors) say('error', `${errors} value write(s) failed: ${first}`);
  return written;
}

function equipmentValues(cfg, b, eq, per) {
  const out = {};
  const want = new Set(String(cfg.metrics || METRICS.map(m => m[0]).join(',')).split(',').map(s => s.trim()).filter(Boolean));
  if (!truthy(cfg.includeTasks)) want.delete('OpenTasks');
  for (const e of eq) {
    const m = per[e.id]; if (!m) continue;
    for (const [metric, type, unit] of METRICS) {
      if (!want.has(metric)) continue;
      out[`B${b.id}|E${e.id}|${metric}`] = { path: `${seg(b.name)}/${seg(e.name)}/${metric}`, metric, type, unit, value: m[metric], bid: b.id, eid: e.id };
    }
  }
  if (truthy(cfg.buildingTotals)) {
    const all = eq.map(e => per[e.id]).filter(Boolean);
    const tot = {
      FaultActive: all.some(m => m.FaultActive), FaultCount: all.reduce((s, m) => s + m.FaultCount, 0),
      AvoidableCost: Math.round(all.reduce((s, m) => s + m.AvoidableCost, 0) * 100) / 100,
      OpenTasks: all.reduce((s, m) => s + m.OpenTasks, 0),
    };
    for (const metric of BUILDING_METRICS) {
      if (!want.has(metric)) continue;
      const def = METRICS.find(x => x[0] === metric);
      out[`B${b.id}|ALL|${metric}`] = { path: `${seg(b.name)}/_Building/${metric}`, metric, type: def[1], unit: def[2], value: tot[metric], bid: b.id };
    }
  }
  return out;
}

function linkValues(st, ok) {
  const age = st.lastComplete ? Math.round((Date.now() - Date.parse(st.lastComplete)) / 60000) : -1;
  return {
    'SITE|LinkOK': { path: '_Clockworks/LinkOK', metric: 'LinkOK', type: 'Boolean', unit: '', value: !!ok },
    'SITE|MinutesSinceUpdate': { path: '_Clockworks/MinutesSinceUpdate', metric: 'MinutesSinceUpdate', type: 'Float', unit: 'minutes', value: age },
  };
}

// ------------------------------------------------------------------ one hook run
async function runPoll({ maxSeconds, force } = {}) {
  const mapping = E.loadMapping();
  const cfg = config(mapping);
  const status = E.readJson(FILES.status, { log: [] });
  const say = (level, msg) => E.log(status, level, 'Clockworks: ' + msg);
  if (!cfg.enabled || !cfg.subscriptionKey) {
    status.enabled = false; E.writeJson(FILES.status, status);
    return { skipped: 'Clockworks polling is off or has no subscription key' };
  }
  const lock = E.readJson(FILES.lock, null);
  if (lock && Date.now() - lock.at < 90000) return { skipped: 'another Clockworks run is active' };
  E.writeJson(FILES.lock, { at: Date.now(), pid: process.pid });

  const st = E.readJson(FILES.state, { known: {}, layerReady: false, cycle: null, lastComplete: null, buildings: {} });
  const api = E.client(mapping.settings);
  const cw = cwClient(cfg);
  const deadline = Date.now() + 1000 * (maxSeconds ?? Math.min(55, Number(mapping.settings.runSeconds) || 50));
  const ts = new Date().toISOString();
  let ok = status.linkOk !== false, written = 0, done = 0;
  status.enabled = true;
  try {
    if (!st.layerReady) { await ensureLayer(api, cfg); st.layerReady = true; say('info', `layer ${cfg.layer} ready`); }
    const due = !st.lastComplete || Date.now() - Date.parse(st.lastComplete) >= num(cfg.pollMinutes) * 60000;
    if (!st.cycle && (due || force)) {
      const buildings = await resolveBuildings(cw, cfg);
      if (!buildings.length) throw new Error('No buildings found for this key (check Client IDs / Building IDs)');
      st.cycle = { startedAt: ts, idx: 0, buildings };
      say('info', `poll started: ${buildings.length} building(s)`);
    }
    if (st.cycle) {
      const end = Date.now(), start = end - Math.max(1, num(cfg.lookbackDays) || 7) * DAY;
      while (st.cycle.idx < st.cycle.buildings.length && Date.now() < deadline) {
        const b = st.cycle.buildings[st.cycle.idx];
        try {
          const eqRecs = await cw.all('GET', `/core-base/buildings/${b.id}/equipment`, undefined, deadline);
          const eq = eqRecs.filter(e => f(e, 'IsVisible') !== false && f(e, 'IsVisible') !== 0)
            .map(e => ({ id: Number(f(e, 'id', 'EID')), name: f(e, 'EquipmentName') || `Equipment ${f(e, 'id')}` }))
            .filter(e => Number.isFinite(e.id));
          const diags = await cw.all('POST', '/core-diag/diagnostics', diagBody(cfg, b.cid, b.id, ymd(start), ymd(end)), deadline);
          let tasks = [];
          if (truthy(cfg.includeTasks)) {
            try { tasks = await openTasks(cw, b, deadline); }
            catch (e) { say('warn', `${b.name}: tasks unavailable (${e.message}); OpenTasks left unchanged`); tasks = null; }
          }
          const { per, newest } = computeBuilding(cfg, eq, diags, tasks || []);
          const vals = equipmentValues(cfg, b, eq, per);
          if (tasks === null) for (const k of Object.keys(vals)) if (k.endsWith('|OpenTasks')) delete vals[k];
          written += await writeValues(api, cfg, st, vals, ts, say);
          const faults = Object.values(per).filter(m => m.FaultActive).length;
          st.buildings[b.id] = { name: b.name, at: ts, equipment: eq.length, diagnostics: diags.length, faulted: faults,
            newestDiagnostic: newest ? new Date(newest).toISOString() : null, error: '' };
          done++;
        } catch (e) {
          st.buildings[b.id] = { ...(st.buildings[b.id] || {}), name: b.name, at: ts, error: e.message };
          say('error', `${b.name}: ${e.message}`);
          if (e.status === 401 || e.status === 403) throw e; // bad key: stop the whole cycle
        }
        st.cycle.idx++;
        E.writeJson(FILES.state, st);
        E.writeJson(FILES.lock, { at: Date.now(), pid: process.pid });
      }
      if (st.cycle.idx >= st.cycle.buildings.length) {
        const errs = st.cycle.buildings.filter(b => (st.buildings[b.id] || {}).error).length;
        st.lastComplete = new Date().toISOString();
        ok = errs < st.cycle.buildings.length;
        say(errs ? 'warn' : 'info', `poll complete: ${st.cycle.buildings.length} building(s)` + (errs ? `, ${errs} with errors` : ''));
        st.cycle = null;
      }
    }
    status.error = ok ? '' : 'Every building failed in the last poll';
  } catch (e) {
    ok = false; status.error = e.message; say('error', e.message);
    if (e.status === 401 || e.status === 403) st.cycle = null;
  } finally {
    try { written += await writeValues(api, cfg, st, linkValues(st, ok), ts, say); } catch (e) { /* platform API down: shown by sync */ }
    status.linkOk = ok; status.lastRun = ts; status.lastComplete = st.lastComplete; status.calls = cw.calls;
    status.inProgress = st.cycle ? `${st.cycle.idx} of ${st.cycle.buildings.length} buildings` : '';
    status.values = Object.keys(st.known).length; status.buildings = st.buildings;
    E.writeJson(FILES.state, st); E.writeJson(FILES.status, status);
    try { fs.unlinkSync(FILES.lock); } catch (e) { /* gone */ }
  }
  return { buildingsPolled: done, written, values: Object.keys(st.known).length, inProgress: status.inProgress, error: status.error || '' };
}

/** Settings-page check: key, buildings, one building's equipment and a sample of its diagnostics. */
async function testConnection(cfgIn) {
  const mapping = E.loadMapping();
  const cfg = { ...config(mapping), ...(cfgIn || {}) };
  const cw = cwClient(cfg);
  const out = { ok: false, steps: [] };
  const step = (name, okv, detail) => out.steps.push({ name, ok: okv, detail });
  try {
    if (!cfg.subscriptionKey) throw new Error('Enter the subscription key first');
    const buildings = await resolveBuildings(cw, cfg);
    step('Buildings', true, `${buildings.length} found: ` + buildings.slice(0, 8).map(b => `${b.name} (${b.id})`).join(', ') + (buildings.length > 8 ? ', …' : ''));
    out.buildings = buildings.slice(0, 200);
    const b = buildings[0];
    if (!b) throw new Error('No buildings found for this key');
    const eq = await cw.all('GET', `/core-base/buildings/${b.id}/equipment`);
    step('Equipment', true, `${eq.length} in ${b.name}`);
    const end = Date.now(), start = end - Math.max(1, num(cfg.lookbackDays) || 7) * DAY;
    const body = diagBody(cfg, b.cid, b.id, ymd(start), ymd(end));
    out.diagRequest = body;
    try {
      const d = await cw.all('POST', '/core-diag/diagnostics', body);
      step('Diagnostics', true, `${d.length} record(s) in the last ${cfg.lookbackDays} day(s)`);
      out.diagFields = d[0] ? Object.keys(d[0]) : [];
      out.diagSample = d.slice(0, 5);
      const missing = ['EID', 'AID', 'StartDate', 'EnergyPriority', 'ComfortPriority', 'MaintenancePriority', 'CostSavings'].filter(k => d[0] && f(d[0], k) === undefined);
      if (missing.length) step('Diagnostic fields', false, 'Not found in the response: ' + missing.join(', ') + '. Send the sample below to Abound support.');
    } catch (e) {
      step('Diagnostics', false, e.message + (e.body ? ' Response: ' + e.body.slice(0, 300) : ''));
      throw new Error('Diagnostics request failed; adjust the request template on Settings if Clockworks expects different field names');
    }
    if (truthy(cfg.includeTasks)) {
      try { const t = await openTasks(cw, b); step('Tasks', true, `${t.filter(isOpenTask).length} open or in-process task(s) in ${b.name}`); out.taskFields = t[0] ? Object.keys(t[0]) : []; }
      catch (e) { step('Tasks', false, e.message); }
    }
    out.ok = out.steps.every(s => s.ok);
  } catch (e) { out.error = e.message; }
  out.calls = cw.calls;
  return out;
}

/** Re-poll on the next hook run regardless of the schedule. */
function requestPoll() {
  const st = E.readJson(FILES.state, { known: {} });
  st.lastComplete = null; E.writeJson(FILES.state, st);
}

module.exports = { runPoll, testConnection, requestPoll, computeBuilding, diagBody, equipmentValues, isOpenTask, uuidv5, FILES, METRICS };
