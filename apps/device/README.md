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
| `trips.py` | Online run start flow behind a `RunStarter` interface; ships a stub because the backend has no `/device/v1/trip-events` yet |
| `status.py` | Thread-safe health snapshot: GPS, network, backend, outbox, run kept separate |
| `api.py` | Local API on `127.0.0.1:8765`: `GET /health` (JSON) and `GET /` (status page) |
| `service.py` | One process, one writer per thread, SIGTERM/SIGINT clean shutdown, bounded logs |
| `devtools/fake_gpsd.py` | Fake GPSD with **fictional** data for tests and indoor demos |
| `devtools/fake_backend.py` | Local fake of the telemetry endpoint with outage modes (`down`, `drop_response`, `partial`, ...) |

Still to build (see [roadmap](../../docs/15_BUILD_ROADMAP.md)): the HTTP
`RunStarter` (needs the backend's trip-events endpoint).

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
