# I.T.S.S.B. — Data contracts and API

**Intelligence Transportation System for School Buses**  
**Status:** Canonical proposed version 1 contract for the documentation pack. These endpoint and function names must be implemented; they are not supplied by installing Convex or FastAPI.

Read alongside [Pi software](04_RASPBERRY_PI_SOFTWARE.md), [Swift app](06_IOS_SWIFT_APP.md), and [Backend](07_BACKEND_AND_DATABASE.md).

## 1. Why this document exists

A data contract is the agreement between independently written programs. Python, TypeScript, and Swift must agree on names, units, null values, identity, error handling, and acknowledgment. A field called `time` with an unspecified unit is not a sufficient contract.

This document deliberately clarifies earlier conceptual examples: all machine timestamps here use UTC epoch milliseconds and an explicit `Ms` suffix. Do not send an ISO date string under a millisecond field name. Screen times are formatted from these values in the relevant service timezone.

## 2. Shared conventions

| Field/convention | Required meaning |
| --- | --- |
| `schemaVersion` | Numeric protocol version, initially `1`. |
| `runId` | Opaque server-issued run identifier; never a route label or date. |
| `routeVersionId`, `stopId`, `assignmentId` | Opaque server-issued record identifiers. |
| `eventId` | UUID created once for a local observation/action and persisted before sending. |
| `requestId` | UUID reused across retries of one logical command. |
| `bootId` | Fresh UUID for each collector/application start, including a service restart; this is a software boot identifier. |
| `sequence` | Nonnegative safe integer ordered within that boot. |
| `runSequence` | Nonnegative safe integer persisted across restarts for telemetry in one assigned run stream. |
| `capturedAtMs` | Device capture timestamp in UTC epoch milliseconds. |
| `receivedAtMs` | Backend receipt timestamp assigned by the server. |
| `generatedAtMs`, `expiresAtMs` | Generation and expiration times, same units. |
| `latitude`, `longitude` | Decimal degrees in valid geographic ranges. |
| `speedMps` | Meters per second, or `null` when unavailable. |
| `headingDegrees` | Direction of travel in degrees, or `null`; unreliable at low movement. |
| `horizontalAccuracyM` | A defensible reported horizontal uncertainty in meters, or `null`. HDOP is not this field. |
| `fixMode` | `2` or `3` for an accepted coordinate-bearing fix. No-fix state uses health reporting. |

JavaScript numerical fields use `number`. Validate finiteness, range, and safe-integer requirements explicitly. For example, NaN is not a location, a negative sequence is not valid, and an enormous future timestamp must not advance the live-state watermark.

Reset `sequence` only when a new `bootId` is created. Persist `runSequence` across both service and operating-system restarts. Do not combine an unchanged kernel boot identifier with a per-process counter that resets to zero.

The Swift Convex transport DTO uses the documented floating-number wrappers for JavaScript numbers, including counters and timestamps. It can then map into internal `Int`, `Date`, and domain types after validation. JavaScript `number` and `BigInt` are different wire representations; do not silently decode one as the other. See [Swift and Convex type conversion](https://docs.convex.dev/client/swift/data-types).

For the version 1 response objects shown here, transmit listed nullable fields explicitly as `null` when unavailable. Do not inconsistently omit them and assume every Swift property-wrapper decoder treats an absent key the same way. Test future optional-field additions against the selected SDK version.

These examples use fictional opaque IDs and coordinates. Strings such as `demo_run_001` illustrate meaning and are not real Convex IDs to paste into a live request.

## 3. Transport boundaries

There are three distinct interfaces:

| Interface | Caller and location |
| --- | --- |
| Local device API | Kiosk browser to `http://127.0.0.1:8765`; never a public fleet API. |
| Device cloud HTTP API | Pi to configured HTTPS device endpoint; authenticated device credential. |
| Human client functions | Swift/web to authenticated Convex functions; signed-in person identity. |

The device API's default Convex HTTP-action origin is a deployment `.convex.site` URL. The Swift client uses its configured Convex client deployment URL. Obtain both from the actual deployment configuration; do not derive one by blindly replacing substrings in another. [Convex HTTP actions](https://docs.convex.dev/functions/http-actions) documents the routing model.

For device requests use `Content-Type: application/json`, a protected authorization header, and bounded body sizes. Credentials, addresses, and full request bodies must not appear in routine access logs. TLS verification remains enabled.

Proposed initial bounds are at most 50 observations and 128 KiB per telemetry request. These are application design limits to measure and adjust, not quoted platform limits. A large backlog is drained through multiple requests.

## 4. Telemetry upload

**Proposed endpoint:** `POST /device/v1/telemetry`.

The body contains selected observations. Inspecting GPS approximately once per second does not require publishing every raw point. The default proposal selects one cloud observation approximately every five seconds during an active run; route recording may retain a separate, denser local path.

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "eventId": "5fe2a60d-7c11-45b9-995d-f50192adea42",
      "bootId": "3cd44c56-c96b-4b83-a970-5414990bc25a",
      "sequence": 42,
      "runSequence": 918,
      "runId": "demo_run_001",
      "capturedAtMs": 1795609085000,
      "latitude": 34.1,
      "longitude": -83.98,
      "speedMps": 7.2,
      "headingDegrees": 95.0,
      "horizontalAccuracyM": null,
      "fixMode": 3
    }
  ]
}
```

Device identity comes from verified credentials. A `deviceId` supplied by the caller must never override that identity. Sequence ordering belongs to the authenticated device assignment; a replacement device requires an explicit stream handover.

### Per-event response

```json
{
  "schemaVersion": 1,
  "serverNowMs": 1795609085400,
  "results": [
    {
      "eventId": "5fe2a60d-7c11-45b9-995d-f50192adea42",
      "status": "accepted",
      "receivedAtMs": 1795609085400,
      "liveStateApplied": true
    }
  ]
}
```

Each submitted event receives one result, unless a transport failure leaves the outcome unknown. Allowed statuses are:

| Status | Device action |
| --- | --- |
| `accepted` | Mark this exact event acknowledged after a local transaction. |
| `duplicate` | Prior matching event exists; mark this exact event acknowledged. |
| `rejected` | Preserve it in a bounded rejected/dead-letter record with reason; stop automatic retries for that payload. |
| `retryable` | Keep it pending and retry with bounded backoff. |

Accepted historical data can have `liveStateApplied: false`. It is still stored; it simply did not replace the latest live observation. A duplicate returns the original receipt identity/time where available, not a newly fabricated observation.

For rejected/retryable results include a stable `code`, a safe user/support message, and optional `retryAfterMs`. Example codes include `INVALID_COORDINATES`, `CLOCK_OUT_OF_RANGE`, `RUN_NOT_AUTHORIZED`, `EVENT_CONTENT_CONFLICT`, and `TEMPORARILY_UNAVAILABLE`.

An HTTP `200` means the batch was processed; it does not mean every element was accepted. Missing result IDs remain pending. Acknowledging the newest event must not delete older unsent records. If a request times out after the server may have committed it, retry the same event IDs.

## 5. Request-level failures

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "UNSUPPORTED_SCHEMA_VERSION",
    "message": "This device protocol version is not supported.",
    "retryable": false
  }
}
```

