# 04 — The Raspberry Pi application you will build

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

The Pi needs a custom application, not just a GPS package. That application turns receiver reports and driver actions into durable, authorized trip records. It also serves the touchscreen and synchronizes with the backend.

This document is a build specification. The package, routes, database migrations, tests, and launcher described here are **proposed files to implement**. They are not installed software supplied with the Markdown pack.

Related guides: [Setup](03_RASPBERRY_PI_SETUP.md), [Driver screens](05_DRIVER_TOUCHSCREEN.md), [Data contract](08_DATA_CONTRACTS_AND_API.md), [Deployment](14_DEPLOYMENT_AND_OPERATIONS.md).

## 1. What actually runs on the Pi

Use four cooperating parts:

| Part | Process or mechanism | Main purpose |
| --- | --- | --- |
| GPSD | Packaged Linux service/socket | Own the receiver and supply normalized reports on loopback port 2947. |
| Device application | One Python service | Validate GPS, own trip state, write SQLite, upload events, and authorize driver actions. |
| Local interface server | FastAPI/Uvicorn within the application | Serve the driver UI and its local API at 127.0.0.1:8765. |
| Driver display | Chromium in the desktop session | Render the locally installed UI; no direct access to database or cloud device secret. |

The proposed first implementation combines device tasks and the local API in **one application process with one worker**. A multi-worker web server would otherwise start several independent collectors or uploaders unless you deliberately separated those responsibilities.

