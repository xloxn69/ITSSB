# I.T.S.S.B. — Backend and database

**Intelligence Transportation System for School Buses**  
**Status:** Proposed implementation guide. The commands below initialize development tooling; the application functions and database rules still need to be written.

Read next: [Data contracts and API](08_DATA_CONTRACTS_AND_API.md), [Security and access](11_SECURITY_PRIVACY_AND_ACCESS.md), and [Deployment and operations](14_DEPLOYMENT_AND_OPERATIONS.md).

## 1. What the backend is

The backend is the shared service that the bus device, iPhone app, and website contact over the internet. It receives observations, verifies permissions, stores records, and supplies each person with the information they are allowed to see. The Pi remains responsible for local operation when disconnected.

Use Convex with TypeScript as the proposed starting backend. Its database and reactive query model fit the live tracking interface, while device-facing HTTP actions provide a clear boundary for Python uploads. This choice does not supply school-specific permissions, GPS validation, trip logic, QR rules, or predictions automatically. Those are I.T.S.S.B. application code.

Keep three kinds of responsibility separate:

| Function category | I.T.S.S.B. use |
| --- | --- |
| Query | Read an authorized assignment or current trip snapshot. |
| Mutation | Commit a checked change, such as accepting a telemetry event or enrollment request. |
| Action / HTTP action | Communicate with an external service or accept a device HTTP request. |