| HTTP status | Meaning and response |
| --- | --- |
| `400` | Malformed envelope or unsupported version; do not loop unchanged forever. |
| `401` | Missing/invalid credential; pause protected uploads and enter a provisioning/recovery state. |
| `403` | Valid identity without current permission; retain local records for authorized review. |
| `409` | Conflicting request identity, active-run conflict, or incompatible transition. |
| `413` | Body too large; split bounded batches, preserving event identities. |
| `429` | Rate limit; respect retry guidance and retain pending records. |
| `5xx` / network error | Outcome may be unknown; retry the same identities with backoff. |

Do not expose whether an unrelated school's student or run exists through detailed denial messages. An internal correlation ID can help authorized support without leaking the denied resource.

## 6. Start and end a trip

**Proposed endpoint:** `POST /device/v1/trip-events`.

A start request needs current network access in V1. The Pi persists `requestId` before sending and reuses it after a timeout. The operating grant is a server-issued proof of an authorized driver session; it is not a PIN sent as cloud authority.

```json
{
  "schemaVersion": 1,
  "requestId": "64869872-aaf9-4e4f-99df-621722bbac06",
  "type": "startRun",
  "driverOperatingGrant": "EXAMPLE_ONLY_NOT_A_REAL_GRANT",
  "routeVersionId": "demo_route_version_003",
  "serviceDate": "2026-11-25",
  "serviceTimezone": "America/New_York",
  "capturedAtMs": 1795608000000
}
```

The backend derives and validates the bus/driver context, verifies the service date, and returns the same accepted result on a legitimate retry:

```json
{
  "schemaVersion": 1,
  "requestId": "64869872-aaf9-4e4f-99df-621722bbac06",
  "status": "accepted",
  "runId": "demo_run_001",
  "state": "active",
  "startedAtMs": 1795608000200,
  "endedAtMs": null,
  "serverNowMs": 1795608000200
}
```

For a previously scheduled run, an authorized start can refer to that server-issued run instead of creating a second one. The server enforces the single active-run rule in either case.

An end request carries the existing `runId`, its own persistent `requestId`, `type: "endRun"`, `driverOperatingGrant`, `capturedAtMs`, and `lastRunSequence` (the highest `runSequence` recorded for the run, or `null` if none):

```json
{
  "schemaVersion": 1,
  "requestId": "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f",
  "type": "endRun",
  "driverOperatingGrant": "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000",
  "runId": "demo_run_001",
  "capturedAtMs": 1795611600000,
  "lastRunSequence": 1640
}
```

An accepted end returns the same shape as a start, with `state: "completed"` and `endedAtMs` set. Both responses always carry `endedAtMs`, `null` while the run is active. A retry with the same `requestId` and content returns the stored result unchanged; the same `requestId` with different content is a conflict, never the earlier run. Idempotency is per authenticated device.

Version 1 implementation rules:

- **Grant.** `driverOperatingGrant` is an opaque server-issued secret (32 to 512 URL-safe characters) bound to one device, one driver account, a set of route versions, and an expiry. The server stores only its hash. Until `POST /device/v1/driver-session` exists, staff issue grants in the console (`driverGrants:issueForDriver`, §11) and install them in the Pi's drivers file; the internal `driverGrants:issue` remains for the command line. An exact retry of an already accepted request, presenting the same grant, is honored after that grant expires; any new start or end needs a current grant. A grant authorizes starting and ending, not each position: telemetry for an active run is authorized by the device credential and the run's device, so revoking a grant never hides a moving bus. To stop a device reporting, revoke its credential.
- **Request identity.** One `requestId` names one command per device: reusing it for a different operation, run or content is `REQUEST_ID_CONFLICT`. A retried start answers `active` with `endedAtMs: null` even if the run has ended since. With an invalid grant, an end request gets `GRANT_NOT_AUTHORIZED` before any run lookup.
- **Start.** The route version must be in the grant, `serviceDate` must be today (by server or capture time) in `serviceTimezone`, and `capturedAtMs` must lie within 6 hours before to 2 minutes after the server clock. A device or route version with an active run cannot start another.
- **End.** Only the run's own device, with a current grant covering its route version. `lastRunSequence` may not be below telemetry already accepted for the run.
- **Late telemetry after an end** is accepted as history (`liveStateApplied: false`) only if captured at or before the end's `capturedAtMs`, with `runSequence` at most `lastRunSequence`, and received within 24 hours of the end. Anything else for a completed run is `rejected` with `RUN_NOT_AUTHORIZED`. A completed run's live position never changes.

Trip-event failures use the request-level error body (§5):

| HTTP | `error.code` | Meaning |
| --- | --- | --- |
| `400` | `INVALID_REQUEST`, `MALFORMED_JSON`, `UNSUPPORTED_SCHEMA_VERSION` | Fix the request; do not resend it unchanged. |
| `400` | `CLOCK_OUT_OF_RANGE`, `SERVICE_DATE_OUT_OF_RANGE` | Capture time or service date implausible for the server clock or the run. |
| `401` | `UNAUTHENTICATED` | Device credential missing, unknown, or revoked. |
| `403` | `GRANT_NOT_AUTHORIZED` | Grant unknown, expired, revoked, another device's, or route outside it. |
| `403` | `RUN_NOT_AUTHORIZED` | Unknown run or another device's run (deliberately indistinguishable). |
| `409` | `REQUEST_ID_CONFLICT` | Same `requestId`, different content. |
| `409` | `ACTIVE_RUN_CONFLICT` | The device or route version already has an active run. |
| `409` | `RUN_NOT_ACTIVE` | The run was already ended by a different request. |
| `413` | `BODY_TOO_LARGE` | Body above 8 KiB. |

Canonical fixtures: `packages/contracts/fixtures/tripEvent.*.json`. The iOS app does not call this endpoint. Before upload, atomically mark the local run completed, freeze its final sequence boundary, and persist its end command/outbox record using the serialized database writer. Telemetry insertion re-checks active state inside its own transaction. The backend verifies that the grant belongs to the authenticated device and authorized driver, covers the intended run and operation, and meets the applicable validity/revocation rules. A device credential alone does not authorize ending a run. The sequence boundary helps reconcile earlier captured telemetry that arrives later; it is checked against the authenticated stream and plausible timing.

Other trip-event types can cover driver delay reports, staff check-ins, and corrections. Each requires `driverOperatingGrant` as well as its own validated payload and operation-specific authorization rule. The same bound driver authorization is required for driver-initiated route drafts, QR issuance, roster access, seat notes, and assignment removal; endpoint-specific contracts must define how the grant is supplied. Never accept an arbitrary “patch this database row” event or a caller-provided `driverId` as authority.

During an outage, the Pi saves the action with its original grant reference and capture time. On reconnection the server revalidates the grant's device, driver, run, operation, validity, and revocation history under the adopted offline-reconciliation policy. The local capture time alone cannot establish permission or override a revoked/expired grant. If current or historical authority cannot be established, return an explicit review-required or rejected result and preserve the pending/audit record; do not silently accept the action using only the device credential. Do not silently substitute a newly signed-in driver's grant for the original action's author.

## 7. Device health

**Endpoint:** `POST /device/v1/health`, with the same bearer device credential as telemetry. Types and validation live in `packages/contracts/src/health.ts`; the canonical fixtures are `fixtures/health.report.noFix.json` and `fixtures/health.accepted.json`.

