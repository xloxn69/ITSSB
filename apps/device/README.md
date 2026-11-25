# apps/device — bus Pi service

Python service that runs on the bus Raspberry Pi. Spec:
[docs/04](../../docs/04_RASPBERRY_PI_SOFTWARE.md).

## What's here now

| Module | Does |
|---|---|
| `gps.py` | Parses GPSD JSON; turns TPV reports into trusted `Fix`es or a rejection reason |
| `database.py` | SQLite (WAL) with migrations; saves an observation and its outbox row in one transaction |
| `sync.py` | Applies per-event upload results (`accepted`/`duplicate`/`rejected`/`retryable`) with capped backoff |
| `__main__.py` | `itssb-device`: prints live GPSD fixes for bench testing |

Still to build (see [roadmap](../../docs/15_BUILD_ROADMAP.md)): HTTP uploader,
online run start, local API on `127.0.0.1:8765`, health reporting, systemd unit.

## Develop

Standard library only at runtime. Targets Python 3.11+ (Raspberry Pi OS).

```sh
uv sync
uv run pytest
uv run ruff check && uv run ruff format --check
```

## Try it on the Pi

With GPSD running and the BU-353N5 plugged in (see
[docs/03](../../docs/03_RASPBERRY_PI_SETUP.md)):

```sh
uv run itssb-device
# fix mode=3 lat=... lon=... speed=... capturedAtMs=...
```

Indoors you will usually see `no usable fix: no fix`. That's correct: the app
never invents a position. Take it outside with a clear view of the sky.
