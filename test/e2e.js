// End-to-end: mock Clockworks API → clockworks hook → mapping → BACnet objects on a mock Abound Normalizer.
// Self-contained (starts its own mocks): node test/e2e.js
const fs = require('fs'), os = require('os'), path = require('path');
const { clockworksMock, normalizerMock, listen } = require('./mocks');

const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };

(async () => {
  const cwm = clockworksMock(), nfm = normalizerMock();
  const cwPort = await listen(cwm.srv), nfPort = await listen(nfm.srv);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwb-'));
  process.env.SPB_APP_DIR = tmp;
  process.env.NF_API_URL = `http://127.0.0.1:${nfPort}`;
  const api = require('../hooks/api.js');
  const E = require('../lib/engine');
  const C = require('../lib/clockworks');
  let rid = 0;
  const call = async (action, extra = {}) => {
    const id = 'testrid-' + String(++rid).padStart(10, '0');
    await api({ args: { key: 'req', value: JSON.stringify({ action, rid: id, ...extra }) } });
    return JSON.parse(fs.readFileSync(path.join(tmp, 'static', '_rpc', id + '.json'), 'utf8'));
  };
  const BASE = `http://127.0.0.1:${cwPort}`;
  const obj = name => [...nfm.objs.values()].find(o => o.props.some(p => p.property === 'PROP_OBJECT_NAME' && Object.values(p.value)[0] === name));
  const pv = o => o && Object.values((o.props.find(p => p.property === 'PROP_PRESENT_VALUE') || {}).value || {})[0];
  const flags = o => o && ((o.props.find(p => p.property === 'PROP_STATUS_FLAGS') || {}).value || {}).bit_string;

  // ---- nothing happens until configured
  let r = await C.runPoll();
  ok(/off/.test(r.skipped), 'poll is idle until enabled');

  // ---- test connection
  r = await call('cwTest', { clockworks: { baseUrl: BASE, subscriptionKey: 'wrong' } });
  ok(!r.test.ok && /401/.test(r.test.error) && /subscription key/.test(r.test.error), 'bad key reported: ' + r.test.error);
  r = await call('cwTest', { clockworks: { baseUrl: 'http://127.0.0.1:1', subscriptionKey: 'x' } });
  ok(!r.test.ok && /Cannot reach/.test(r.test.error), 'unreachable API reported: ' + r.test.error);
  r = await call('cwTest', { clockworks: { baseUrl: BASE, subscriptionKey: 'testkey' } });
  ok(r.test.ok && r.test.buildings.length === 2, 'test connection OK, inactive building skipped: ' + r.test.steps.map(s => s.name + ' ' + s.detail).join(' | '));
  ok(r.test.diagFields.includes('EnergyPriority') && r.test.diagRequest.BID[0] === 5817 && r.test.diagRequest.CID[0] === 1 && r.test.diagRequest.AnalysisInterval === 'Daily',
    'documented request sent (CID, BID, dates, AnalysisInterval); fields shown');
  ok(r.test.steps.every(s => s.ok), 'no expected diagnostic field missing');

  // ---- settings
  r = await call('settings', { settings: { clockworks: { enabled: 'true', baseUrl: BASE, subscriptionKey: 'testkey', pollMinutes: 60, includeTasks: 'true' } } });
  ok(r.settings.clockworks.subscriptionKey === '********' && r.settings.clockworks.enabled === true, 'settings saved, key masked');
  ok(r.settings.staleS >= 2 * 3600, `stale timeout raised to two poll intervals (${r.settings.staleS} s)`);
  r = await call('settings', { settings: { clockworks: { subscriptionKey: '********' } } });
  ok(E.loadMapping().settings.clockworks.subscriptionKey === 'testkey', 'masked key on save keeps the stored key');
  r = await call('settings', { settings: { clockworks: { diagPayload: '{bad json' } } });
  ok(!r.ok && /JSON/.test(r.error), 'broken request template rejected: ' + r.error);

  // ---- a poll that runs out of time continues next run
  r = await C.runPoll({ maxSeconds: 0 });
  ok(r.inProgress === '0 of 2 buildings' && r.buildingsPolled === 0, 'poll cycle carries over when out of time: ' + r.inProgress);
  r = await C.runPoll();
  ok(!r.error && r.buildingsPolled === 2 && !r.inProgress, `poll completed: ${JSON.stringify(r)}`);
  const expected = (2 * 8 + 4) + (1200 * 8 + 4) + 2;
  ok(r.values === expected, `${r.values} values (2 + 1,200 equipment over 2 pages, totals, link health)`);
  ok(cwm.calls.filter(c => c.endsWith('/buildings/5820/equipment')).length === 2, 'equipment list followed links.next across 2 pages');
  r = await C.runPoll();
  ok(r.buildingsPolled === 0, 'next run within the poll interval makes no Clockworks calls');

  // ---- mapping
  r = await call('plan');
  ok(r.added === expected, `Find values added ${r.added} drafts`);
  const row = p => r.rows.find(x => x.path === p);
  const fa = row('Dutchtown HS/(DTH) AHU-21/FaultActive'), cost = row('Dutchtown HS/(DTH) AHU-21/AvoidableCost');
  ok(fa.objectType === 'bv' && cost.objectType === 'av' && cost.units === 105, 'FaultActive → BV, AvoidableCost → AV in currency1');
  ok(row('Big Campus-North/VAV-5/FaultActive'), '"/" in a building name kept out of the path');
  ok(!r.rows.some(x => /Hidden/.test(x.path)), 'equipment hidden in Clockworks is skipped');
  const offs = {}; for (const x of r.rows) offs[x.deviceOffset] = (offs[x.deviceOffset] || 0) + 1;
  ok(Math.max(...Object.values(offs)) <= 250, 'large portfolio spread across device offsets');

  // publish building 5817 + link health only
  const keys = r.rows.filter(x => x.path.startsWith('Dutchtown HS/') || x.path.startsWith('_Clockworks/')).map(x => x.key);
  r = await call('approve', { keys, by: 'test' });
  ok(r.ok && r.created === keys.length && r.failed === 0, `approved and created ${r.created} objects`);
  let s = await E.runScheduled({ maxSeconds: 0 });
  ok(s.last.updated === keys.length && s.last.errors === 0, `sync wrote ${s.last.updated} values`);

  const N = n => fa.name.replace('FaultActive', n);
  ok(pv(obj(fa.name)) === 1, 'AHU-21 FaultActive = active');
  ok(pv(obj(N('FaultCount'))) === 2, 'AHU-21 FaultCount = 2 (week-old and below-threshold results excluded)');
  ok(pv(obj(N('MaxPriority'))) === 6 && pv(obj(N('ComfortPriority'))) === 5 && pv(obj(N('MaintenancePriority'))) === 3, 'priorities = highest among active faults (no TotalPriority in the API)');
  ok(pv(obj(N('AvoidableCost'))) === 350.5, 'AvoidableCost = 7-day total (350.5)');
  ok(pv(obj(N('OpenTasks'))) === 1, 'OpenTasks = 1 (completed task excluded)');
  const vav = 'Dutchtown_HS.VAV-2-14.';
  ok(pv(obj(vav + 'FaultActive')) === 0 && pv(obj(vav + 'OpenTasks')) === 1, 'VAV-2-14: below threshold = no fault; open task counted');
  ok(cwm.calls.includes('POST /core-base/taskrecords') && !cwm.calls.some(c => c.endsWith('/taskrecords') && c.startsWith('GET')), 'tasks read with the filtered POST /core-base/taskrecords');
  ok(pv(obj('Dutchtown_HS._Building.FaultCount')) === 2 && pv(obj('Dutchtown_HS._Building.AvoidableCost')) === 352.5, 'building totals');
  ok(pv(obj('_Clockworks.LinkOK')) === 1, 'LinkOK = 1');
  ok([...nfm.points.values()].every(p => p.layer === 'clockworks') && nfm.layers.has('clockworks'), 'values also stored as points on the clockworks layer');

  // ---- the fault clears in Clockworks → BACnet follows on the next poll
  cwm.diags[5817] = cwm.diags[5817].filter(d => d.EID !== 94008 || d.StartDate < new Date(Date.now() - 86400000 * 3).toISOString());
  cwm.diags[5817].push({ ID: 99, AID: 99, EID: 94009, BID: 5817, StartDate: new Date().toISOString().slice(0, 10) + 'T00:00:00', TotalPriority: 1, EnergyPriority: 1, CostSavings: 1 });
  r = await call('cwPollNow');
  ok(!r.error && r.buildingsPolled === 2, 'Poll now re-polls immediately');
  s = await E.runScheduled({ maxSeconds: 0 });
  ok(pv(obj(fa.name)) === 0 && pv(obj(N('FaultCount'))) === 0, 'AHU-21 fault cleared');
  ok(pv(obj(N('AvoidableCost'))) === 40, 'cost now only the older result (40)');

  // ---- bad key: link goes down, equipment values flagged stale once the timeout passes
  await call('settings', { settings: { clockworks: { subscriptionKey: 'revoked' } } });
  r = await call('cwPollNow');
  ok(/401/.test(r.error), 'revoked key stops the poll: ' + r.error);
  await E.runScheduled({ maxSeconds: 0 });
  ok(pv(obj('_Clockworks.LinkOK')) === 0, 'LinkOK = 0 in BACnet');
  const m = E.loadMapping(); m.settings.staleS = 1; E.saveMapping(m);
  await new Promise(res => setTimeout(res, 1500));
  await C.runPoll(); // the minute hook retries; its failure refreshes the link values
  s = await E.runScheduled({ maxSeconds: 0 });
  ok(flags(obj(fa.name)).set_bits.includes(1) && !flags(obj('_Clockworks.LinkOK')).set_bits.length, 'equipment objects FAULT; LinkOK itself stays fresh');
  const st = await call('status');
  ok(st.clockworks.linkOk === false && /401/.test(st.clockworks.error) && !('subscriptionKey' in st.clockworks), 'status shows the link error (no key exposed)');

  // ---- request template override
  await call('settings', { settings: { clockworks: { subscriptionKey: 'testkey', diagPayload: '{"CID":"{CID}","BID":"{BID}","StartDate":"{StartDate}","EndDate":"{EndDate}","AnalysisInterval":"{AnalysisInterval}","Extra":1}' } } });
  r = await call('cwTest', { clockworks: {} });
  ok(r.test.ok && r.test.diagRequest.Extra === 1 && Array.isArray(r.test.diagRequest.BID), 'request template applied');

  // ---- CSV round trip renames to WebCTRL standard
  r = await call('exportCsv');
  const csv = r.csv.replace(fa.name, 'AHU21_CW_FAULT');
  r = await call('importCsv', { csv });
  ok(r.changed === 1 && r.reset === 1, 'CSV rename returns one row to draft');

  console.log('\nall end-to-end checks passed');
  cwm.srv.close(); nfm.srv.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