Health tells "online without a GPS fix" apart from "no device contact." The Pi sends one report every 30 seconds (`HEALTH_INTERVAL_MS`), independently of the telemetry outbox. A failed report is not retried or queued, and it never changes outbox rows or the upload pause.

```json
{
  "schemaVersion": 1,
  "bootId": "3cd44c56-c96b-4b83-a970-5414990bc25a",
  "capturedAtMs": 1795609085000,
  "appVersion": "0.1.0",
  "runId": "demo_run_001",
  "gpsStatus": "no_fix",
  "lastValidFixAtMs": 1795609025000,
  "pendingCount": 3,
  "oldestPendingCapturedAtMs": 1795609020000
}
```

| Field | Rule |
| --- | --- |
| `bootId` | UUID of the current collector process. |
| `capturedAtMs` | Device time of the report. More than 2 minutes in the future is refused. |
| `appVersion` | 1–32 characters. |
| `runId` | The run the Pi is recording, or `null`. Kept for diagnostics only. It never grants scope: the backend links health to runs through the credential's device. |
| `gpsStatus` | `valid`, `no_fix`, `receiver_missing`, or `unknown` (GPSD unreachable on the Pi). Never send fake coordinates to signal no fix. |
| `lastValidFixAtMs` | Capture time of the last valid fix this process saw, or `null`. |
| `pendingCount`, `oldestPendingCapturedAtMs` | Outbox rows not yet acknowledged, and the oldest one's capture time (or `null`). |

Unknown fields are refused. A health report never carries coordinates, secrets, student names or addresses. Bodies are at most 2 KB (`MAX_HEALTH_BODY_BYTES`).

The answer is `200 { "schemaVersion": 1, "status": "accepted", "receivedAtMs", "serverNowMs" }`. Request errors use the §5 body: 400 `INVALID_REQUEST`, `MALFORMED_JSON` or `UNSUPPORTED_SCHEMA_VERSION`; 401 `UNAUTHENTICATED`, including a device revoked before the commit; 413 `BODY_TOO_LARGE`.

The backend keeps the latest report per device and assigns `receivedAtMs`. A report older than the stored one from the same `bootId` (a delayed report, or the Pi clock stepping back) still counts as contact but does not replace the stored status. If no later report arrives within `POSITION_STALE_AFTER_MS`, the stored status becomes `unknown`. A missed heartbeat does not prove whether the cause is cellular service, device power, or software failure.

### Configuration and driver sign-in

The full driver workflow also needs the following proposed device operations. They use the same device authentication, request identity, and explicit result rules. Route drafts (§7.1) and displayed QR codes (§9.2) are implemented.

| Proposed operation | Required behavior |
| --- | --- |
| `GET /device/v1/config` | Return the current permitted bus/device settings, approved route versions, cache revisions, and expiry metadata. Roster fields require the applicable authorized driver context. |
| `POST /device/v1/driver-session` | Exchange independently verified driver authentication for a limited operating grant tied to device/scope. A local PIN alone is not a cloud identity proof. |

Keep credentials and driver grants in protected headers or bodies, never query strings. Initial driver-session establishment depends on the selected authentication/provisioning workflow; do not ship an endpoint that trusts an arbitrary `driverId` or a common PIN.

Approved publication creates a route version; it does not overwrite the version of an active run. Config refreshes identify revisions so the Pi can avoid downloading unchanged route geometry.

Both QR purposes require current authorization and expiration checks. A backend outage does not authorize the Pi to invent unlimited replacement tokens. Cached information must retain its original expiry and scope.

### 7.1 Route-draft submission (implemented)

Types, limits and the shared validator: `packages/contracts/src/routeDrafts.ts`; fixtures `routeDraft.*.json`; device models `apps/device/src/itssb_device/route_draft_contracts.py`. Only the Pi and the backend use these. No iOS client decodes them, so there is no Swift DTO.

**One bounded upload.** A draft holds at most 2,000 points (`MAX_ROUTE_PATH_POINTS`) and 100 stops (`MAX_ROUTE_DRAFT_STOPS`). The largest one is about 280 KB, within `MAX_ROUTE_DRAFT_BODY_BYTES` (384 KiB). So one request carries a whole recording, with no chunks and no upload object (docs/17). Submitting creates a draft; it never updates one. To change a submitted route, the driver records it again.

| Endpoint | Who | Body | Result |
| --- | --- | --- | --- |
| `POST /device/v1/route-drafts` | device + grant current on arrival | `{ schemaVersion, requestId, driverOperatingGrant, deviceDraftId, capturedAtMs, label, direction, startedAtMs, finishedAtMs, path, stops }`. `path` holds 2–2,000 `{ latitude, longitude, capturedAtMs, gapBefore }` in travel order, with capture times strictly increasing. `stops` holds 1–100 `{ label, latitude, longitude, capturedAtMs }` in travel order. | `200` `{ requestId, status, draft, serverNowMs }` with `status` `accepted` (stored now) or `already_submitted` (stored before), and `draft` (`draftId`, `deviceDraftId`, `status`, `submittedAtMs`, `reviewedAtMs`, `decisionReason`, `routeVersionId`). Or `{ status: "rejected", code, message }` with `code` `grant_not_authorized`, `request_id_conflict` or `draft_conflict`. |
| `POST /device/v1/route-drafts/status` | device + current grant | `{ schemaVersion, driverOperatingGrant, draftIds }` (1–20 server draft ids) | `200` `{ drafts, serverNowMs }`: one review per distinct id, or `{ draftId, status: "not_found" }`. Another device's draft reads as `not_found`. |

**Rules.**
- **Never approved here.** A stored draft is always `submitted` with no route version. Only staff approval (`routes:approveDraft`, §11) creates a route version, and new runs pin it.
- **Credential rechecked at commit.** The submit and status functions recheck, in their own transaction, that the device is not revoked and its credential is still the one presented. A rotation or revocation landing mid-request refuses it with `401`.
- **GPS gaps kept.** The indexes of points with `gapBefore: true` are stored with the draft. Staff review shows them as the `gap_in_recording` warning and a dashed, labelled segment (§11), whatever the distance.
- **Idempotent.** The content is the recording itself, without the grant, `requestId` or `capturedAtMs`, compared by its SHA-256. The same `requestId`, or the same `deviceDraftId` with the same content, returns the stored draft (`already_submitted`). Different content under either one is rejected and never merged. Each device has its own drafts.
- **Validated.** Coordinates must be on the globe. Point and stop times must fall within the recording (start and finish allow `MAX_FUTURE_SKEW_MS` for GPS-versus-wall-clock difference), the finish may not be in the future, and labels are 1–60 characters. Stops are not time-ordered: the driver may reorder them.
- **Audited.** An accepted draft records the driver (from the grant), the carrying device and the capture time. A grant refusal is audited as denied.
- **Errors (§5).**
  - `400` `INVALID_REQUEST`, `MALFORMED_JSON` or `UNSUPPORTED_SCHEMA_VERSION`.
  - `401` `UNAUTHENTICATED`, including a revoked device.
  - `403` `GRANT_NOT_AUTHORIZED` (status read only).
  - `413` `BODY_TOO_LARGE`, `TOO_MANY_POINTS` or `TOO_MANY_STOPS`. The limits are explicit refusals, never truncation.

