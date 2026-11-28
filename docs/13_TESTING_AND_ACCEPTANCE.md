# I.T.S.S.B. — Testing and acceptance

**Intelligence Transportation System for School Buses**  
Status: tests to implement and execute; no hardware, Swift compilation, or field-pilot result is claimed by this documentation. [Documentation index](README.md).

## 1. What testing must establish

The first goal is correct data movement and understandable failure behavior. A map animating successfully is insufficient if the wrong family can access it, an old point looks current, or retrying a request creates duplicate runs.

Verify the smallest behavior that resolves a real risk. Prefer deterministic event sequences and cross-component checks over tests that merely repeat implementation code. Use fictional accounts and routes until the authorized pilot process permits real data.

## 2. Environments and fixtures

Maintain separate development and pilot/production backend deployments and app configurations. Name them visibly. Never let a GPS replay publisher silently target a live fleet. A test device should have its own credential and synthetic assignments.

Create fixtures for a straight route, a route that loops near a stop twice, two parallel nearby roads, a GPS gap, an out-of-order batch, a lost acknowledgment, and a completed/cancelled trip. Include at least two organizations, two drivers with different scopes, two students, a verified guardian, an unlinked guardian, and an account whose access is revoked during an active subscription.

Use the exact payloads and fields from [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md). A fixture should record input events, expected accepted/rejected outcomes, expected live state, and expected logical alerts. Freeze or control the clock when testing expiration and freshness.

## 3. Hardware checks before application debugging

| ID | Check | Passing evidence |
|---|---|---|
| H01 | Display and touch | Landscape image and touches agree in every corner; no hidden required controls |
| H02 | Assembly and cooling | Secure desk assembly, correct connections, measured normal behavior under intended workload |
| H03 | USB receiver detection | Correct receiver visible to OS and GPSD without competing readers |
| H04 | Outdoor positioning | Usable real fix with plausible capture time and coordinates |
| H05 | Network versus backend | Local network availability and authenticated backend health can be shown independently |
| H06 | Local storage | Known database path, controlled write/read, available space and cleanup behavior |

The desk checks do not establish vehicle mounting or electrical suitability. Those belong in a separately authorized installation and pilot review described in [02_HARDWARE_ASSEMBLY.md](02_HARDWARE_ASSEMBLY.md).

## 4. Critical device/backend integration cases

| ID | Stimulus | Required observable result |
|---|---|---|
| D01 | Start the same logical run twice using one requestId | One run is returned; no duplicate start |
| D02 | Lose a telemetry response after commit, then retry | One event exists; retry returns duplicate/accepted semantics without another alert |
| D03 | Send one valid, one duplicate, and one rejected event in a batch | Each has its own explicit outcome; only acknowledged items leave the outbox |
| D04 | Deliver older observations after a newer one | History is retained while live position remains the newest eligible observation |
| D05 | Stop and restart the collector during an active run | Same run recovers; new process bootId; persisted runSequence continues |
| D06 | Restart the graphical interface only | Background collection and pending state remain intact |
| D07 | Disconnect bus internet while GPS remains valid | Local queue grows; family view ages; no fabricated successful synchronization |
| D08 | Reconnect with a backlog | Fresh tracking resumes promptly; bounded history replay does not trigger old alerts |
| D09 | Remove GPS/fix while internet remains available | Health reports loss; last valid point retains its timestamp; unsupported ETA is withheld |
| D10 | Send invalid coordinates, nonfinite values, future time, or conflicting duplicate content | Server rejects/quarantines according to contract; live state is not corrupted |
| D11 | Approach an already served stop on a route loop | Stop order prevents an early/duplicate arrival |
| D12 | Near full disk or queue limit | Visible health warning and documented bounded behavior; unacknowledged events are not silently discarded as successful |
| D13 | End a trip offline and reconnect | Local completion remains explicit; backend eventually accepts once; obsolete alerts stop |
| D14 | Cancel or replace an active assignment through authorized staff workflow | Clients receive the correct current status and explicit assignment history |
| D15 | End the local run while a GPS write is in flight, then restart | Atomic completion/outbox boundary survives; no new telemetry is committed beyond the frozen final sequence |