FastAPI supports lifespan startup/shutdown handling. Use it to open resources, start background tasks once, stop them cleanly, and close the database/network clients. Uvicorn exposes worker and reload settings; a production device should not run its development auto-reloader. [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/) · [Uvicorn settings](https://uvicorn.dev/settings/)

The browser is a separate process. If Chromium exits, collection continues. If the Python process restarts, SQLite retains the committed state and pending work.

## 2. What files you put in the project

The source repository should contain a Python package, frontend source, tests/fixtures, and installation templates. In the shared repository layout, Python paths below are relative to `device/`. The editable driver frontend lives in the sibling `driver-ui/` area; its build output is copied into the Python package's static assets. These paths describe files to create.

| Proposed source path | Contents |
| --- | --- |
| `pyproject.toml` | Python package metadata, supported Python version, and dependencies. |
| `requirements.lock` | Tested dependency versions and the selected reproducible-install format. |
| `src/itssb_device/__main__.py` | Entry point that loads configuration and starts one application instance. |
| `src/itssb_device/config.py` | Typed settings, required field checks, and secret redaction. |
| `src/itssb_device/models.py` | Internal GPS, trip, queue, command, and health models. |
| `src/itssb_device/gps_reader.py` | GPSD connection, WATCH subscription, report parsing, and reconnect logic. |
| `src/itssb_device/telemetry.py` | Quality validation and selection of observations for cloud publication. |
| `src/itssb_device/database.py` | Connection settings, serialized writes, transactions, and migrations. |
| `src/itssb_device/migrations/` | Numbered schema changes with compatibility checks. |
| `src/itssb_device/trips.py` | Online start, durable run recovery, stop progress, and local end. |
| `src/itssb_device/recording.py` | Draft-route samples, marked stops, and quality gaps. |
| `src/itssb_device/sync.py` | Authenticated upload, retry policy, per-event acknowledgments, and reconciliation. |
| `src/itssb_device/driver_auth.py` | Driver session verification, PIN checks, attempt limits, and scope. |
| `src/itssb_device/commands.py` | Auditable notes, corrections, route removal, and issue reports. |
| `src/itssb_device/qr.py` | Display of backend-authorized enrollment/check-in challenges. |
| `src/itssb_device/health.py` | GPS age, queue age, disk pressure, process state, and measured diagnostics. |
| `src/itssb_device/api.py` | FastAPI routes, local session checks, input validation, and static files. |
| `src/itssb_device/static/` | Built HTML, JavaScript, CSS, icons, and other local interface assets. |
| `../driver-ui/` | Editable touchscreen source in the sibling repository area, before building its static bundle. |
| `tests/fixtures/` | Fictional GPS, run, backend-response, and failure scenarios. |
| `deploy/` | Reviewed systemd, configuration, provisioning, and kiosk-launch templates. |

The package name `itssb_device` is a project decision. Installing Python, GPSD, or FastAPI does not create it.

Develop and version the source on your development computer or Pi. Deploy a tested release into `/opt/itssb/current`; keep mutable state outside that release so an update does not erase trips.

## 3. Runtime directory ownership

| Runtime location | Owner/access proposal | Why |
| --- | --- | --- |
| `/opt/itssb/current` | Root-managed; service can read | Prevent runtime code from rewriting itself. |
| `/opt/itssb/venv` | Root-managed; service can execute | Reproducible application dependencies. |
| `/etc/itssb/device.toml` | Root-owned, readable by service group | Nonsecret operating settings. |
| `/etc/itssb/device.env` | Root-owned, mode 0600 | Prototype credential provisioned by administrator. |
| `/var/lib/itssb` | Service-owned, mode 0700 | Database and other necessary durable application state. |
| Desktop kiosk profile | Normal desktop user | Browser state stays outside the service account. |

The service never needs the student's full address to place a marker at an assigned stop. Cache only the approved operational fields required for the selected route/run.

Do not commit real configuration, tokens, database copies, or rosters to source control. Configuration examples use clearly nonfunctional placeholders.

## 4. Nonsecret configuration template

The following is a **proposed parser contract**, not a file that an existing program already reads:

~~~toml
schema_version = 1
device_label = "ITSSB-DEMO-01"
service_timezone = "America/New_York"

[local_api]
host = "127.0.0.1"
port = 8765

[gps]
host = "127.0.0.1"
port = 2947
sample_interval_seconds = 1

[telemetry]
publish_interval_seconds = 5
max_batch_events = 50
max_batch_bytes = 131072

[storage]
database_path = "/var/lib/itssb/device.sqlite3"

[backend]
# Replace with the actual authorized device HTTP origin.
# For hosted Convex HTTP actions, use the deployment's .convex.site origin.
device_api_origin = "https://REPLACE_WITH_DEVICE_HTTP_ORIGIN"

[operating_policy]
allow_new_offline_run = false
~~~

> **Implementation note (Phase 2):** the first implementation reads all settings from environment variables, which systemd injects from `/etc/itssb/device.env`. There is no separate TOML file yet. Names and defaults are listed in [`apps/device/deploy/device.env.example`](../apps/device/deploy/device.env.example).

Validate configuration on startup. Refuse impossible intervals, non-loopback local binding, unsupported schema versions, or a malformed production HTTPS origin. Expose an understandable configuration error without printing the token.

The protected environment file can define the application's chosen variable `ITSSB_DEVICE_TOKEN`. The authorized administrator supplies its real value. This is an application-specific name, not a pre-existing Convex environment variable.

For the prototype, systemd reads the root-owned environment file. The service itself should not gain general sudo privileges to rewrite it. Rotation means install a new approved credential and restart the service in a maintenance window. A later automated provisioning mechanism needs an explicitly scoped design.

## 5. GPS ingestion: receiver reports are not yet trusted trip data

Connect to GPSD at 127.0.0.1:2947 and request its JSON watch stream. The application should keep a bounded line buffer, reject oversized/malformed input, and reconnect with backoff if GPSD restarts.

The standard WATCH request is:

~~~text
?WATCH={"enable":true,"json":true};
~~~

Parse report classes separately. TPV supplies position-related fields; SKY can support satellite diagnostics. GPSD documents that fields may be absent, and more than one partial report may describe a measurement epoch. Do not assume a line contains all fields. [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)

Before accepting a cloud observation:

1. Confirm it belongs to the intended receiver.
2. Require coordinate-bearing fix mode 2 or 3.
3. Require finite latitude/longitude in their valid ranges.
4. Establish a plausible current capture timestamp.
5. Reject duplicates of an already-selected measurement epoch.
6. Preserve unknown speed, heading, and accuracy as null.
7. Check grossly implausible movement against recent valid history.
8. Associate the observation with the intended authorized active run.

A missing timestamp must not be silently replaced by an arbitrary current time and represented as a precise GPS capture. Retain a diagnostic reason and withhold unreliable live publication until the timing policy is satisfied.

Use monotonic elapsed time for local freshness and timers, since a wall clock can jump. Use the contract's UTC epoch milliseconds for persisted/shared timestamps.

Do not smooth away a real gap by claiming the bus followed a fabricated straight segment. Any visual interpolation stops when the data is stale.

## 6. Sampling, recording, and cloud publication have different rates

The proposed initial policy is:

- Inspect/refresh the latest usable receiver state approximately every second.
- During an active run, select and save a cloud observation approximately every five seconds.
- During explicit route recording, retain separate local path samples at approximately one second where useful.
- Publish status changes or driver commands through their own event workflow.

These are targets to measure, not guaranteed receiver or network performance.

Saving every one-second raw sample into the outgoing telemetry queue would multiply cloud volume. The default design intentionally separates raw draft recording from selected cloud telemetry. A two-hour active trip at a five-second publication interval produces approximately 1,440 selected location observations before considering exceptional events.

When no authorized run or deliberate route-recording session is active, follow the agreed privacy/operating policy. Do not silently turn the device into continuous off-duty vehicle tracking.

## 7. The local database and outgoing queue

SQLite holds two related things: the device's state and a list of work that the backend has not yet acknowledged. That list is often called an **outbox**.

Suggested local tables include:

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Records applied database versions. |
| `device_state` | Pairing/configuration generation and persistent settings. |
| `local_runs` | Server run identity, pinned route version, state, and next durable run sequence. |
| `telemetry_events` | Selected immutable cloud observations. |
| `outbox` | Event/command payload, retry state, next attempt, and server acknowledgment. |
| `route_cache` | Approved geometry, stops, version, authorization scope, and expiry. |
| `roster_cache` | Minimal permitted roster with freshness/expiry. |
| `draft_recordings` and `draft_samples` | Separate raw recording sessions and path observations. |
| `local_audit` | Driver actions and correction provenance. |

A selected observation must be committed with its outgoing work in **one transaction**. Conceptually:

~~~text
BEGIN TRANSACTION
  verify the intended local run is still active
  reserve the next runSequence
  create eventId once
  insert the immutable telemetry event
  insert its exact outgoing payload into outbox
  save the updated runSequence
COMMIT
~~~

If that transaction fails, do not claim the observation was saved. If upload fails afterward, the committed payload remains available.

For each collector process start, create a new UUID called **bootId**. Here it means a software collector session, not the Linux kernel boot ID. Its per-session `sequence` resets only with a new bootId. The `runSequence` continues from SQLite across both process restarts and OS reboots. The saved `eventId` is the primary deduplication identity.

Never generate a new eventId every time the uploader retries.

## 8. Database durability and bounded storage

A reasonable starting database configuration is WAL mode, foreign keys enabled, a finite busy timeout, and deliberate synchronous settings. Serialize writes through one application writer so slow disk work does not block the UI event loop.

In WAL mode, SQLite's documentation distinguishes `synchronous=FULL` from NORMAL for power-loss durability. Prefer FULL for the durable trip/outbox path unless measured requirements support a carefully documented alternative. WAL also creates associated files and needs checkpoint management. [SQLite synchronous settings](https://www.sqlite.org/pragma.html#pragma_synchronous) · [SQLite WAL](https://sqlite.org/wal.html)

These settings do not make an SD card immune to corruption or guarantee survival of arbitrary hardware/power failure. The purchased assembly has no backup power. Once power disappears, recording stops.

Set a storage budget and monitor disk space, outbox age, and outbox count. Remove acknowledged records according to retention policy; do not silently delete unacknowledged trip events to make the status look healthy. If space becomes insufficient, show an operational fault and follow an explicit degraded-mode policy.

**Built storage policy (docs/13 D12).** Before each recording step the recorder measures free space on the database's volume (what the service user may still write) and the number of pending outbox rows. Each has two thresholds, set in `device.env`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `ITSSB_STORAGE_WARN_FREE_MB` | 512 | Warning at or below this free space (1 MB = 1,000,000 bytes) |
| `ITSSB_STORAGE_CRITICAL_FREE_MB` | 128 | Critical at or below this; must be below the warning |
| `ITSSB_OUTBOX_WARN_PENDING` | 10000 | Warning at this many unsent positions (about 14 hours of recording) |
| `ITSSB_OUTBOX_CRITICAL_PENDING` | 50000 | Critical at this many; must be above the warning |
| `ITSSB_REDUCED_PUBLISH_INTERVAL_SECONDS` | 60, or 4 × the publish interval if that is longer | Cadence while critical; must be longer than the publish interval |
| `ITSSB_ACKNOWLEDGED_RETENTION_HOURS` | 168 | Acknowledged rows kept this long while space is fine |

- **Warning:** nothing changes in recording. `GET /health` has a `storage` section (`level`, `recording`, free and total bytes, pending count, each threshold, and the last cleanup), and the driver screen adds a **Recording** chip, for example "Space low: Storage getting full: 410 MB free (limit 512 MB)."
- **Critical:** recording is reduced, not stopped. An active run saves a position only when it was captured at least the reduced interval after the run's newest saved one, so families still get an aged, honest position while the queue drains or space returns. Health says `recording: "reduced"`, and the driver screen shows "Saving less" with the cause, the number, and the cadence. It is not a start blocker: only a failing save (`recorder.fault`) blocks starting a run.
- **Recovery:** the first check below critical returns to the normal cadence. No restart is needed.
- **Never:** a pending or rejected row is never deleted, rewritten, or marked acknowledged to free space or clear a warning.
- **Cleanup:** the recorder removes acknowledged events (and their outbox rows) captured before the retention cutoff, at most 2,000 per transaction, hourly while space is fine and every 5 minutes while it is low. With space at warning or critical the age cutoff is dropped, because the server already holds those rows. The active run and the most recently ended run are never cleaned, since the trip summary counts them. SQLite reuses the freed pages, so the database stops growing, but the file does not shrink and disk free space does not rise; `VACUUM` is not run because it needs free space the size of the database. A failed cleanup is logged and retried; it never stops recording.
- **Unknown:** if free space cannot be measured, the disk part reads `unknown` with the error name and recording stays normal. Before the first check the whole section is `unknown`.

The cloud heartbeat is unchanged: it already sends `pendingCount` and `oldestPendingCapturedAtMs`, which show a growing queue to staff. Free space stays on the device for now.

Back up a live SQLite database through a supported backup method. Copying only the main file while writes are active can omit relevant WAL state. [SQLite backup API](https://www.sqlite.org/backup.html)

## 9. Upload and acknowledgment

The uploader reads committed outbox items and sends bounded authenticated requests to the device HTTP endpoints in [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md).

The important rules are:

- Verify TLS certificates.
- Use explicit connection/read/write timeouts.
- Reuse a bounded network client rather than opening unbounded connections.
- Retry transient failures with exponential backoff and jitter.
- Respect server rate limits and retry guidance.
- Keep the same event/request identities when the outcome is unknown.
- Limit retry loops so the UI and local recording remain responsive.

HTTPX supports explicit network timeout categories; select values for measured cellular behavior rather than disabling timeouts. [HTTPX timeouts](https://www.python-httpx.org/advanced/timeouts/)

An HTTP 200 response is not permission to delete the entire batch. Match each result to its eventId:

| Result | Local action |
| --- | --- |
| `accepted` | Mark this event acknowledged in a local transaction. |
| `duplicate` | Mark this event acknowledged; the matching record already exists. |
| `retryable` | Keep pending and schedule a later attempt. |
| `rejected` | Preserve the record and reason for reconciliation; do not blindly retry forever. |
| Missing result / timeout | Keep uncertain work and retry the same identity. |

If event content conflicts under an existing identity, do not overwrite history. Flag the mismatch for investigation.

After an outage, submit a fresh observation promptly while draining historical batches at a controlled rate. Historical samples retain their capturedAtMs and must not become new approaching-bus alerts. Authentication rejection is a device-access problem, not a reason to discard the queue or rotate credentials silently.

## 10. Trip lifecycle

The canonical run states are `scheduled`, `active`, `completed`, and `cancelled`. Local/cloud synchronization state is separate.

### Start online

The driver selects an approved route and passes preflight. Save a stable requestId before submitting the start request. The backend validates assignment and returns a server-issued runId. A legitimate retry returns the same logical result.

Only after acceptance should the device represent the run as an authorized active run. If the response is lost, use the request identity to reconcile rather than starting another run.

### Continue offline

The first-version offline mode continues an already authorized run with its cached route and permitted roster. It saves observations and allowed driver actions. The UI explicitly says that families are not receiving new bus updates.

Starting a completely new run offline is outside the initial enabled scope. It would need a separately designed, expiring grant. `allow_new_offline_run=false` is intentional.

### Recover after restart

Read the existing run and pending outbox. Start a new collector bootId, retain the runId and next runSequence, reacquire GPS, and recover the driver lock state. Do not invent a completed run or a new run simply because the process restarted.

### End locally, then synchronize

Complete the local run through the same serialized database writer used by telemetry. In one transaction, re-check that the run is active, freeze its final runSequence as lastRunSequence, mark the local run completed, and persist the end command/outbox record with its stable requestId and the original bound driver-authorization reference. Telemetry insertion must also re-check active state inside its transaction; a GPS task that began earlier must not append a new observation beyond the committed end boundary.

Keep cloud synchronization status separate from local completion. A crash between separate state/outbox writes could otherwise resume a run already shown as completed or lose its end command. After the atomic commit, the local screen can say Completed locally / Pending sync. Once accepted, it can say Synced. The backend must still be able to reconcile valid earlier observations delivered afterward without reactivating the run.

Ending a digital run does not certify that the bus is physically empty.

## 11. Driver commands and permissions

The browser submits commands to the local API. The Python service checks the current driver, assigned scope, motion/stopped context, input, and command identity.

Sensitive actions include showing the roster, editing notes/seats, correcting a check-in, removing a student from the authorized route, and reporting an issue. Save author, time, intended run/assignment, and reason where appropriate.

Offline route removal is locally pending. It does not revoke the student's cloud access until the backend receives and authorizes the request. A queued command may be rejected if the driver's authority changed; show that result and retain the audit trail.

The local PIN verifier needs a suitable password-hashing implementation, rate limiting, and an administrator recovery process. Do not store a plaintext PIN or a universal override PIN.

## 12. Local API and the touchscreen

Local endpoints. Built ones are marked; the rest are still proposals:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Built. Minimal process readiness without secret/roster disclosure, including the `storage` budget (§8), `upload` retry counters (failures in a row, retries since start, last error class and time) and `system` measurements (service memory, memory available, CPU temperature, database size; `null` where the Pi cannot read them). The heartbeat sends the same values (docs/08 §7). |
| `GET /api/session` | Built. Kiosk session cookie, CSRF token, and provisioned driver names. |
| `GET /api/status` | Built. Authorized operating snapshot for the kiosk: health plus motion, driver session, capabilities, and the recording. |
| `POST /api/session/unlock` | Built. Unlock a provisioned driver with a PIN (scrypt hash, device-wide lockout). |
| `POST /api/session/lock` | Built. Clear the driver session and hide protected content. |
| `POST /api/motion/parked` | Built. Driver confirms a safe stop; refused unless a fresh fix shows the bus stopped. |
| `POST /api/recordings` | Built. Begin an authorized route draft recording. |
| `POST /api/recordings/{id}/stops` | Built. Mark a draft stop at the device's own fix while parked. |
| `POST /api/recordings/{id}/stops/{stopId}` | Built. Rename, reorder, or remove a draft stop while parked. |
| `POST /api/recordings/{id}/finish` | Built. Save the draft on the device (not a submission). |
| `POST /api/recordings/{id}/submit` | Built. Queue the finished draft for staff review with the unlocked driver's grant; sent and retried with the same `requestId`; "submitted" only once the server accepts it. |
| `POST /api/recordings/review-status` | Built. Re-read review status (awaiting approval, approved, rejected with reason) from the server, at most every 30 s. |
| `POST /api/runs/start` | Built. Submit an idempotent online trip start with the unlocked driver's grant; a start with no answer is resent with its original `requestId`. |
| `POST /api/runs/{runId}/end` | Built. Complete the run locally with its final sequence boundary, then send `endRun`; retried until the server answers. |
| `POST /api/commands` | Submit a typed, validated driver operation. |

These are proposed local route names; their cloud counterparts have separate authentication and contracts. Protected reads need session checks too.

Loopback binding limits network reachability but does not replace browser security. Validate the Host/Origin, use same-origin controls and CSRF protection for state changes, reject arbitrary CORS origins, and prevent unrelated webpages from using the local API. Never expose the cloud device token to JavaScript or browser localStorage.

The local UI can receive small snapshots by polling or one local WebSocket. It must age the last-update label even when no new event arrives.

The four original dashboard actions remain **Show QR Code, Record Route, Start Route, Show Students**. See the complete D01–D24 behavior in the driver guide.

## 13. QR codes and map assets

The Pi displays backend-authorized invitation/challenge data. Enrollment and trip check-in must remain distinct. The backend, rather than the browser, determines permitted purpose and expiry.

An expired code should disappear or be marked expired. If the device cannot refresh an online challenge, show that limitation instead of repeatedly displaying an apparently valid code. Students without phones need the authorized staff workflow.

Bundle the UI's JavaScript/CSS/icons locally. Cache approved route geometry and stop coordinates. When internet fails, a simple route line, stop list, and text progress can remain available. Online basemap tiles do not automatically become a complete offline map.

Keep the QR/roster controls unavailable in the moving interface. GPS low speed alone is not proof of a safe parked state; unknown motion should not automatically unlock complex controls.

## 14. systemd service template

**Install this only after the custom package, configuration, dependency environment, and startup/shutdown behavior exist.** Save the reviewed unit as `/etc/systemd/system/itssb-device.service`.

~~~ini
[Unit]
Description=I.T.S.S.B. local device application
Wants=gpsd.socket
After=network.target gpsd.socket
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=itssb
Group=itssb
WorkingDirectory=/opt/itssb/current
Environment=ITSSB_CONFIG=/etc/itssb/device.toml
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-/etc/itssb/device.env
ExecStart=/opt/itssb/venv/bin/python -m itssb_device
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/itssb
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
~~~

> **Implementation note (Phase 2):** the shipped unit is [`apps/device/deploy/itssb-device.service`](../apps/device/deploy/itssb-device.service), with owner steps in [`deploy/INSTALL.md`](../apps/device/deploy/INSTALL.md). The runtime is the standard library only, so it runs the source tree with `/usr/bin/python3` and `PYTHONPATH` instead of a virtualenv. `StateDirectory=itssb` creates `/var/lib/itssb`, and `RestartPreventExitStatus=2` keeps a configuration error from becoming a restart loop.

The service waits for local OS/network startup ordering, not successful internet access. It must remain useful when the cloud is unavailable. GPSD is wanted rather than making all UI operation fail when GPS is missing. The leading minus makes the credential file optional at process startup so an unpaired device can show restricted setup and diagnostics. Missing credentials must disable cloud uploads, trip starts, and protected operation; they must never grant default access.

This is a starting hardening configuration, to validate against actual installed systemd and application needs. The service reads GPS through loopback TCP, so it normally does not need direct serial device permissions. systemd's execution and restart directives are documented in its manuals. [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) · [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

The Python entry point must handle termination, stop accepting new commands, commit bounded pending writes, close clients, and exit within the stop timeout. A supervisor restart is recovery assistance, not proof that data is correct.

## 15. Logging, maintenance, and the first build

Log event types, request identities, software versions, queue counts, and safe error codes. Avoid student names, addresses, PINs, tokens, or complete request bodies in routine logs. Configure journald retention and monitor storage.

Do not let the application install arbitrary updates while a trip is active. Deploy a reviewed release during maintenance, back up relevant state, run compatible migrations, and retain a rollback plan.

Build in this order:

1. A local health page that loads without internet.
2. A GPSD reader that produces a validated current position.
3. SQLite selected observations and outbox in one transaction.
4. Authenticated telemetry upload with partial acknowledgments.
5. Online trip start/end with restart recovery.
6. Driver session and route/roster cache.
7. The complete local interface and QR workflows.
8. Failure scenarios and maintenance behavior.

You know the central Pi application works when a fresh authorized observation reaches the iPhone, a deliberate internet outage creates a durable queue and honest stale state, and reconnection resumes current tracking without duplicate trips or old alerts.

## Sources

- [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)
- [FastAPI lifespan events](https://fastapi.tiangolo.com/advanced/events/)
- [Uvicorn settings](https://uvicorn.dev/settings/)
- [HTTPX timeouts](https://www.python-httpx.org/advanced/timeouts/)
- [SQLite WAL](https://sqlite.org/wal.html)
- [SQLite synchronous settings](https://www.sqlite.org/pragma.html#pragma_synchronous)
- [SQLite backup API](https://www.sqlite.org/backup.html)
- [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [systemd services](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

Architecture, filenames, paths, settings, and event policies are I.T.S.S.B. design decisions. Platform documentation explains the underlying capabilities; it does not implement these project rules.