**On the Pi.** Submit saves the exact body in SQLite with its `requestId` before sending. Retries resend the same bytes until the server answers. The draft shows "pending" until the server accepts it, and its stops are frozen once Submit is pressed. Review status is read with the unlocked driver's grant and shown with the time it was read (docs/05 D10–D11). Each read asks about at most 20 awaiting drafts, least recently checked first, so successive reads reach every draft.

## 8. Authorized live snapshot

**Proposed Convex query:** `tracking:myRun` with `{ "assignmentId": "..." }`.

The signed-in identity is supplied through the authenticated client. The query verifies that this is the student's assignment or a permitted guardian relationship. It does not trust a caller-supplied role.

Three queries make up the family tracking contract. TypeScript types live in `packages/contracts/src/tracking.ts`; canonical fixtures are generated to `packages/contracts/fixtures/*.json` and decoded by the backend and Swift tests. The fixture route and the dev seed share one fictional demo path (`packages/contracts/src/demoRoute.ts`). Clients draw straight segments between path points and never snap them to roads, so the path is dense: 373 points at most 20 m apart along public roads. It was generated once from the public OSRM demo server; road data © OpenStreetMap contributors, Open Database License (ODbL 1.0).

| Query | Args | Returns |
| --- | --- | --- |
| `tracking:myAssignments` | `{}` | `ready` with the caller's own and approved-guardian-linked `assignments` (`assignmentId`, `relationship: "self" \| "guardian"`, `studentDisplayName`, `routeLabel`, `stopLabel`), or `access_unavailable`. |
| `tracking:myRun` | `{ assignmentId }` | The compact live envelope below. |
| `tracking:myRoute` | `{ assignmentId }` | `ready` with `routeVersionId`, `routeLabel`, the approved `path` (ordered `{ latitude, longitude }`, at most 2000 points), and `assignedStop` (`stopId`, `label`, `latitude`, `longitude`), or `access_unavailable`. Geometry for a `routeVersionId` never changes, so clients cache it by that ID. |

Every envelope carries `schemaVersion` and `serverNowMs`.

```json
{
  "schemaVersion": 1,
  "status": "ready",
  "serverNowMs": 1795609085500,
  "assignmentId": "demo_assignment_001",
  "routeVersionId": "demo_route_version_003",
  "run": {
    "runId": "demo_run_001",
    "state": "active",
    "liveRevision": 27,
    "busLabel": "Bus 12",
    "lastDeviceContactAtMs": 1795609085400,
    "gpsStatus": "valid",
    "lastPosition": {
      "eventId": "5fe2a60d-7c11-45b9-995d-f50192adea42",
      "capturedAtMs": 1795609085000,
      "receivedAtMs": 1795609085400,
      "latitude": 34.1,
      "longitude": -83.98,
      "speedMps": 7.2,
      "headingDegrees": 95.0,
      "horizontalAccuracyM": null
    },
    "nextStopId": "demo_stop_003",
    "assignedStop": {
      "stopId": "demo_stop_003",
      "label": "Oak & Pine",
      "latitude": 34.105,
      "longitude": -83.975,
      "status": "upcoming"
    },
    "eta": {
      "arrivalAtMs": 1795609445000,
      "generatedAtMs": 1795609085450,
      "validUntilMs": 1795609145000,
      "lowerArrivalAtMs": null,
      "upperArrivalAtMs": null,
      "algorithmVersion": "baseline-v1",
      "sourceEventId": "5fe2a60d-7c11-45b9-995d-f50192adea42"
    }
  }
}
```

Field rules for `run`:

| Field | Rule |
| --- | --- |
| `liveRevision` | Nonnegative safe integer. `0` before any position; increases each time the live position is replaced. |
| `lastDeviceContactAtMs` | Last time the backend heard from the bus device during this run: the later of the last accepted telemetry receipt and the last health receipt (§7). `null` if neither has arrived since the run started. |
| `gpsStatus` | From the device's latest health report received since the run started: `valid`, `no_fix`, or `receiver_missing`. `null` when no report has supplied one, or when the Pi reported `unknown` (GPSD down). It is also `null` when a position captured after that report exists, because the fix is back. Never inferred from a missing position. The backend marks a status `unknown` once `POSITION_STALE_AFTER_MS` passes with no newer report. Between those writes a query result is not re-run as time passes, so clients also trust a non-`valid` status only while `lastDeviceContactAtMs` is younger than `POSITION_STALE_AFTER_MS` (§8.1). |
| `nextStopId` | First stop in travel order the bus has not departed, from route progress along the approved path (docs/10 §2). `null` before any matched position, when the route's stops have no travel order, or after the last stop. |
| `assignedStop.status` | `upcoming`, `at_stop`, `passed`, or `unknown` (no matched position yet, or the route's stops have no travel order). Arrival and departure are inferred from GPS progress, never a staff-confirmed action. |
| `eta` | The baseline estimate for the assigned stop (docs/10 §3), or `null`. Non-null only when the run is active, the stop is `upcoming`, the newest live position matched the route (not off route or ambiguous), the estimate was made from that position (`sourceEventId` equals `lastPosition.eventId`), the position is not stale, and the server's time is before `validUntilMs`. `arrivalAtMs` is anchored to the position's `capturedAtMs`; `generatedAtMs` is when the server computed it; `validUntilMs = capturedAtMs + ETA_VALID_FOR_MS`. Clients hide it once their verified server clock reaches `validUntilMs`, without waiting for an update, and never show it before verified time exists. |
| `busLabel` | Family-facing bus name; a generic label when the device has none. |

The 60-second prediction validity is provisional configuration, not a measured accuracy guarantee. The current schema permits `lastPosition: null` and `eta: null`. Optional calibrated bounds stay null until evaluation supports them. Completed/cancelled runs cannot retain an actionable approaching countdown.

`status: "no_active_run"` returns `assignmentId`, `routeVersionId`, `run: null`, `endedRun`, and `serviceNotice`. Both `ready` and `no_active_run` carry `serviceNotice`.

- `endedRun` is today's most recent completed or cancelled run on the assignment's route version, or `null`. Its fields are `runId`, `state: "completed" | "cancelled"`, `serviceDate`, `endedAtMs` (when it finished or staff cancelled it, or `null`), `replacement`, and `validUntilMs`. "Today" is the run's own `serviceDate` in its own `serviceTimezone`; a run without one is never reported. `replacement` is `"pending"` when staff sent a replacement bus that has not started yet, otherwise `null`. Once the replacement starts, `myRun` returns it as the `ready` run. A replacement that is running is never reported here.
- An ended run has no position, GPS status, or estimate: its last point is never shown as current.
- Staff's free-text cancellation reason (docs/12 §7) is for staff and drivers and is never sent. Clients use fixed wording ("The school cancelled today's trip").
- `serviceNotice` is today's service-calendar entry (docs/12 §3), or `null`. Its fields are `serviceDate`, `status: "no_service" | "late_start"`, `lateStartMinutes` (whole minutes for a late start, `null` otherwise), `notice` (the family-facing text staff wrote), and `validUntilMs`. The calendar is district-wide, so every route gets the same entry. An entry is today's when its `serviceDate` is the current local date in its own `timezone`.
- `validUntilMs` is the end of that service day in its time zone, from `endOfLocalDayMs`. That is the first instant whose local date is later, so it is right where local midnight is skipped or repeated. Any zone `isValidTimeZone` accepts works: IANA names and numeric offsets up to ±23:59. A stored calendar entry or run whose time zone can't be computed is dropped from `myRun` and logged; it never fails the query, so the live trip and the other field still render. A query is not re-run as time passes, so clients hide `endedRun` and `serviceNotice` once their server-aligned clock reaches `validUntilMs`. The opposite gap remains: a notice for a new day appears only when the query next re-runs, for example after reconnecting or on the next write the query reads.
- These fields were added after the first iOS release. The server always sends them, as explicit `null` when empty. Clients treat a missing key as `null`, and a present but malformed entry as a mapping error, never as "no trip". Fixtures: `myRun.cancelled`, `myRun.cancelledReplacementPending`, `myRun.completed`, `myRun.noService`, `myRun.lateStart`.
- The Pi never calls or decodes `tracking:myRun`.

`status: "access_unavailable"` contains only `schemaVersion`, `serverNowMs`, and a safe `reason`: `unauthenticated` (no verified identity at all: sign in) or `not_permitted` (a verified identity that is not linked to an approved person yet, and unknown, malformed, revoked, and forbidden assignments, all deliberately indistinguishable). A signed-in person is never told to sign in again. It has no protected route fields. Authentication/session failures can also surface as the SDK's typed error; the repository maps that error to the appropriate UI state. Distinguish an empty schedule from a failed query.

The app ages its freshness label locally between updates. It may estimate server clock offset from `serverNowMs`, but a server time field does not turn a reactive query into a clock. When no data changes, a subscription need not emit a fresh snapshot every second.

### 8.1 Freshness policy (provisional)

| Constant | Value | Meaning |
| --- | --- | --- |
| `POSITION_AGING_AFTER_MS` | `30000` | From this age the app says it is waiting for an update. |
| `POSITION_STALE_AFTER_MS` | `120000` | From this age the position is shown as a last-known location with its capture time; movement animation and any estimate stop. |
| `ETA_VALID_FOR_MS` | `60000` | An estimate is valid until its source position's `capturedAtMs` plus this. Shorter than the stale cutoff, so an estimate always disappears before its position is called stale. |

These are proposed values, owned by the open "Freshness and alert thresholds" decision in [17](17_DECISIONS_AND_SOURCES.md) and to be tuned from measured runs. They are exported from `packages/contracts` and mirrored in the Swift app; change both together.

Age is `now - capturedAtMs`, measured on a server-aligned clock. A query result can be served from cache, so its `serverNowMs` may be much older than the moment it arrives, and a phone clock can be wrong too; together they can make an old position look current. So:

- **Verified time.** The client calls the mutation `tracking:serverTime` (`{}` → `{ schemaVersion: 1, serverNowMs }`) when tracking starts. Mutations are never served from cache.
  - It pins the server's reading to the round trip's monotonic midpoint and adds half the round trip as uncertainty, so any error makes a position look older.
  - From then on it advances that reading by monotonic elapsed time, which counts through sleep and ignores changes to the phone's clock.
  - A sample whose round trip took longer than 5 seconds is rejected.
  - One request is shared by every subscription and retried while any is still waiting.
- **Until verified time exists** (or if it never arrives), the client uses the larger of the phone-clock age and the query-aligned age. It never classifies a position as fresh: at best it shows "waiting for an update".
- **Never negative.** The age shown is never negative.

`tracking:serverTime` needs no sign-in and reads no data; time is not protected.

## 9. Enrollment, QR, and app commands

| Proposed function | Important inputs | Result/rule |
| --- | --- | --- |
| `enrollment:request` | `requestId`, invitation token, private profile/address, selected eligible `stopId` | Pending/approved request; server verifies stop eligibility and invitation scope. |
| `checkIns:record` | `requestId`, challenge token, `runId` | Accepted/already-recorded/rejected; student identity derived from session. |
| `routes:removeAssignment` | `requestId`, assignment, reason, authorized driver/admin context | Scoped revocation and audit record; not global account deletion. |

### 9.1 Enrollment and guardian linking (implemented)

Types: `packages/contracts/src/enrollment.ts`; fixtures `enrollment.*.json`, `guardianLinks.*.json`. Family functions resolve the caller from the verified sign-in identity, which need not have an approved account yet; they answer `access_unavailable` (`unauthenticated`) when signed out. A pending request grants no tracking. Staff functions follow §11 (staff role, `access_unavailable` before any read, audited denials).

**Tokens.** 20 Crockford base32 characters, shown as `ABCD-EFGH-JKMN-PQRS-TVWX`, accepted in any case with or without dashes (`normalizeToken`). A scanned link must be `https://<allowed host>/join?token=…` (enrollment), `/link` (guardian) or `/checkin` (trip), with no other parameters (`parseScannedToken`). A token that is not accepted answers `status: "token_problem"` with `problem`: `invalid` (unknown, malformed or revoked, deliberately alike), `expired`, `wrong_purpose`, `already_used` (a single-use guardian invitation redeemed by another account) or `unavailable` (its route has no approved version).

| Function | Who | Args | Returns |
| --- | --- | --- | --- |
| `enrollment:previewInvitation` (query) | family | `{ token }` | `ready` with `routeLabel`, `direction`, `expiresAtMs`, `stops` (`stopId`, `label`, `sequence`, `instructions`); or `token_problem`. No position, roster or other family's data. |
| `enrollment:request` (mutation) | family | `{ requestId, token, studentName, address, stopId \| null, note \| null }` | `submitted` with `enrollmentRequestId`, `requestStatus`; `token_problem`; or `refused` (`invalid_details`, `stop_not_eligible`, `request_id_conflict`, `already_requested`, `already_enrolled`). `requestId` is per applicant; a retry with the same content returns the stored result even after the invitation expires. `stopId: null` asks for manual review. |
| `enrollment:myRequests` (query) | family | `{}` | `ready` with `requests` (`enrollmentRequestId`, `routeLabel`, `direction`, `studentName`, `requestedStopLabel`, `status: pending \| approved \| rejected`, `submittedAtMs`, `decidedAtMs`, `decisionReason` for a rejection). Never the address. |
| `guardianLinks:request` (mutation) | family | `{ requestId, token, guardianName }` | `submitted` with `linkRequestId`, `requestStatus`; `token_problem`; or `refused` (`invalid_details`, `request_id_conflict`, `already_linked`). |
| `guardianLinks:myRequests` (query) | family | `{}` | `ready` with `requests` (`linkRequestId`, `status`, `submittedAtMs`, `decidedAtMs`, `decisionReason`, `studentDisplayName` only while approved). |
| `enrollment:createRouteInvitation` (action) | staff | `{ routeId, ttlMs }` | `created` with `invitationId`, `token` (shown once), `expiresAtMs`; or `refused` (`not_found`, `invalid_ttl`, `route_unavailable`). |
| `guardianLinks:createInvitation` (action) | staff | `{ studentId, ttlMs }` | Same shape; single use. |
| `enrollment:listInvitations` (query) | staff | `{}` | `ready` with `invitations` (never the token or its hash). |
| `enrollment:revokeInvitation` (mutation) | staff | `{ invitationId }` | `revoked` (idempotent) or `refused` `not_found`. |
| `enrollment:listRequests` (query) | staff | `{}` | `ready` with pending requests first, including the private `address` and the route's current `eligibleStops`. |
| `enrollment:approve` (mutation) | staff | `{ enrollmentRequestId, stopId }` | `approved` with `assignmentId`; or `refused` (`not_found`, `already_decided`, `stop_not_eligible`, `route_unavailable`, `account_conflict`: the sign-in is a staff or driver account, or already belongs to a differently named student). The stop must be in the route's current version. |
| `enrollment:reject` (mutation) | staff | `{ enrollmentRequestId, reason }` | `rejected`; or `refused` (`reason_required`, …). The reason is kept on the request and shown to the family, never copied into the audit log. |
| `guardianLinks:listRequests` / `approve` / `reject` | staff | `{}` / `{ linkRequestId }` / `{ linkRequestId, reason }` | As enrollment; `approve` returns `guardianLinkId`. |
| `guardianLinks:revoke` (mutation) | staff | `{ guardianLinkId, reason }` | `revoked`; future tracking reads stop at once. |
| `students:list` (query) | staff | `{}` | `ready` with `students` (assignments and guardian links; no addresses). |
| `audit:list` (query) | staff | `{ limit? }` | `ready` with the newest `entries` (`actorName`, `action`, `resourceType`, `resourceId`, `result`, `reason`, `source`, `capturedAtMs`). Audit rows never hold tokens or addresses. |

The Pi does not call these functions, so the device models are unaffected; the iOS app decodes the family results with the fixtures above.

### 9.2 Trip check-in, roster and driver actions (implemented)

Types: `packages/contracts/src/checkIns.ts`; fixtures `checkIns.*.json`, `qrCode.*.json`, `roster.*.json`, `rosterAction.*.json`; device models `apps/device/src/itssb_device/roster_contracts.py`.

**Records.** A check-in has `status: "boarded" | "not_boarded"`, which is what was claimed or recorded, not a sensor reading. Its `source` is one of:
- `student_qr_claim`
- `staff_recorded` (a driver or staff member)
- `staff_correction`

The first record for a student, run and `boarding` phase is the logical record; a repeat returns it. Only a correction adds a newer row, which names the row it corrects and becomes current. Rows are never edited or deleted.

| Function / endpoint | Who | Body or args | Result |
| --- | --- | --- | --- |
| `checkIns:record` (mutation) | approved student | `{ requestId, token, runId }` | `accepted` or `already_recorded` with `checkIn`; `token_problem`; or `rejected` (`wrong_run`, `run_not_active`, `not_assigned`, `request_id_conflict`, `invalid_request`). Identity comes from the session; a guardian gets `not_assigned`. The same `requestId` returns the stored outcome, even after the challenge expires. |
| `checkIns:forAssignment` (query) | student or linked guardian | `{ assignmentId }` | `ready` with the active `runId` (or `null`) and the current `checkIn` (or `null`). |
| `POST /device/v1/qr-codes` | device + current grant | `{ schemaVersion, driverOperatingGrant, purpose, runId \| routeVersionId }` | `200` `{ purpose, token, linkPath, expiresAtMs, serverNowMs }`. A check-in challenge lasts 10 minutes (`CHECK_IN_CHALLENGE_TTL_MS`), belongs to the device's active run on a route in the grant, and replaces that run's previous challenge. An enrollment invitation lasts one day and needs the route's current version in the grant. |
| `POST /device/v1/roster` | device + current grant | `{ schemaVersion, driverOperatingGrant, runId }` | `200` with `students` in stop order (`assignmentId`, `studentDisplayName`, `stopId`, `stopLabel`, `stopSequence`, `seatLabel`, `driverNote`, `checkIn`). No addresses, accounts or guardians. |
| `POST /device/v1/roster-actions` | device + grant valid when captured | `{ schemaVersion, requestId, driverOperatingGrant, capturedAtMs, type, assignmentId, … }` with `type` `recordAttendance` (`runId`, `status`), `correctAttendance` (`runId`, `status`, `correctsCheckInId`, `reason`), `setSeatNote` (`seatLabel`, `driverNote`, nullable) or `removeAssignment` (`reason`) | `200` `{ requestId, status, checkIn, serverNowMs }` with `status` `accepted`, `already_recorded` or `superseded` (an older seat note); or `{ status: "rejected", code, message }` with `code` `grant_not_authorized`, `assignment_not_authorized`, `run_not_authorized`, `already_removed`, `correction_target_invalid`, `capture_time_out_of_range` or `request_id_conflict`. |
| `checkIns:staffRecord` (mutation) | staff | `{ runId, assignmentId, status }` | Staff fallback for an active run: `accepted` or `already_recorded` with `checkIn`, or `refused`. |
| `checkIns:runAttendance`, `checkIns:recentRuns` (queries) | staff | `{ runId }`, `{}` | Each student's current record and full history (with who recorded it and why), and recent runs with assigned and boarded counts. |
| `routes:removeAssignment` (mutation) | staff | `{ requestId, assignmentId, reason }` | `accepted`, or `refused` (`reason_required`, `not_found`, `already_removed`). |

**Offline driver actions.** The Pi persists each action with its `requestId` and `capturedAtMs` before sending, shows it as pending sync, and retries with the same identity until it receives a result. The backend rechecks authority when it accepts the action:
- **The grant:** it must belong to this device, must not be revoked, and must still be current when the action arrives: a capture time never overrides an expired or revoked grant (§6). Revocation time is not recorded, so a revoked grant can't prove it was valid at capture. `capturedAtMs` must also fall within the grant's validity (allowing 2 minutes of clock skew before its issue time), no more than 2 minutes in the future and no more than 24 hours old. An action that can't sync before its grant expires is `rejected`; staff record it instead.
- **The assignment:** it must be on a route the grant covers.
- **Attendance:** the action must have been captured on that device's run while it was going, between its start and end as captured on the bus (`startCapturedAtMs`, `endCapturedAtMs`; the same device clock), even if the end reached the server later.
- **Corrections:** ordered by capture time. A queued correction captured before the correction that is current now is `superseded`; a newer one becomes current. Rows are never edited or deleted.

A rejected action is final, and the Pi shows it; a removal is not in effect until it is `accepted`. Request-level failures use §5: `400` (`INVALID_REQUEST`, `MALFORMED_JSON`, `UNSUPPORTED_SCHEMA_VERSION`), `401` `UNAUTHENTICATED`, `403` (`GRANT_NOT_AUTHORIZED`, `RUN_NOT_AUTHORIZED`), and `413` above 8 KiB.

**Not proved.** A check-in records that an account presented a valid challenge, or that staff recorded an action. It does not prove that a particular child boarded (docs/09 §7).

### 9.3 Notifications (implemented)

Types live in `packages/contracts/src/notifications.ts`; fixtures are `myPreference.*`, `setPreferences.saved`, `registerDevice.registered`, and `myAlerts.*`. The account is always the signed-in caller, and an assignment is usable only through the same relationship check as `tracking:myRun`. The Pi never sends or reads any of these.

| Function | Args | Returns |
| --- | --- | --- |
| `notifications:myPreference` (query) | `{ assignmentId }` | `ready` with `preference` (`assignmentId`, `approachingEnabled`, `approachingMinutes`, `updatedAtMs` or `null` for defaults), or `access_unavailable`. Defaults: off, 5 minutes. |
| `notifications:setPreferences` (mutation) | `{ requestId, assignmentId, approachingEnabled, approachingMinutes }` | `saved` with the stored `preference`; `invalid` (non-UUID `requestId`, minutes not a whole number in `APPROACHING_MINUTES_MIN`–`MAX`, 1–30); or `access_unavailable`. A retry of any of the last 20 `requestId`s returns the stored row unchanged, so a delayed retry never reverses a newer choice. Per person and assignment: a guardian's choice never changes the student's. |
| `notifications:registerDevice` (mutation) | `{ installationId, apnsToken, environment: "sandbox" \| "production", permission: "authorized" \| "provisional" \| "denied" \| "not_determined" }` | `registered` with `pushEnabled` (a token and an allowing permission), `invalid` (non-UUID installation, non-hex token), or `access_unavailable`. `apnsToken` is `null` when the app has none. One installation has one current row; signing in as another account on the same installation stops the previous account's pushes. A token already active for another account's installation is refused (`invalid`), never taken over; the same account may move it to a new installation (a reinstall). Permission is recorded separately from preferences. |
| `notifications:myAlerts` (query) | `{}` | `ready` with up to 50 `alerts`, newest first, each `alertId`, `type: "approaching"`, `assignmentId`, `runId`, `stopLabel`, `createdAtMs`, `predictedArrivalAtMs`, `predictionGeneratedAtMs`; or `access_unavailable`. Alerts for assignments the caller can no longer track are omitted. |

Push payloads carry no student, stop, or route details: the Lock Screen text is generic and the payload holds only `itssb.type` and the opaque `itssb.assignmentId`. A tapped notification opens that assignment and fetches current state; it never shows the payload as current.

Provisional constants (docs/17 "Freshness and alert thresholds"): `ALERT_MAX_INPUT_AGE_MS = 30000` (an alert is created only from a position younger than this), `MAX_DELIVERY_ATTEMPTS = 5`.

Private enrollment fields belong only in authenticated submissions and appropriately restricted storage. Treat a scanned link as untrusted input: allow expected scheme/host/path and a bounded token, then ask the backend to validate purpose, expiration, revocation, route, and account eligibility.

The shared trip challenge supports multiple legitimate students. Do not invalidate it globally after the first student scans it. Deduplicate the resulting check-in by student/run/phase. A scan result must identify its source as a student claim; staff-confirmed corrections remain distinguishable.

The final invitation domain and universal-link association are deployment decisions. `https://example.invalid/...` can be used in documentation and fixtures; it is not an operational enrollment service.

## 10. Compatibility and contract verification

Maintain saved fixtures for every major result and error. Python serialization, backend validators, and Swift decoding should consume the same fixtures. Include null GPS, stale timestamps, duplicate events, partial batch failures, no active run, revoked access, and completed-trip notification taps.

Add optional fields compatibly where possible. Do not silently rename a field, change milliseconds to seconds, or change an existing enum's meaning. Use a new version and explicit rollout when a breaking change is required. A server receiving an unsupported version must return a useful error rather than guessing.

Pin the contract revision in each release. All state-changing commands carry stable request identities, and every operation documents whether it is accepted, queued, or still uncertain. That is the basis of reliable recovery across the Pi, backend, and Swift app.

## 11. Staff console

The staff web calls these Convex functions. The Pi and the iOS app never do, so the device models and Swift DTOs are not affected. TypeScript types live in `packages/contracts/src/staff.ts`. Every function resolves the caller from the authenticated identity and requires the `staff` role on the server. A non-staff caller gets `access_unavailable` (`unauthenticated` or `not_permitted`, the same envelope as §8) before anything is read. Every envelope carries `schemaVersion` and `serverNowMs`.

| Function | Args | Returns |
| --- | --- | --- |
| `routes:list` (query) | `{}` | `ready` with `routes` (`routeId`, `label`, `direction: "to_school" \| "from_school"`, `currentVersion` or `null`: `routeVersionId`, `versionNumber`, `approvedAtMs`, `approvedByName`, `effectiveFromMs`, `stopCount`). |
| `routes:listDrafts` (query) | `{}` | `ready` with `drafts`: waiting drafts first, then recent decisions. Each has `draftId`, `routeId` (null for a new route), `label`, `direction`, `status: "submitted" \| "approved" \| "rejected"`, `submittedAtMs`, `pointCount`, `stopCount`, `reviewedAtMs`, `reviewerName`, `decisionReason`, `approvedVersionId`. |
| `routes:getDraft` (query) | `{ draftId }` | `ready` with the draft summary plus `path`, ordered `stops` (`sequence`, `label`, `latitude`, `longitude`, `instructions`), `gapBeforeIndexes` (indexes into `path` of points recorded after a GPS loss; the segment ending at each is not measured travel; empty when none or unknown) and `checks`; or `not_found`. |
| `routes:approveDraft` (mutation) | `{ draftId }` | `approved` with `routeId`, `routeVersionId`, `versionNumber`; or `refused` with a `code` and `message`. |
| `routes:rejectDraft` (mutation) | `{ draftId, reason }` | `rejected`, or `refused`. |
| `fleet:listDevices` (query) | `{}` | `ready` with `devices` (`deviceId`, `label`, `busLabel`, `revoked`, `activeRun` or `null`: `runId`, `routeLabel`, `startedAtMs`; and `lastContactAtMs`). No credential or hash is ever returned. |
| `fleet:setBusLabel` (mutation) | `{ deviceId, busLabel }` | `ok`, or `refused` (`not_found`, or `invalid_label` for 0 or over 40 characters after trimming). |
| `fleet:revokeDevice` (mutation) | `{ deviceId }` | `ok` (idempotent), or `refused` (`not_found`). |
| `fleet:listDrivers` (query) | `{}` | `ready` with `drivers` (`userId`, `displayName`). |
| `fleet:provisionDevice` (action) | `{ label, busLabel? }` | `issued` with `deviceId` and `deviceSecret` (shown once; only its SHA-256 is stored), or `refused` (`invalid_label`: device name 1 to 80 characters, bus name at most 40). |
| `fleet:rotateDeviceCredential` (action) | `{ deviceId }` | `issued` with `deviceId` and a new `deviceSecret`; the old secret stops working at once and the device keeps its identity and runs. Or `refused` (`not_found`, `revoked`: a revoked device is never revived). |
| `fleet:diagnostics` (query) | `{}` | `ready` with `deployment` (`release`, `environment` from the `ITSSB_RELEASE`/`ITSSB_ENVIRONMENT` deployment variables or `null`, `contractSchemaVersion`), `retention` (`rawGpsDays`, `lastSweepAtMs`, `lastSweepDeleted`), and `devices` (`deviceId`, `label`, `busLabel`, `revoked`, `activeRunId`, `lastContactAtMs` from the latest heartbeat or position receipt, `softwareVersion`, `pendingCount`, `oldestPendingCapturedAtMs` from the heartbeat, `lastRun`). No positions, addresses or credentials. |
| `fleet:listMaintenance` (query) | `{}` | `ready` with upcoming, uncancelled `windows` (`windowId`, `deviceId`, `deviceLabel`, `startsAtMs`, `endsAtMs`, `reason`, `scheduledByName`). |
| `fleet:scheduleMaintenance` (mutation) | `{ deviceId, startsAtMs, endsAtMs, reason }` | `ok`, or `refused` (`device_unavailable`, `reason_required`, `invalid_window`: not in the past, ends after it starts, at most 12 h; `overlaps`; `device_busy`: starts now on a bus with an active run). |
| `fleet:cancelMaintenance` (mutation) | `{ windowId }` | `ok`, or `refused` (`not_found`). |
| `runOps:cancelRun` (mutation) | `{ runId, reason }` | `ok`: the run becomes `cancelled` with `endedAtMs`, `cancelledAtMs`, who, and the reason (1 to 200 characters); its positions are no longer accepted. Or `refused` (`reason_required`, `not_found`, `not_active`). |
| `runOps:replaceDevice` (mutation) | `{ runId, replacementDeviceId, reason }` | `ok`: cancels the run and names the replacement bus; that bus's next normal start of the same route version on the same service date is linked (`replacesRunId` on it, `replacedByRunId` on the cancelled run). Or `refused` (`reason_required`, `not_found`, `not_active`, `device_unavailable`, `same_device`, `device_busy`). |
| `calendar:listDays` (query) | `{}` | `ready` with `days` (`serviceDate`, `timezone`, `status: "no_service" \| "late_start"`, `lateStartMinutes`, `notice`, `setByName`, `setAtMs`), from 30 days ago on. |
| `calendar:setDay` (mutation) | `{ serviceDate, timezone, status, lateStartMinutes?, notice }` | `ok` (one entry per date, replacing any earlier one), or `refused` (`invalid_date`, `invalid_timezone`, `past_date`, `notice_required`, `invalid_delay`: late start 1 to 240 whole minutes). |
| `calendar:removeDay` (mutation) | `{ serviceDate }` | `ok`, or `refused` (`not_found`, `past_date`). |
| `fleet:addDriver` (mutation) | `{ displayName }` | `created` with `userId`: a driver person with no app sign-in (an unlinked placeholder identity, `unlinked:<userId>`). Or `refused` (`invalid_name`: 1 to 80 characters after trimming). |
| `driverGrants:issueForDriver` (action) | `{ driverUserId, deviceId, routeVersionIds, ttlMs }` | `issued` with `grantId`, `grant` (shown once; only its SHA-256 is stored), `expiresAtMs`, `driverUserId`, `driverName`, `deviceId` and `routeVersions` (`routeVersionId`, `label`): what the Pi's drivers file needs. Or `refused`: `driver_not_found`, `device_unavailable` (unknown or revoked), `route_version_unavailable` (none, over 20, or one not approved for new runs: superseded, never approved, or not a route version), `invalid_ttl` (over 0 and at most 16 h, `MAX_GRANT_TTL_MS`). Refusals are audited. |
| `driverGrants:listForStaff` (query) | `{}` | `ready` with active `grants` (not revoked, not expired: `grantId`, `driverUserId`, `deviceId`, `deviceLabel`, `routeVersions`, `issuedAtMs`, `expiresAtMs`, `issuedByName`), never a secret or hash; and the `routeVersions` a grant may name (`routeVersionId`, `label`, `versionNumber`). |
| `driverGrants:revokeForStaff` (mutation) | `{ grantId }` | `ok` (idempotent; the next trip event with it is refused, including ending a run it started), or `refused` (`not_found`). |
| `staffInvitations:create` (action) | `{ displayName, ttlMs }` | `created` with `invitationId`, `token` (shown once; only its hash is stored, purpose `staff_invitation`, single use) and `expiresAtMs`. Or `refused` (`invalid_name`, `invalid_ttl`: 1 hour to 7 days). |
| `staffInvitations:list` (query) | `{}` | `ready` with `invitations` (`invitationId`, `displayName`, `issuedAtMs`, `issuedByName`, `expiresAtMs`, `revoked`, `usedAtMs`). |
| `staffInvitations:revoke` (mutation) | `{ invitationId }` | `ok` (idempotent), or `refused` (`not_found`, including any other kind of code). |

For a signed-in caller, every change writes an audit row: `allowed` when applied, `denied` when the caller is not staff. The credential actions also record their refusals as `denied`. Families see today's calendar notice and a cancelled or completed run through `tracking:myRun` (§8: `serviceNotice`, `endedRun`), never the staff reason.

**Joining as staff.** `staffInvitations:redeem` (mutation, `{ token }`) is called by the person invited, from the family website, not by staff. It needs a signed-in identity (`access_unavailable` `unauthenticated` otherwise) that is not linked to any account, and creates a `staff` account linked to it with the invitation's name: `joined` with `displayName`. A retry by the same person answers `joined` again. Refusals: `already_linked` (this sign-in already has an account; the code is not used up), `identity_unverified` (the identity provider says the email is unverified), and `invalid_code` for unknown, malformed, expired, used, revoked and other-purpose codes alike. A staff invitation is never accepted as an enrollment, guardian or check-in code (`wrong_purpose`). Every attempt is audited with the identity as actor. The first staff account on a deployment comes from the internal `users:bootstrapStaff` (backend README).

**Checks.** `checks` entries have a `code`, a `severity` (`blocking` or `warning`) and a `message`.
- Blocking, which prevents approval: `too_few_points` (under 2), `too_many_points` (over 2000, `MAX_ROUTE_PATH_POINTS`), `invalid_coordinate`, `no_stops`.
- Warnings, which the reviewer decides on: `path_gap` (consecutive points over 100 m apart, `ROUTE_GAP_WARNING_M`; maps draw straight lines between points, so a longer gap cuts across blocks), `stop_off_path` (a stop over 150 m from every path point) and `gap_in_recording` (the Pi lost GPS while recording, with the count; the line across each loss is drawn dashed and is not measured travel, however short).

**Approval and version pinning.**
- Approval copies the draft into a new immutable `routeVersions` row and its ordered `stops`, and sets `routes.currentVersionId`.
- A new run pins `routes.currentVersionId` at creation (`approvedVersionForNewRun` in `apps/backend/convex/lib/routeVersions.ts`). A run already started keeps its version, and approved versions are never edited.
- A superseded version must not start a new run, even if an older driver grant names it. `startRun` (§6) checks `isApprovedForNewRuns`, also in `lib/routeVersions.ts`, and answers a superseded version with the existing `403 GRANT_NOT_AUTHORIZED`. Versions created before route review existed stay allowed.
- Approving an approved draft returns the same version.
- Refusal codes:
  - `not_found`
  - `already_decided`
  - `blocking_checks`
  - `route_has_assignments`: approved assignments still point at the current version, and moving them to a new version (enrollment) does not exist yet. Approving would leave those families seeing no trip while the bus runs.
  - `direction_mismatch`: a revision whose direction differs from its route's.
  - `reason_required`: a rejection without a reason.

**Audit.** Each allowed staff mutation appends an `auditLog` row. Mutations return typed results instead of throwing, so a denied attempt by a signed-in person is recorded too.

Route drafts are created only by the driver upload path (`POST /device/v1/route-drafts`, §7.1) and the internal `routes:recordDraft` used by tests and tools; there is no public create-draft.

## Sources

- [Convex HTTP action routing and body validation](https://docs.convex.dev/functions/http-actions)
- [Convex Swift client](https://docs.convex.dev/client/swift/overview)
- [Swift and Convex numerical conversion](https://docs.convex.dev/client/swift/data-types)
- [Convex authentication inside functions](https://docs.convex.dev/auth/functions-auth)

All endpoint names, example data, response variants, limits, and field choices are proposed I.T.S.S.B. contract decisions.