Use controlled service/network interruptions first. Do not begin by repeatedly pulling power from a working microSD. Later power-interruption tests require a recoverable fixture and the intended power design; database transactions cannot guarantee survival of arbitrary storage hardware failure.

## 5. Authorization and enrollment cases

| ID | Stimulus | Required result |
|---|---|---|
| A01 | Student directly requests another assignment/run | Denied or safely unavailable without protected data |
| A02 | Driver changes a different driver's unauthorized route | Rejected on the server even if a request is manually constructed |
| A03 | Device claims another bus/run in JSON | Credential-derived scope wins; request is rejected |
| A04 | Guardian enters a known student's name | No relationship or tracking access is granted |
| A05 | Guardian link revoked during subscription | New reads are denied; known client state is cleared; future alerts stop |
| A06 | Enrollment token expires or belongs to another purpose | Specific recoverable error without disclosure of private records |
| A07 | Student chooses an ineligible stop | Server rejects the selection; client offers permitted recovery |
| A08 | Driver removes a student from own route | Confirmed, reasoned, audited assignment change; account and unrelated history remain |
| A09 | Same removal is queued offline | Pending label remains until server acceptance; no claim of immediate global revocation |
| A10 | Sign-out and account switch | Old cached student data, subscription, and push association cannot leak into new context |

Also test failed/replayed authentication, role selection without approval, disabled devices, expired offline authority if later introduced, and cross-organization identifiers across every public endpoint. See [security](11_SECURITY_PRIVACY_AND_ACCESS.md).

## 6. QR and check-in cases

The test suite should distinguish enrollment, student check-in, and staff-recorded correction. Test two legitimate students using the same currently displayed trip QR; both should be able to record their own eligible event. Repeating the same student's scan should produce Already recorded rather than another attendance record.

Reject a wrong-run, expired, wrong-purpose, removed-assignment, or unauthorized scan. A scan without server communication must not show confirmed acceptance. A guardian cannot submit a remote boarding claim simply because they can view the student's trip.

Test correction with a reason, correction queued offline, and correction by an unauthorized driver. Preserve provenance and audit history. Keep the non-phone student workflow functional.

## 7. iPhone-specific acceptance

Use unit tests for domain formatting/state transitions, repository tests with fixture streams, and UI tests for important user journeys. Exercise hardware-specific camera, permission, push, and connectivity behavior on real iPhones; simulator-only success does not establish all of those behaviors.

Verify all I01-I28 states from [06_IOS_SWIFT_APP.md](06_IOS_SWIFT_APP.md). Include denied camera/notification/optional-location permissions; invalid and expired codes; app backgrounding; foreground refresh; expired sessions; stale timestamps; and alerts opened after a run completed.

Switch selected students while old subscription results are in flight. The previous student's coordinates must never appear under the newly selected student's name. Cancel old work or guard it with the current selection generation. Reconnect without creating multiple visible subscriptions or duplicate mutations.

Test large text, VoiceOver descriptions, contrast, reduced motion, keyboard coverage, small supported screens, map panning versus Follow bus, and readable non-map summaries. A missing basemap must not erase the textual trip status.