Convex mutations execute database changes transactionally; third-party effects belong outside that transaction in actions. This supports a pattern where the database records a notification job before an external delivery attempt. See [Convex mutations](https://docs.convex.dev/functions/mutation-functions).

## 2. What you install and where

Develop the backend on your development computer, alongside the repository. You do not need to install the Convex development environment on every bus Pi. The Pi runs the Python device client and contacts the deployed service.

Prerequisites are a supported Node.js environment, npm, Git, and access to the intended Convex organization/project. Record the chosen Node and dependency versions in the repository. Do not assume an arbitrary preinstalled Node version is supported.

For a new, empty backend project directory, these are real setup commands:

```bash
npm init -y
npm install convex
npx convex dev
```

The last command is interactive and connects development code to a development deployment. Verify the account, team, and project being selected. If the repository already has `package.json` and a lockfile, use its existing dependency installation procedure instead of initializing it again. The official [Convex CLI guide](https://docs.convex.dev/cli/overview) documents installation and development configuration.

After setup, preserve the package lockfile and generated configuration. Keep local environment files and credentials out of version control. A deployment URL is configuration; an administrative deploy key is a secret. They must not be treated interchangeably.

**Checkpoint:** the development deployment is identifiable, the local CLI can type-check a harmless development function, and no production data or real students are involved. This does not yet prove that a bus upload works.

## 3. Proposed source organization

These files are a plan to implement, not files already supplied by this documentation pack.

| Proposed path under the backend project | Responsibility |
| --- | --- |
| `convex/schema.ts` | Table definitions, field validators, indexes. |
| `convex/auth.config.ts` | The selected identity provider's backend configuration. |
| `convex/http.ts` | Device HTTP route registration. |
| `convex/deviceHttp.ts` | Bounded body parsing, credential verification, HTTP responses. |
| `convex/devices.ts` | Pairing, credential status, health, device authorization. |
| `convex/runs.ts` | Idempotent start/end, active-run constraints, substitutions. |
| `convex/telemetry.ts` | Event acceptance, deduplication, historical storage. |
| `convex/tracking.ts` | Compact person-scoped live snapshots. |
| `convex/routes.ts` | Drafts, versions, stops, approval, publication. |
| `convex/enrollment.ts` | Invitations, private details, stop requests, approvals. |
| `convex/checkIns.ts` | Student claims, staff records, corrections. |
| `convex/notifications.ts` | Preferences, push-token associations, outbox. |
| `convex/predictions.ts` | Baseline results and controlled model integration. |
| `convex/audit.ts` | Append-only records of sensitive application decisions. |
| `convex/lib/authorization.ts` | Reusable organization/role/relationship checks. |
| `convex/lib/validation.ts` | Domain validation beyond basic field types. |
| `convex/crons.ts` | Bounded maintenance and recovery tasks. |
| `tests/fixtures/` | Fictional routes, accounts, and replayable events. |

Do not put all logic in the HTTP route. It should parse and authenticate a request, then call a narrowly scoped internal function that checks current database state and commits the result. This keeps the same rules usable from tests and other authorized workflows.

## 4. Database entities

Every protected record must be traceable to its organization. A route number such as “17” is a label, not a global identifier. Human names and addresses are never database identity keys.

| Table/group | Main fields or relationships |
| --- | --- |
| `organizations` | Display name, service timezone, configuration references. |
| `users`, `memberships` | Verified identity-provider reference; approved organization role and status. |
| `buses` | Organization, fleet label, operating status. |
| `devices`, `deviceCredentials` | Assigned bus, pairing generation, revocable credential digest, version, health. |
| `driverAssignments` | Authorized driver, vehicle/route scope, effective period. |
| `routes`, `routeVersions` | Stable route, immutable approved version, direction, geometry, effective dates. |
| `routeStops` | Version, stop identity, ordered index, coordinates, pickup instructions. |
| `students`, `assignments` | Student record and approved route/stop/direction relationship. |
| `enrollmentRequests`, `enrollmentDetails` | Pending request and separately restricted private address information. |
| `guardianLinks` | Explicit approved guardian-to-student relationship. |
| `routeRuns` | Pinned version, bus, driver, service date/timezone, state, start/end timestamps. |
| `telemetryEvents` | Accepted immutable positioning observations with source and ordering information. |
| `tripEvents` | Start/end references, delay reports, stop corrections, staff actions. |
| `liveRunState` | Latest valid position, health, progress, current prediction, monotonic revision. |
| `checkIns` | Student/run/phase, source, result, correction history reference. |
| `invitations`, `checkInChallenges` | Purpose-bound temporary tokens, scope, expiration, revocation. |
| `alerts`, `notificationJobs`, `pushTokens` | Logical alert, delivery attempts, permitted recipient devices. |
| `requestReceipts`, `auditEvents` | Idempotency results and sensitive change history. |
| `modelVersions`, `predictionRecords` | Evaluation, activation status, predictions made before arrival. |

Do not return entire database rows just because they contain a useful field. Define explicit response objects. The family tracking query should never accidentally include device credentials, private enrollment addresses, or route-wide driver notes.

## 5. Indexes and invariants

Indexes make recurring lookups efficient. They do not, by themselves, express all application rules. Implement uniqueness and state checks within the same mutation that writes the change.

Proposed lookup indexes include:

- Membership by identity and organization.
- Assignment by student, status, direction, and effective period.
- Guardian link by guardian and student.
- Active run by organization and bus; active run by device assignment.
- Stops by route version and order.
- Telemetry by device identity and `eventId`.
- Telemetry by run and `runSequence`, for ordered history.
- Request receipt by actor scope, operation, and `requestId`.
- Check-in by run, student, and boarding phase.
- Notification job by logical event identity and recipient.

Keep query result sizes bounded and paginate history. A growing history table must not be downloaded into every live query. Split static route geometry from the compact state that changes every few seconds.

Core invariants are: one intended active run per assigned bus/device scope; one accepted event for the same event identity; one logical check-in per student/run/phase; no mutation of the route version pinned to an active run; and no live-state rewind caused by late uploads. Test those invariants under concurrent requests, not only one request at a time.

## 6. Human and device authentication

A human signs in using the selected identity provider. The backend derives identity from a verified token, then looks up the applicable school role and relationship. Convex makes authenticated identity available inside functions; application authorization still needs to inspect the requested resource. See [Auth in Functions](https://docs.convex.dev/auth/functions-auth).

A Pi uses a separate, high-entropy, revocable device credential. Issue it during approved provisioning and scope it to the device's current organization/bus assignment. Store the secret only in the protected device configuration; retain a verification representation and status on the server. Rotate it on compromise or reassignment. Never use a Convex deploy/admin key as a bus credential.

Sensitive driver actions also require an authorized driver session. Possessing a device credential does not entitle the device to claim any driver ID. Use a short-lived server-issued driver operating grant after driver authentication. The Pi can cache a limited authorization for continuing an existing run; first-version new run starts remain online.

The device HTTP action verifies credentials and validates request shape. The committing mutation rechecks current credential generation, assignment, and operating permission so that a credential revoked between parsing and commit cannot proceed based only on an old result.

## 7. One position through the backend

The acceptance transaction should perform this sequence:

1. Resolve the verified device and allowed organization.
2. Resolve the run and confirm it belongs to the permitted operating scope.
3. Validate finite coordinates, numeric ranges, timestamps, and sequence values.
4. Look for the device/event identity. If already accepted with matching content, return `duplicate`.
5. Reject conflicting content under an existing identity; do not overwrite history.
6. Insert the accepted observation with server-assigned `receivedAtMs`.
7. Determine whether it is eligible to advance current live state.
8. Update progress/prediction input and revision when appropriate.
9. Record any required downstream job atomically with the relevant state.
10. Return a per-event acceptance result.

HTTP actions require explicit parsing/validation of incoming bodies; regular Convex argument validators are not automatically applied to an arbitrary HTTP body. Their documented deployment endpoint uses the `.convex.site` host, which is distinct from the client deployment URL used by the Swift SDK. See [HTTP Actions](https://docs.convex.dev/functions/http-actions).

Use captured time and persisted run order together. A recent network receipt does not make an old observation fresh. A very large sequence supplied with an implausible future time should not poison the watermark. Keep questionable samples out of live state and make the rejection operationally visible.

## 8. Trip lifecycle and corrections

The states are `scheduled`, `active`, `completed`, and `cancelled`. Network loss and missing GPS are separate attributes. Avoid changing an active run to “completed” merely because no packets arrived.

For start: validate the driver grant, bus, approved version, date/direction, and absence of a conflicting active run. Commit the run and request receipt together. Return the server-issued `runId`. Repeating the same start request returns the same run.

For end: save the device action locally first, then submit its stable request identity. The server accepts a valid transition once, records its time/source, and suppresses future approaching alerts. A local end during an outage remains “completed locally, pending sync.”

Historical telemetry can arrive after an accepted end. Permit an explicitly bounded reconciliation path for observations captured within the run; never reactivate the run or trigger old alerts. A replacement bus/device requires a recorded authorized handover. Sequence comparison across different devices needs an assignment epoch or server ordering boundary, not an assumption that both devices' counters share one history.

Attendance corrections and route removal append an audit event. A correction records who changed what and why. Removing an assignment preserves unrelated identity and historical records. Revalidate authorization when queued offline actions finally arrive.

## 9. Read models and the first milestone

`tracking:myRun` accepts exactly `{ assignmentId }` and derives access from the signed-in identity. For a guardian, selecting a student first resolves an approved assignment through an authorized relationship query; the client then supplies that assignment ID. The tracking query independently rechecks the student assignment or guardian relationship. Return a typed result for ready, no-active-run, and denied/expired states. Do not accept an arbitrary route ID or caller-asserted student context and return its location without checking the relationship.

Only a server-owned snapshot is authoritative for shared run state. The iPhone may animate a marker between accepted points, but that animation is not a new observation. The Pi may show provisional local progress offline, but reconciliation must preserve provenance and conflicts.

Build the first milestone with one fictional organization, driver, route version, assignment, and active run. Verify authorized tracking, a rejected unauthorized query, duplicate upload behavior, and clean completion before introducing the entire administration feature set.

## Sources

- [Convex CLI](https://docs.convex.dev/cli/overview)
- [Convex mutations and transactions](https://docs.convex.dev/functions/mutation-functions)
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions)
- [Convex authentication inside functions](https://docs.convex.dev/auth/functions-auth)
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)

The schema, source-file organization, and operational rules in this guide are proposed I.T.S.S.B. design decisions. Platform documentation establishes capabilities, not completed application behavior.
