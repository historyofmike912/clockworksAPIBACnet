// Offline unit tests (no platform or Clockworks needed): npm test
const os = require('os'), fs = require('fs'), path = require('path');
process.env.SPB_APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-unit-'));
const E = require('../lib/engine');
const C = require('../lib/clockworks');
const { records, f } = require('../lib/cwapi');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const cfg = { ...E.DEFAULT_SETTINGS.clockworks };
const D = n => new Date(Date.UTC(2026, 9, 14) - n * 86400000).toISOString();

// JSON:API parsing
const doc = { data: [{ type: 'Diagnostics', id: 7, attributes: { EID: 1, TotalPriority: 4 } }], included: [{ type: 'X', id: 8, attributes: { A: 1 } }] };
ok(records(doc)[0].id === 7 && records(doc)[0].EID === 1 && records(doc).length === 2, 'JSON:API data + included flattened');
ok(records({ data: [[{ id: 1, attributes: { a: 1 } }]] })[0].a === 1, 'nested array (as in one documented sample) handled');
ok(records([{ EID: 3 }])[0].EID === 3 && records({ value: [{ x: 1 }] })[0].x === 1, 'flat arrays and {value:[]} handled');
ok(f({ totalpriority: 5 }, 'TotalPriority') === 5, 'field names matched case-insensitively');

// fault logic
const eq = [{ id: 1, name: 'AHU-1' }, { id: 2, name: 'AHU-2' }];
let r = C.computeBuilding(cfg, eq, [
  { EID: 1, AID: 10, StartDate: D(0), TotalPriority: 6, EnergyPriority: 6, CostSavings: '10.10' },
  { EID: 1, AID: 10, StartDate: D(0), TotalPriority: 4, EnergyPriority: 4, CostSavings: 5 },   // same analysis twice = one fault
  { EID: 1, AID: 11, StartDate: D(2), TotalPriority: 9, ComfortPriority: 9, CostSavings: 1 },  // older than active window
  { EID: 2, AID: 12, StartDate: D(0), EnergyPriority: 3, ComfortPriority: 2 },                 // no TotalPriority: use max
], []);
ok(r.per[1].FaultCount === 1 && r.per[1].MaxPriority === 6 && r.per[1].ComfortPriority === 0, 'one fault per analysis; old results not active');
ok(r.per[1].AvoidableCost === 16.1, 'cost summed over the whole lookback, strings parsed');
ok(r.per[2].FaultActive && r.per[2].MaxPriority === 3, 'missing TotalPriority falls back to the highest component');
r = C.computeBuilding({ ...cfg, activeDays: 3 }, eq, [{ EID: 1, AID: 11, StartDate: D(2), TotalPriority: 9 }, { EID: 1, AID: 1, StartDate: D(0), TotalPriority: 2 }], []);
ok(r.per[1].FaultCount === 2, 'active window of 3 days includes the 2-day-old result');
r = C.computeBuilding({ ...cfg, priorityThreshold: 5 }, eq, [{ EID: 1, AID: 1, StartDate: D(0), TotalPriority: 4 }], []);
ok(!r.per[1].FaultActive && r.per[2].FaultCount === 0, 'threshold filters minor faults; fault-free equipment reports zeros');
r = C.computeBuilding(cfg, eq, [], [{ EID: 1, Status: 'Open' }, { EID: 1, Status: 'Completed' }, { EID: 2, Status: 'In Process' }, { Equipment: [1, 2], DateCompleted: '2026-01-01' }]);
ok(r.per[1].OpenTasks === 1 && r.per[2].OpenTasks === 1, 'open tasks counted; closed/completed excluded');

// request body
let b = C.diagBody(cfg, 3, 5817, '2026-10-07', '2026-10-14');
ok(JSON.stringify(b) === JSON.stringify({ CID: [3], BID: [5817], StartDate: '2026-10-07', EndDate: '2026-10-14', AnalysisInterval: 'Daily' }), 'default request matches the documented POST /diagnostics');
ok(C.diagBody({ ...cfg, analysisInterval: 'Weekly' }, 3, 1, 'a', 'z').AnalysisInterval === 'Weekly', 'analysis interval setting used');
b = C.diagBody({ ...cfg, diagPayload: '{"filter":{"Buildings":"{BID}","From":"{StartDate}"},"Range":"Weekly"}' }, 3, 9, 'a', 'z');
ok(b.filter.Buildings[0] === 9 && b.filter.From === 'a' && b.Range === 'Weekly', 'template placeholders substituted at any depth');

// values and names
const vals = C.equipmentValues({ ...cfg, metrics: 'FaultActive,AvoidableCost', includeTasks: false }, { id: 5, name: 'HQ / East' }, eq,
  { 1: { FaultActive: true, FaultCount: 1, AvoidableCost: 9, OpenTasks: 0 }, 2: { FaultActive: false, FaultCount: 0, AvoidableCost: 0, OpenTasks: 0 } });
ok(Object.keys(vals).length === 6 && vals['B5|E1|FaultActive'].path === 'HQ - East/AHU-1/FaultActive', 'metric list respected, building totals added, "/" replaced');
const m = E.loadMapping();
const pts = Object.entries(vals).map(([k, p]) => ({ uuid: C.uuidv5(k), attrs: { cw_path: p.path, datatype: p.type, ...(p.unit ? { engUnit: p.unit } : {}) }, latestValue: { v: p.value } }));
E.plan(m, pts);
const row = p => m.rows.find(x => x.path === p);
ok(row('HQ - East/AHU-1/FaultActive').objectType === 'bv' && row('HQ - East/AHU-1/AvoidableCost').units === 105, 'BV for FaultActive, currency units for cost');
ok(row('HQ - East/AHU-1/FaultActive').name === 'HQ_-_East.AHU-1.FaultActive', 'default name is Building.Equipment.Value');
ok(m.rows.every(x => x.enabled && !x.note), 'no Clockworks value is skipped');
ok(C.uuidv5('B1|E2|X') === C.uuidv5('B1|E2|X') && C.uuidv5('B1|E2|X') !== C.uuidv5('B1|E3|X'), 'point ids are stable per building/equipment/value');

console.log(fails ? `\n${fails} failed` : '\nall unit tests passed');
process.exit(fails ? 1 : 0);