For numerical contracts, use fixtures with normal coordinates, null optional numbers, safe integer counters, and epoch-millisecond timestamps. Confirm expected Swift Convex wrappers and milliseconds-to-seconds conversion. [Convex type conversion](https://docs.convex.dev/client/swift/data-types).

## 8. Notification acceptance

Test the logical event and delivery attempt separately. Verify one logical approaching alert per intended recipient/run/stop/type, even after GPS retry, action retry, or process restart. A meaningful later change needs an explicit rule rather than notifying on every sample.

Check expired jobs, cancellation, revocation, changed device tokens, sign-out, transient delivery errors, and ambiguous network responses. A provider acknowledgment is not evidence that a person viewed the notification. Push taps must reauthorize and fetch current state rather than trusting stale content.

Background iOS updates are not a continuous tracking transport. Test normal foreground resubscription and state refresh rather than assuming a hidden app will run a five-second timer. [Apple background-update documentation](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app).

## 9. ETA evaluation

Record each prediction at the time it is made, its source observation, model/baseline version, stop, and later observed arrival label. Build the arrival labels from independently checked stop events, not the prediction itself.

Hold out complete later runs. Report baseline and learned-model results on the same unseen runs, with error by prediction horizon. Include typical error, a high-percentile error, and coverage: an algorithm that hides nearly every estimate should not appear superior simply because only its easiest cases were scored.

Measure detours, GPS outages, and unusual delays separately. Uncertainty ranges need demonstrated coverage. Any target such as a two-minute error is a target until the evaluation supports it. See [ETA guide](10_ETA_AI_AND_NOTIFICATIONS.md) and [scikit-learn leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html).

## 10. Measured performance and endurance

Track observed capture-to-server delay, current position age, reconnect recovery time, upload retry count, queue growth, memory use, CPU temperature, disk growth, restarts, and notification job age. With a 2GB Pi, test the actual browser and background-service combination over the intended operating duration.

Where to read them: the Pi's health (`/health`, driver screen D21) and every heartbeat carry upload failures in a row, retries since the device software started, the last error class, service memory, memory available, CPU temperature and database size (docs/08 §7); a value the Pi cannot read is `null` ("not available on this device"). Staff Diagnostics shows the latest heartbeat's values per device with their age, queue depth and oldest pending item, restarts (as a new `bootId`), and push job age: the oldest job still waiting to send and 24 h counts by state. Delay and reconnect time still come from the drill tools and the backend's receipt times.

Use realistic fixture volume and viewer counts before deciding capacity. The proposed five-second observation cadence is not a latency guarantee or a cellular bill estimate. Distinguish application payload from protocol overhead, map traffic, replay, updates, and per-viewer downloads.

Avoid invented universal pass limits. Agree on pilot targets from the actual service requirements, record them before the test, and report measured values with conditions. Functional invariants such as no unauthorized disclosure or no duplicate logical start remain strict gates.

## 11. Evidence and release gates

| Gate | Minimum evidence |
|---|---|
| Bench demo | Hardware checks, real GPS-to-phone path, correct account access, visible freshness |
| Resilient prototype | Retry/outage/restart cases, independent GPS/network failures, stable run identity |
| Feature-complete V1 | Enrollment, guardian, roster, QR, removal, correction, all named states, alert handling |
| Authorized pilot | Approved installation/power/connectivity and data process, recovery/support ownership, measured behavior |
| Broader deployment | Representative pilot evidence, capacity evaluation, restore/rollback rehearsal, supported device matrix |

For each executed case, record build versions, backend environment, fixture/run ID, date, expected result, observed result, and a concise evidence link. Mark blocked or unexecuted cases honestly. Keep screenshots/logs free of unnecessary real student information.

## 12. Resilient-prototype evidence (roadmap Phase 5)

Recorded 2026-11-26 against the development backend, with fictional data only. Two 9-minute Pi drills used the bench Pi in its own folder, a dedicated fictional device credential, and a server-issued run started through `POST /device/v1/trip-events`. The bench receiver reports no device indoors, so Pi positions came from the fake GPSD. The link outage was simulated with `devtools/link_proxy.py`, which refuses connections while down. The OS was not rebooted. On 2026-11-27, with the Pi offline, the same drill ran on the Mac against the development backend on a separate fictional route, while the family query was read as a fictional student every 15 s. The steps for the real network pull, stopping the real GPSD, and an OS reboot are in [runbooks/pi-outage-drill.md](runbooks/pi-outage-drill.md).

| Case | Automated test (layer) | Pi drill (`devtools/outage_drill.py`) | Result |
|---|---|---|---|
| D01 duplicate start | `tripEvents.test.ts` "a retried start returns the same run" (backend); `test_runs_api.py` lost-response retry (device) | — | Pass |
| D02 lost response | `test_outages.py::test_d02` (device process + fake backend); `telemetry.test.ts` idempotent duplicate | — (the proxy refuses connections, so no answer was lost after a commit) | Pass |
| D03 mixed batch | `test_uploader.py::test_results_are_applied_per_event`; `telemetry.test.ts` one result per event | — | Pass |
| D04 out of order | `telemetry.test.ts` late observation kept as history, live unchanged | — | Pass |
| D05 restart mid-run | `test_outages.py::test_d05` (kill -9 during an outage); `test_service.py` SIGTERM + kill | kill -9 while the link was down, twice: same run, a new bootId each time. Backend and Pi hold the same 312 eventIds, runSequence 0–311 unbroken across 5 boots | Pass (process restart). OS reboot: owner runbook, not yet run |
| D06 interface restart only | `test_driver_api.py::test_d06_page_sessions_opening_reloading_and_closing_never_pause_collection` (device: pages open, reload, unlock, lock and reopen between recorder ticks) | Four driver page sessions opened and closed during drill 3; collection never paused | Pass |
| D07 bus internet loss | `test_outages.py::test_d07_d08` | Queue grew to about 37 rows, 73 s behind; GPS stayed valid; the driver screen showed "School server: Not reachable" and the queue count. Live family query: the position aged to 81 s and was never shown as current | Pass (simulated link). Real network pull: owner runbook, not yet run |
| D08 reconnect with backlog | `test_uploader.py` D08 tests (failed before the fix in #35); `test_outages.py::test_d07_d08` (newest first) | First acknowledgement 4.0 s after the link returned in both drills; backlog cleared within 2 s | Pass |
| D09 GPS loss, internet up | Device: `test_outages.py::test_d09`, `test_health.py`. Backend: `health.test.ts`. Clients: web `tracking.test.ts` D09 gating, iOS `testGpsProblemNeedsRecentContact` | GPS `no_fix`, last fix kept its time, nothing recorded, network and backend ok; the driver screen showed "GPS: No fix — last fix 36 s ago" | Pass. Live on dev: the backend stored the Pi's `no_fix` heartbeat within 30 s, and the student's `tracking:myRun` showed `no_fix` within one heartbeat, then cleared it when a newer position arrived |
| D10 invalid / conflicting | `validate.test.ts` (NaN, range, future); `telemetry.test.ts` content conflict | — | Pass |
| D13 end trip offline | `test_runs_api.py` end completes locally, stays pending, retries the same request | — | Pass (device); backend `tripEvents.test.ts` |
| D15 end during a write | `test_recorder.py::test_d15_run_ended_between_check_and_write_commits_nothing` and `test_recorder.py::test_d15_restart_after_the_race_records_nothing_past_the_final_sequence` (device); `tripEvents.test.ts` final sequence boundary (backend) | — | Pass |
| D12 near full disk or queue limit | Device: `test_storage.py` (fake free space and a filled outbox: warning with numbers, critical reduces recording, no pending row deleted or acknowledged, recovery, cleanup keeps pending and rejected rows). Driver screen: `indicators.test.ts` D12 cases, including that reduced recording does not block a start | Not run on the Pi (no real full disk) | Pass (simulated disk) |
| D14 cancel or replace | Backend `tripStatus.test.ts`: staff cancel → `cancelled` with no position and no staff reason; replace → `pending`, then the started replacement is the tracked run; completed → `completed`; another route's run, a previous day's run, an unrelated account, and other days' calendar entries all excluded. Each exclusion test fails when its filter is removed. Clients: web `tripStatus.test.ts`, iOS `TripNoticesTests` (mapping, malformed entries, end-of-day expiry, copy). Staff history: backend `runHistory.test.ts` (cancel and replace give start, removals, cancellation with staff name and reason, and the replacement link in time order; the replacement links back and says who ended it; a sent-but-not-started replacement shows no link; a driver removal queued offline counts by its capture time; another route's removals and removals outside the run excluded; non-staff and signed-out callers denied; families get nothing new). Each fails with its guard removed. Web `staff.test.ts` `runHistoryLines` | Not run on a dev deployment | Pass in tests: current status for families and explicit history for staff |
| D11 | Not in this milestone: route progress and alerts (Phase 8) | — | Not run |

Phone internet loss is a client state. Web shows a "Connection lost" banner and never calls the position fresh while disconnected (`live.test.ts`). iOS does the same: while the phone reconnects, the status card says "Reconnecting — Your phone lost its connection" and never calls the position fresh (`TrackViewModelTests`, `StatusCopyTests`, `LivePresentationTests` connection-lost cases). Starting up is not treated as lost.

The live PR for this phase holds the drill transcripts and screenshots.

## 13. Documentation checks for this pack

Before delivering or revising the pack, verify internal Markdown links, complete screen inventories, consistent API fields, well-formed example JSON, balanced code fences, and clear template labels. These checks validate the documentation; they do not substitute for the hardware/application tests above.
