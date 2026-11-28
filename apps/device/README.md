# apps/device — bus Pi service

Python service that runs on the bus Raspberry Pi. Spec:
[docs/04](../../docs/04_RASPBERRY_PI_SOFTWARE.md).

## What's here now

| Module | Does |
|---|---|
| `config.py` | Loads and validates settings from the environment / `device.env`; never prints the token |
| `gps.py` | Parses GPSD JSON; turns TPV reports into trusted `Fix`es or a rejection reason |
| `gps_reader.py` | GPSD socket thread: WATCH, bounded line buffer, reconnect with backoff, receiver presence |
| `recorder.py` | During an active run, saves one fresh, new fix per publish interval (never re-saves an old one) |
| `database.py` | SQLite (WAL, `synchronous=FULL`) with migrations; observation + outbox row in one transaction |
| `sync.py` | Applies per-event upload results (`accepted`/`duplicate`/`rejected`/`retryable`) with capped backoff |
| `uploader.py` | `POST /device/v1/telemetry`: bounded batches (50 events / 128 KiB), verified TLS, timeouts, per-event results, backoff + jitter, 401/403/413/429 handling, TCP network probe |
| `trips.py` | Online run start and end over `POST /device/v1/trip-events` with the driver's operating grant; end commands are saved with the local completion and retried |
| `status.py` | Thread-safe health snapshot: GPS, network, backend, outbox, run kept separate |
| `api.py` | Local API on `127.0.0.1:8765`: `GET /health` (JSON), the built driver UI (or a status page), and `/api/*` |
| `driver_api.py` | Driver touchscreen routes: session, unlock, parked, route recording; static UI files |
| `local_auth.py` | Origin/CSRF/session checks for the local API; scrypt driver PINs with a device-wide lockout |
| `motion.py` | Moving / stopped / unknown from fresh fixes; the driver-confirmed **Parked** state |
| `drafts.py` | Route recording into a local draft: a point every ≤ 25 m and at every turn over 20°, none while stopped, gap flags, ≤ 2,000 points (straight runs thinned, corners kept), service-ordered stops |
| `route_geometry.py` | Distance, bearing, and corner-preserving Douglas-Peucker thinning |
| `draft_submit.py` | Submitting a finished draft for review: built and size-checked locally, queued in SQLite with its `requestId`, resent unchanged until the server answers (`/device/v1/route-drafts`); review status read back with its age (`/route-drafts/status`) |
| `route_draft_contracts.py` | Route-draft wire models, checked against `packages/contracts/fixtures/routeDraft.*.json` |
| `students.py` | QR codes, the cached roster, and driver roster actions queued in SQLite and resent with the same `requestId` until the backend answers (`/device/v1/qr-codes`, `/roster`, `/roster-actions`) |
| `service.py` | One process, one writer per thread, SIGTERM/SIGINT clean shutdown, bounded logs |
| `devtools/fake_gpsd.py` | Fake GPSD with **fictional** data for tests and indoor demos |
| `devtools/fake_backend.py` | Local fake of the telemetry, trip-event, QR, roster, roster-action and route-draft endpoints with outage modes (`down`, `drop_response`, `partial`, ...) and fictional students |

Still to build (see [roadmap](../../docs/15_BUILD_ROADMAP.md)): driver
sign-in through `/device/v1/driver-session` (grants are provisioned by an
administrator until then).

## Driver touchscreen

The service serves the built `apps/driver-ui` from `src/itssb_device/static/`
(gitignored; build it with `bun run build:device` in `apps/driver-ui`, or
point `ITSSB_DRIVER_UI_DIR` at a build). Without it, `GET /` shows the plain
status page.

Local API (all on `127.0.0.1:8765`, same origin as the UI):

