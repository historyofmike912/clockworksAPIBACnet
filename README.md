# clockworks-bacnet — Clockworks Analytics to BACnet

An Abound Normalizer application that pulls **Clockworks Analytics FDD results** through the Clockworks REST API and publishes them per piece of equipment as **BACnet local objects**, so WebCTRL can discover them, bind them into equipment graphics and alarm on them. No WebCTRL add-on and no external service: everything runs inside the Abound Normalizer, with no npm dependencies.

```
Clockworks API (rest.buildingsapi.net) → clockworks hook → points (layer clockworks) → sync hook → BACnet local objects → WebCTRL
```

It is built on the same engine as `sparkplug-bacnet`: the same mapping page, approval step, stable instance numbering, CSV import/export, device-offset spreading and Status_Flags handling.

## What gets published

Per equipment (choose which on Settings → Values per equipment):

| Value | Object | Meaning |
|---|---|---|
| `FaultActive` | BV | 1 when any analysis at or above the priority threshold appears in the active window |
| `FaultCount` | AV | Number of analyses with an active fault |
| `MaxPriority` | AV | Highest priority among active faults (Clockworks returns energy, comfort and maintenance priorities; the highest of the three is used) |
| `EnergyPriority`, `ComfortPriority`, `MaintenancePriority` | AV | Highest of each (Clockworks 0–10 scale) among active faults |
| `AvoidableCost` | AV (currency1) | Total avoidable cost over the lookback window |
| `OpenTasks` | AV | Clockworks tasks for this equipment that are not completed/closed |

Per building (optional): `_Building/FaultActive`, `FaultCount`, `AvoidableCost`, `OpenTasks`.
Link health: `_Clockworks/LinkOK` (BV) and `_Clockworks/MinutesSinceUpdate` (AV). Alarm on LinkOK in WebCTRL so a revoked key or blocked internet access does not go unnoticed.

Object names default to `Building.Equipment.Value` (for example `Dutchtown_HS.AHU-21.FaultActive`). Rename them on the Mapping tab or by CSV to match the WebCTRL equipment.

**Definitions you can tune** (Settings): *Analysis interval* (HalfDay, Daily, Weekly or Monthly results; default Daily), *Lookback* (days of diagnostics requested, default 7), *Active window* (a fault is active if it appears in the newest N days of results, default 1), *Priority threshold* (highest of the three priorities, default 1).

## API calls made

All read-only, with the subscription key in `Ocp-Apim-Subscription-Key`:

| Call | Used for |
|---|---|
| `GET /core-base/buildings` or `/core-base/clients/{id}/buildings` or `/core-base/buildings/{id}` | Building list (inactive buildings skipped) |
| `GET /core-base/buildings/{id}/equipment` | Equipment names and IDs (hidden equipment skipped) |
| `POST /core-diag/diagnostics` | Diagnostic records, one building per request: `EID`, `AID`, `StartDate`, `EnergyPriority`, `ComfortPriority`, `MaintenancePriority`, `CostSavings` |
| `POST /core-base/taskrecords` with `BID` and `Status: ["Open","In Process"]` | Open tasks (optional; falls back to `GET /core-base/buildings/{id}/taskrecords`) |

Paging (`links.next`, 1,000 per page) is followed automatically. One poll per hour (default) costs about three calls per building.

**Diagnostics request body** (from the Clockworks API documentation; `CID`, `StartDate`, `EndDate` and `AnalysisInterval` are required):
`{"CID":[79],"BID":[179],"StartDate":"2026-10-08","EndDate":"2026-10-15","AnalysisInterval":"Daily"}`.
The client ID comes from each building's `CID`. **Test connection** shows the request sent, the fields returned and a sample record, and flags any expected field that is missing. The **Diagnostics request template** setting exists only as an escape hatch for a different API version; leave it blank.

## Requirements

