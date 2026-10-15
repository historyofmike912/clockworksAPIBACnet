// Test doubles: a mock Clockworks REST API (JSON:API shaped, 1,000-record pages, subscription key)
// and a mock Abound Normalizer (points + BACnet local objects). Both are plain http servers.
const http = require('http');

const DAYMS = 86400000;
const day = n => new Date(Date.now() - n * DAYMS).toISOString().slice(0, 10) + 'T00:00:00';

function body(req) { return new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : null)); }); }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/vnd.api+json' }); res.end(JSON.stringify(obj)); }

/** opts.diagFails: make POST /diagnostics answer 400 (to test error reporting). */
function clockworksMock(opts = {}) {
  const KEY = opts.key || 'testkey';
  const buildings = [
    { id: 5817, BuildingName: 'Dutchtown HS', CID: 1, IsActive: true },
    { id: 5820, BuildingName: 'Big Campus/North', CID: 1, IsActive: true },
    { id: 5999, BuildingName: 'Closed Annex', CID: 1, IsActive: false },
  ];
  const equipment = { 5817: [], 5820: [] };
  equipment[5817].push({ id: 94008, BID: 5817, EquipmentName: '(DTH) AHU-21', IsActive: true, IsVisible: true });
  equipment[5817].push({ id: 94009, BID: 5817, EquipmentName: 'VAV-2-14', IsActive: true, IsVisible: true });
  equipment[5817].push({ id: 94010, BID: 5817, EquipmentName: 'Hidden', IsActive: true, IsVisible: false });
  for (let i = 0; i < 1200; i++) equipment[5820].push({ id: 200000 + i, BID: 5820, EquipmentName: `VAV-${i}`, IsActive: true, IsVisible: true });
  const diags = {
    5817: [
      // AHU-21: two analyses active today, one only last week (not active), one below threshold
      { ID: 1, AID: 11, EID: 94008, BID: 5817, StartDate: day(0), AnalysisName: 'Economizer', EnergyPriority: 6, ComfortPriority: 2, MaintenancePriority: 1, TotalPriority: 7, CostSavings: 120.5 },
      { ID: 2, AID: 12, EID: 94008, BID: 5817, StartDate: day(0), AnalysisName: 'Simultaneous heat/cool', EnergyPriority: 4, ComfortPriority: 5, MaintenancePriority: 3, TotalPriority: 5, CostSavings: 80 },
      { ID: 3, AID: 11, EID: 94008, BID: 5817, StartDate: day(1), AnalysisName: 'Economizer', EnergyPriority: 6, ComfortPriority: 2, MaintenancePriority: 1, TotalPriority: 7, CostSavings: 110 },
      { ID: 4, AID: 13, EID: 94008, BID: 5817, StartDate: day(5), AnalysisName: 'Fan schedule', EnergyPriority: 9, ComfortPriority: 0, MaintenancePriority: 0, TotalPriority: 9, CostSavings: 40 },
      { ID: 5, AID: 14, EID: 94009, BID: 5817, StartDate: day(0), AnalysisName: 'Damper', EnergyPriority: 0.5, ComfortPriority: 0, MaintenancePriority: 0, TotalPriority: 0.5, CostSavings: 2 },
    ],
    5820: [{ ID: 9, AID: 21, EID: 200005, BID: 5820, StartDate: day(0), AnalysisName: 'Reheat', EnergyPriority: 3, ComfortPriority: 8, MaintenancePriority: 2, TotalPriority: 8, CostSavings: 15 }],
  };
  const tasks = {
    5817: [
      { id: 185144, EID: 94008, Summary: 'Fix economizer', Status: 'In Process', DateCompleted: null },
      { id: 185145, EID: 94008, Summary: 'Old one', Status: 'Completed', DateCompleted: '2026-09-01' },
      { id: 185146, EID: 94009, Summary: 'Damper', Status: 'Open' },
    ],
    5820: [],
  };
  const calls = [];
  const page = (res, all, path, n) => {
    const size = 1000, last = Math.max(0, Math.ceil(all.length / size) - 1);
    const links = { self: path, first: `${path}?page[number]=0&spko=k1` };
    if (n < last) links.next = `http://localhost:${srv.address().port}${path}?page[number]=${n + 1}&spko=k1`;
    send(res, 200, { metadata: { ApiVersion: '1.0' }, data: all.slice(n * size, (n + 1) * size).map(r => {
      const { id, ...a } = r; return { type: 'X', id, attributes: a }; }), links });
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${u.pathname}`);
    if (req.headers['ocp-apim-subscription-key'] !== KEY) return send(res, 401, { statusCode: 401, message: 'Access denied due to invalid subscription key.' });
    const n = Number(u.searchParams.get('page[number]') || 0);
    let m;
    if (req.method === 'GET' && (u.pathname === '/core-base/buildings' || u.pathname === '/core-base/clients/1/buildings')) return page(res, buildings, u.pathname, n);
    if (req.method === 'GET' && (m = u.pathname.match(/^\/core-base\/buildings\/(\d+)$/))) {
      const b = buildings.find(x => x.id === Number(m[1])); return b ? page(res, [b], u.pathname, 0) : send(res, 404, { message: 'not found' });
    }
    if (req.method === 'GET' && (m = u.pathname.match(/^\/core-base\/buildings\/(\d+)\/equipment$/))) return page(res, equipment[m[1]] || [], u.pathname, n);
    if (req.method === 'GET' && (m = u.pathname.match(/^\/core-base\/buildings\/(\d+)\/taskrecords$/))) return page(res, tasks[m[1]] || [], u.pathname, n);
    if (req.method === 'POST' && u.pathname === '/core-diag/diagnostics') {
      const b = await body(req);
      if (opts.diagFails) return send(res, 400, { message: 'Invalid payload: AnalysisRange is required' });
      // documented: CID (single-element array), StartDate, EndDate and AnalysisInterval are required
      if (!b || !Array.isArray(b.CID) || b.CID.length !== 1 || !b.StartDate || !b.EndDate || !['HalfDay', 'Daily', 'Weekly', 'Monthly'].includes(b.AnalysisInterval))
        return send(res, 400, { message: 'CID, StartDate, EndDate and AnalysisInterval are required' });
      const all = (b.BID || []).flatMap(id => (diags[id] || []).filter(d => d.StartDate.slice(0, 10) >= b.StartDate));
      // the documented response has no TotalPriority
      return page(res, all.map(({ ID, TotalPriority, ...d }) => ({ id: ID, AEID: ID + 1000, ...d })), u.pathname, n);
    }
    if (req.method === 'POST' && u.pathname === '/core-base/taskrecords') {
      const b = await body(req) || {};
      const want = b.Status || ['Open', 'In Process', 'Completed'];
      const all = (b.BID || Object.keys(tasks).map(Number)).flatMap(id => tasks[id] || []).filter(t => want.includes(t.Status));
      return page(res, all, u.pathname, n);
    }
    send(res, 404, { statusCode: 404, message: 'Resource not found' });
  });
  return { srv, calls, diags, tasks };
}

function normalizerMock() {
  const layers = new Set(), points = new Map(), data = new Map(), objs = new Map();
  const k = (off, type, inst) => `${off}|${type}|${inst}`;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let m;
    if (u.pathname === '/api/v1/platform/info') return j(200, { version: 'mock-3.10' });
    if (req.method === 'GET' && (m = u.pathname.match(/^\/api\/v1\/point\/layers\/(.+)$/))) return j(200, { layers: layers.has(decodeURIComponent(m[1])) ? [{ name: m[1] }] : [] });
    if (req.method === 'POST' && u.pathname === '/api/v1/point/layers') { const b = await body(req); layers.add(b.layer.name); return j(200, {}); }
    if (req.method === 'POST' && u.pathname === '/api/v1/point/points') { const b = await body(req); for (const p of b.points) points.set(p.uuid, p); return j(200, {}); }
    if (req.method === 'POST' && u.pathname === '/api/v1/point/data') {
      const b = await body(req); if (!points.has(b.uuid)) return j(404, { message: 'no such point' });
      data.set(b.uuid, b.values[b.values.length - 1]); return j(200, {});
    }
    if (u.pathname === '/api/v1/bacnet/local') {
      const off = Number(u.searchParams.get('local_device_instance_offset') || 0);
      if (req.method === 'GET') return j(200, { objects: [...objs.values()].filter(o => o.off === off).map(o => ({ objectId: o.objectId, props: o.props })) });
      const b = await body(req);
      const key = k(b.local_device_instance_offset || 0, b.object_id.object_type, b.object_id.instance);
      if (req.method === 'POST') {
        if (objs.has(key)) return j(409, { message: 'exists' });
        objs.set(key, { off: b.local_device_instance_offset || 0, objectId: { objectType: b.object_id.object_type, instance: b.object_id.instance }, props: b.props.map(p => ({ ...p })) });
        return j(200, {});
      }
      if (req.method === 'PATCH') {
        const o = objs.get(key); if (!o) return j(404, { message: 'no such object' });
        for (const p of b.props) { const i = o.props.findIndex(x => x.property === p.property); if (i >= 0) o.props[i] = p; else o.props.push(p); }
        return j(200, {});
      }
    }
    if (req.method === 'DELETE' && (m = u.pathname.match(/^\/api\/v1\/bacnet\/local\/([A-Z_]+)\/(\d+)$/))) {
      const key = k(Number(u.searchParams.get('local_device_instance_offset') || 0), m[1], Number(m[2]));
      if (!objs.delete(key)) return j(404, { message: 'no such object' }); return j(200, {});
    }
    j(404, { message: 'not found ' + req.method + ' ' + u.pathname });
  });
  return { srv, layers, points, data, objs };
}

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
module.exports = { clockworksMock, normalizerMock, listen };
