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

- **Grant.** `driverOperatingGrant` is an opaque server-issued secret (32 to 512 URL-safe characters) bound to one device, one driver account, a set of route versions, and an expiry. The server stores only its hash. Until `POST /device/v1/driver-session` exists, an administrator issues grants with the internal `driverGrants:issue` function. An exact retry of an already accepted request, presenting the same grant, is honored after that grant expires; any new start or end needs a current grant. A grant authorizes starting and ending, not each position: telemetry for an active run is authorized by the device credential and the run's device, so revoking a grant never hides a moving bus. To stop a device reporting, revoke its credential.
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

**Proposed endpoint:** `POST /device/v1/health`.

Health reporting distinguishes “online without a GPS fix” from “no device contact.” It can include `bootId`, `capturedAtMs`, application version, active `runId` or null, `gpsStatus`, `lastValidFixAtMs`, pending queue depth, available storage, and observed temperature when measured.

Use `gpsStatus` values such as `valid`, `no_fix`, and `receiver_missing`. Do not send fake coordinates to communicate no fix. The backend assigns `receivedAtMs` and calculates contact age. A missed heartbeat does not prove whether the cause is cellular service, device power, or software failure.

Use an independent, measured heartbeat interval and bounded diagnostic payload. Health must not contain secrets, student names, or private addresses.

### Configuration, route drafts, and displayed QR codes

The full driver workflow also needs the following proposed device operations. They use the same device authentication, request identity, and explicit result rules; implement them after the first tracking milestone.

| Proposed operation | Required behavior |
| --- | --- |
| `GET /device/v1/config` | Return the current permitted bus/device settings, approved route versions, cache revisions, and expiry metadata. Roster fields require the applicable authorized driver context. |
| `POST /device/v1/driver-session` | Exchange independently verified driver authentication for a limited operating grant tied to device/scope. A local PIN alone is not a cloud identity proof. |
| `POST /device/v1/route-drafts` | Create or update an authorized draft with ordered stops and bounded geometry uploads; return draft/review status rather than automatic approval. |
| `POST /device/v1/qr-codes` | Request an enrollment invitation or active-run check-in challenge under an explicit `purpose`; return a bounded display payload and `expiresAtMs`. |

Keep credentials and driver grants in protected headers or bodies, never query strings. Initial driver-session establishment depends on the selected authentication/provisioning workflow; do not ship an endpoint that trusts an arbitrary `driverId` or a common PIN.

Large recorded paths need bounded chunks or an authorized upload object, followed by validation and a submit-for-review command. Preserve recording identity, chunk order, quality gaps, and idempotency. Approved publication creates a route version; it does not overwrite the version of an active run. Config refreshes identify revisions so the Pi can avoid downloading unchanged route geometry.

Both QR purposes require current authorization and expiration checks. A backend outage does not authorize the Pi to invent unlimited replacement tokens. Cached information must retain its original expiry and scope.

## 8. Authorized live snapshot

**Proposed Convex query:** `tracking:myRun` with `{ "assignmentId": "..." }`.

The signed-in identity is supplied through the authenticated client. The query verifies that this is the student's assignment or a permitted guardian relationship. It does not trust a caller-supplied role.

Three queries make up the family tracking contract. TypeScript types live in `packages/contracts/src/tracking.ts`; canonical fixtures are generated to `packages/contracts/fixtures/*.json` and decoded by the backend and Swift tests.

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
      "validUntilMs": 1795609115450,
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
| `lastDeviceContactAtMs` | Last time the backend heard from the bus device, or `null` if never. Until device health reporting exists this is the last telemetry receipt. |
| `gpsStatus` | `valid`, `no_fix`, `receiver_missing`, or `null` when no health report has supplied it. Never inferred from a missing position. |
| `nextStopId` | `null` until the backend tracks route progress. |
| `assignedStop.status` | `upcoming`, `at_stop`, `passed`, or `unknown` (until route progress exists). |
| `busLabel` | Family-facing bus name; a generic label when the device has none. |

The 30-second example prediction validity is illustrative configuration, not a measured accuracy guarantee. The current schema permits `lastPosition: null` and `eta: null`. Optional calibrated bounds stay null until evaluation supports them. Completed/cancelled runs cannot retain an actionable approaching countdown.

`status: "no_active_run"` returns `assignmentId`, `routeVersionId`, and `run: null`; schedule fields (next service, cancellation) are a later addition. `status: "access_unavailable"` contains only `schemaVersion`, `serverNowMs`, and a safe `reason`: `unauthenticated` (sign in again) or `not_permitted` (unknown, malformed, revoked, and forbidden assignments are deliberately indistinguishable). It has no protected route fields. Authentication/session failures can also surface as the SDK's typed error; the repository maps that error to the appropriate UI state. Distinguish an empty schedule from a failed query.

The app ages its freshness label locally between updates. It may estimate server clock offset from `serverNowMs`, but a server time field does not turn a reactive query into a clock. When no data changes, a subscription need not emit a fresh snapshot every second.

### 8.1 Freshness policy (provisional)

| Constant | Value | Meaning |
| --- | --- | --- |
| `POSITION_AGING_AFTER_MS` | `30000` | From this age the app says it is waiting for an update. |
| `POSITION_STALE_AFTER_MS` | `120000` | From this age the position is shown as a last-known location with its capture time; movement animation and any estimate stop. |

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
| `notifications:setPreferences` | `requestId`, permitted assignment/student context, thresholds and enabled types | Validated preferences for that account only. |
| `notifications:registerDevice` | Installation identity, APNs token, app environment, permission status | Associate current token with the signed-in account. |
| `routes:removeAssignment` | `requestId`, assignment, reason, authorized driver/admin context | Scoped revocation and audit record; not global account deletion. |

Private enrollment fields belong only in authenticated submissions and appropriately restricted storage. Treat a scanned link as untrusted input: allow expected scheme/host/path and a bounded token, then ask the backend to validate purpose, expiration, revocation, route, and account eligibility.

The shared trip challenge supports multiple legitimate students. Do not invalidate it globally after the first student scans it. Deduplicate the resulting check-in by student/run/phase. A scan result must identify its source as a student claim; staff-confirmed corrections remain distinguishable.

The final invitation domain and universal-link association are deployment decisions. `https://example.invalid/...` can be used in documentation and fixtures; it is not an operational enrollment service.

## 10. Compatibility and contract verification

Maintain saved fixtures for every major result and error. Python serialization, backend validators, and Swift decoding should consume the same fixtures. Include null GPS, stale timestamps, duplicate events, partial batch failures, no active run, revoked access, and completed-trip notification taps.

Add optional fields compatibly where possible. Do not silently rename a field, change milliseconds to seconds, or change an existing enum's meaning. Use a new version and explicit rollout when a breaking change is required. A server receiving an unsupported version must return a useful error rather than guessing.

Pin the contract revision in each release. All state-changing commands carry stable request identities, and every operation documents whether it is accepted, queued, or still uncertain. That is the basis of reliable recovery across the Pi, backend, and Swift app.

## Sources

- [Convex HTTP action routing and body validation](https://docs.convex.dev/functions/http-actions)
- [Convex Swift client](https://docs.convex.dev/client/swift/overview)
- [Swift and Convex numerical conversion](https://docs.convex.dev/client/swift/data-types)
- [Convex authentication inside functions](https://docs.convex.dev/auth/functions-auth)

All endpoint names, example data, response variants, limits, and field choices are proposed I.T.S.S.B. contract decisions.