- Abound Normalizer 3.10 or later with BACnet/IP configured (device instance, interface)
- A Clockworks API subscription key and URL, requested from Clockworks Analytics (keys are scoped to the buildings the associated account can see)
- **Outbound HTTPS from the Abound Normalizer host to `rest.buildingsapi.net`** (port 443). Confirm this with site IT first; it is the most common blocker.
- Linux host or VM for WebCTRL discovery (Docker on Windows blocks BACnet broadcasts, as found at NVIDIA)

## Install

Same as sparkplug-bacnet: push this folder to a Git repository the platform can reach, then **Applications → + Create**, name `clockworks-bacnet`, enter the repository URL. Or use the local-copy method under `/var/nf/local-src/clockworks-bacnet` with the Git URL `file:///var/nf/local-src/clockworks-bacnet`.

Check the app's **Hooks** tab lists `api` (On Request), `sync` (Scheduled) and `clockworks` (Scheduled). If not, register them:

```bash
curl -s -X POST http://localhost:8080/api/v1/apps/clockworks-bacnet/hooks -H 'Content-Type: application/json' \
  -d '{"id":"api","name":"api","entryPoint":"/hooks/api.js","points":{"noPoints":true},"mode":"MODE_ON_REQUEST","invokeTimeout":"60s"}'
curl -s -X POST http://localhost:8080/api/v1/apps/clockworks-bacnet/hooks -H 'Content-Type: application/json' \
  -d '{"id":"sync","name":"sync","entryPoint":"/hooks/sync.js","points":{"noPoints":true},"schedule":{"rrule":"DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=1"},"mode":"MODE_SCHEDULED","invokeTimeout":"80s"}'
curl -s -X POST http://localhost:8080/api/v1/apps/clockworks-bacnet/hooks -H 'Content-Type: application/json' \
  -d '{"id":"clockworks","name":"clockworks","entryPoint":"/hooks/clockworks.js","points":{"noPoints":true},"schedule":{"rrule":"DTSTART:20260101T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=1"},"mode":"MODE_SCHEDULED","invokeTimeout":"80s"}'
```

## Set up

1. **Settings → Clockworks Analytics API.** Enter the API address and subscription key. Leave Client/Building IDs blank to see everything, then **Test connection**: it lists the buildings with their IDs, the equipment count, and a sample of diagnostics. Narrow to the site's buildings with **Building IDs**.
2. Turn **Poll Clockworks** on, **Save settings**, then **Poll now**.
3. **Mapping → Find values.** Every value becomes a draft. Disable the ones you don't want, rename to the site standard (or Export CSV, edit, Import CSV), then **Approve and publish**.
4. Discover the device in WebCTRL and bind the objects into each equipment's graphic; add an alarm on `FaultActive` and on `_Clockworks.LinkOK`.

A large portfolio is polled across several one-minute runs (the Activity tab shows "Poll in progress"), so the 80-second hook limit is never hit. The **Not-updating timeout** is raised automatically to at least two poll intervals: objects only show FAULT if Clockworks stops answering.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Cannot reach rest.buildingsapi.net" | Outbound HTTPS from the host (firewall/proxy). |
| HTTP 401 | Wrong or revoked subscription key. |
| HTTP 403 on a building | The key's account cannot see that building; remove it from Building IDs. |
| Diagnostics HTTP 400 | Test connection shows Clockworks' error text. Check the building's client ID (CID) is one the key can see. |
| `FaultCount` always 0 | Raise *Active window* to 2 if Clockworks posts daily results late in the day; check the *Priority threshold*. |
| Objects exist but WebCTRL doesn't see them | BACnet reachability (subnet, BBMD, UDP 47808), not the app. |

## Development

```bash
npm test       # offline unit tests (fault logic, request body, naming)
npm run e2e    # end to end against built-in mock Clockworks + mock Abound Normalizer (no lab kit needed)
```

Open `static/index.html?demo=1` to preview the page with sample data.