| Endpoint | Needs | Does |
|---|---|---|
| `GET /api/session` | same-origin | Kiosk session cookie, CSRF token, provisioned driver names (never hashes) |
| `GET /api/status` | session | `/health` plus `motion`, `session`, `capabilities`, and the recording (unlocked only) |
| `POST /api/session/unlock` `{driverId, pin}` | session + CSRF, not moving | PIN check; 5 wrong PINs lock the device for 30 s, doubling to 15 min |
| `POST /api/session/lock` | session + CSRF | Ends the driver session |
| `POST /api/motion/parked` | driver | Confirms Parked; refused unless a fresh fix shows the bus stopped |
| `GET /api/recordings`, `GET /api/recordings/{id}` | driver | Drafts on this device; one draft with ordered stops and a bounded path |
| `POST /api/recordings` `{requestId, name, direction}` | driver + parked + fix, no active run | Starts recording; same `requestId` returns the same draft |
| `POST /api/recordings/{id}/stops` `{requestId, name?}` | driver + parked + fix | Marks a stop at the device's own fix (request coordinates are ignored) |
| `POST /api/recordings/{id}/stops/{stopId}` `{name}` / `{position}` / `{remove: true}` | driver + parked | Renames, reorders, or removes a stop |
| `POST /api/recordings/{id}/finish` | driver + parked | Saves the draft on this device. It is **not submitted** until the driver submits it |
| `POST /api/recordings/{id}/submit` `{requestId}` | driver + parked, grant, server configured, finished draft with ≥ 2 points and ≥ 1 stop | Saves the submission and answers `submission: "pending"`; the sync thread sends it. `submitted` once the server accepts it, `refused` (with `problem`) if it refuses. Stops are frozen from here on |
| `POST /api/recordings/review-status` | driver, grant | Re-reads `submitted`/`approved`/`rejected` (with staff's reason) from the server at most every 30 s; each draft carries `reviewCheckedAtMs` |
| `POST /api/runs/start` `{requestId, routeVersionId}` | driver + parked, grant, server configured, service time zone | Online start; a start with no answer is resent with its first `requestId` |
| `POST /api/runs/{runId}/end` `{requestId}` | driver + parked, grant | Completes the run on this device, then sends `endRun` (retried every 15 s until answered) |
| `POST /api/qr-codes` `{purpose}` | driver + parked, grant, active run | `trip_check_in` (the run) or `route_enrollment` (the run's route version): token, `expiresAtMs`, `remainingMs`. Reused until 2 min before expiry, then refreshed; offline, only an unexpired code; refused or expired, none |
| `GET /api/roster` | driver + parked, grant, active run | The run's students in stop order and this device's queued changes; served `stale: true` with its `fetchedAtMs` when the server does not answer; deleted on a 401/403 |
| `POST /api/roster-actions` `{requestId, type, assignmentId, ...}` | driver + parked, grant, active run, student on the cached roster | Saves the change with its capture time, answers `sync: "pending"`, and the sync thread sends it; `synced` or `rejected` (with `code` and `problem`) once the server answers |

Every `POST` needs `Origin: http://127.0.0.1:8765` (or `localhost`), a JSON
body, the `itssb_kiosk` cookie, and `X-ITSSB-CSRF`. Moving or unknown motion
(no fresh fix) clears Parked; the driver confirms it again after stopping.
Points keep recording while driving.

Drivers come from `ITSSB_DRIVERS_FILE` (default `/etc/itssb/drivers.json`):

```json
{"drivers": [{
  "driverId": "drv_demo", "displayName": "Demo Driver", "pinHash": "scrypt$16384$8$1$...",
  "operatingGrant": "<grant from the staff console, Drivers>",
  "routeVersions": [{"routeVersionId": "<id>", "label": "Demo Route North (to school)"}]
}]}
```

`operatingGrant` and `routeVersions` are optional; without them the driver
can record routes but not start runs. Starting also needs
`ITSSB_SERVICE_TIMEZONE`. The grant never reaches the browser.

No file means nobody can unlock. There is no default or override PIN.

Bench demo with the fake GPSD switched live (`drive`, `stop`, `nofix`):

```sh
echo stop > var/gps
uv run python -m itssb_device.devtools.fake_gpsd --port 2948 --control var/gps
ITSSB_GPSD_PORT=2948 ITSSB_DRIVERS_FILE=var/drivers.json uv run itssb-device run
```

## Install on the Pi

The owner installs the reviewed systemd unit
[`deploy/itssb-device.service`](deploy/itssb-device.service) with sudo,
following [`deploy/INSTALL.md`](deploy/INSTALL.md). `scripts/pi_proof.sh` re-runs
the Phase 2 proof (real GPSD, GPSD stopped/started, kill -9 recovery) without
sudo.

## Commands

```sh
uv run itssb-device run                       # the service (default)
uv run itssb-device watch                     # print GPSD fixes
uv run itssb-device outbox                    # outbox rows: eventId, status, attempts (no coordinates)
echo 482916 | uv run itssb-device hash-pin   # scrypt hash for drivers.json (fictional PIN)
uv run itssb-device fixture-run start         # DEV ONLY: fictional local run "demo_run_001"
uv run itssb-device fixture-run end
```

`fixture-run` stands in for online start until the backend supports it. The
run it creates is not server-issued, so a real backend rejects its telemetry
(`RUN_NOT_AUTHORIZED`). Use it with `devtools/fake_backend.py`.

## Develop

Standard library only at runtime. Targets Python 3.11+ (the Pi runs 3.13).

```sh
uv sync
uv run pytest
uv run ruff check && uv run ruff format --check
```

## Configuration

Settings are environment variables; see [`deploy/device.env.example`](deploy/device.env.example)
for every name and default. In production systemd loads `/etc/itssb/device.env`.
For development copy the example, fill in test values, and pass it explicitly:

```sh
cp deploy/device.env.example var/dev.env   # var/ is gitignored
uv run itssb-device --env-file var/dev.env run
```

Without an origin and token the service still runs: it reads GPS, serves
health, and reports `backend.status: "unconfigured"`. Invalid settings
(non-loopback local API, plain-http remote origin, placeholder values) exit
with status 2 and a message that never contains the token.

## Health

```sh
curl -s http://127.0.0.1:8765/health
```

| Field | Values | Meaning |
|---|---|---|
| `gps.status` | `valid`, `no_fix`, `receiver_missing`, `unknown` | `unknown` = GPSD unreachable, so nothing is known about the receiver |
| `gps.gpsd` | `connecting`, `connected`, `unreachable` | The GPSD socket itself |
| `network.status` | `unknown`, `online`, `offline` | Can we reach the backend host at all |
| `backend.status` | `unconfigured`, `unknown`, `ok`, ... | Outcome of the last authenticated backend request |
| `outbox` | counts + `oldestPendingCapturedAtMs` | Work the backend has not acknowledged |
| `run` | `{runId, state, nextRunSequence}` or `null` | Recovered from SQLite; never invented |
| `upload` | `consecutiveFailures`, `retriesSinceStart`, `lastErrorClass`, `lastErrorAtMs` | Telemetry request failures since this process started; the last error is kept after recovery |
| `system` | `processRssBytes`, `memAvailableBytes`, `cpuTemperatureC`, `databaseBytes` | Read on each snapshot from `/proc`, `/sys` and the database file; `null` when not measurable (macOS dev) |
| `recorder.fault` | `null` or e.g. `save failed: OperationalError` | Observations are not being saved (disk full, ...); cleared after a successful save |

A fix only counts as `valid` if its GPS time is a new measurement epoch, no
more than 30 s old and no more than 2 min ahead of this device's clock (the
backend's limit). After an outage the uploader sends the newest observation
first, then drains history oldest-first.

Every attribute carries its own timestamp or age. Health never includes
coordinates, tokens, or student data.

## Try it on the Pi

With GPSD running and the BU-353N5 plugged in (see
[docs/03](../../docs/03_RASPBERRY_PI_SETUP.md)):

```sh
uv run itssb-device watch
# fix mode=3 lat=... lon=... speed=... capturedAtMs=...
```

Indoors you will usually see `no usable fix: no fix`. That's correct: the app
never invents a position. Take it outside with a clear view of the sky.
