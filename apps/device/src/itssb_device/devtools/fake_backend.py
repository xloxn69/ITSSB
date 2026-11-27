"""A local fake of `POST /device/v1/telemetry` for tests and bench demos.

    python -m itssb_device.devtools.fake_backend --port 8790 --token fake-dev-token

It mirrors the real backend's per-event rules (apps/backend/convex/telemetry.ts):
same eventId + same content -> `duplicate`; same eventId + different
content -> `rejected EVENT_CONTENT_CONFLICT`. Behaviour can be switched at
runtime (`mode`) to simulate outages:

- `ok`              normal per-event results
- `down`            HTTP 503 for everything
- `drop_response`   commit the batch, then close the socket without answering
                    (a lost response: the device must retry the same eventIds)
- `partial`         answer only for every other event (the rest stay pending)
- `unauthorized`    HTTP 401
- `rate_limited`    HTTP 429 with Retry-After: 1
- `too_large`       HTTP 413 for batches over 1 event

Binds to 127.0.0.1 only. Never use it as a real backend.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

IDENTITY_FIELDS = (
    "bootId",
    "sequence",
    "runSequence",
    "runId",
    "capturedAtMs",
    "latitude",
    "longitude",
)


class FakeBackend(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int = 0, token: str = "fake-dev-token", mode: str = "ok") -> None:  # noqa: S107
        self.token, self.mode = token, mode
        self.lock = threading.Lock()
        self.events: dict[str, dict[str, Any]] = {}
        self.received_at: dict[str, int] = {}
        self.requests: list[dict[str, Any]] = []  # {"status", "eventIds"} per request
        super().__init__(("127.0.0.1", port), _Handler)

    @property
    def port(self) -> int:
        return self.server_address[1]

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> FakeBackend:
        threading.Thread(target=self.serve_forever, name="fake-backend", daemon=True).start()
        return self

    def stop(self) -> None:
        self.shutdown()
        self.server_close()

    def ingest(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = int(time.time() * 1000)
        results = []
        with self.lock:
            for e in events:
                eid = e.get("eventId", "")
                old = self.events.get(eid)
                if old is None:
                    self.events[eid] = e
                    self.received_at[eid] = now
                    results.append(
                        {
                            "eventId": eid,
                            "status": "accepted",
                            "receivedAtMs": now,
                            "liveStateApplied": True,
                        }
                    )
                elif all(old.get(k) == e.get(k) for k in IDENTITY_FIELDS):
                    results.append(
                        {
                            "eventId": eid,
                            "status": "duplicate",
                            "receivedAtMs": self.received_at[eid],
                            "liveStateApplied": False,
                        }
                    )
                else:
                    results.append(
                        {
                            "eventId": eid,
                            "status": "rejected",
                            "code": "EVENT_CONTENT_CONFLICT",
                            "message": "This eventId was already used for different content.",
                        }
                    )
        return results


class _Handler(BaseHTTPRequestHandler):
    server: FakeBackend
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # stdlib signature
        return

    def _json(self, status: int, body: Any, extra: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, code: str, extra: dict[str, str] | None = None) -> None:
        retryable = status in (429, 503)
        self._json(
            status,
            {"schemaVersion": 1, "error": {"code": code, "message": code, "retryable": retryable}},
            extra,
        )

    def do_POST(self) -> None:
        srv = self.server
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        if self.path != "/device/v1/telemetry":
            self._error(404, "NOT_FOUND")
            return
        if self.headers.get("Authorization") != f"Bearer {srv.token}" or srv.mode == "unauthorized":
            self._error(401, "UNAUTHENTICATED")
            return
        try:
            body = json.loads(raw)
            events = body["events"]
            assert body["schemaVersion"] == 1 and isinstance(events, list)  # noqa: S101
        except (ValueError, KeyError, TypeError, AssertionError):
            self._error(400, "INVALID_ENVELOPE")
            return
        ids = [e.get("eventId") for e in events]
        mode = srv.mode
        with srv.lock:
            srv.requests.append({"mode": mode, "eventIds": ids})
        if mode == "down":
            self._error(503, "TEMPORARILY_UNAVAILABLE")
        elif mode == "rate_limited":
            self._error(429, "RATE_LIMITED", {"Retry-After": "1"})
        elif mode == "too_large" and len(events) > 1:
            self._error(413, "TOO_MANY_EVENTS")
        elif mode == "drop_response":
            srv.ingest(events)
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.shutdown(2)
        else:
            results = srv.ingest(events)
            if mode == "partial":
                results = results[::2]
            self._json(
                200,
                {"schemaVersion": 1, "serverNowMs": int(time.time() * 1000), "results": results},
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fake_backend", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--token", default="fake-dev-token")
    parser.add_argument("--mode", default="ok")
    args = parser.parse_args(argv)
    server = FakeBackend(args.port, args.token, args.mode)
    print(f"fake backend ({args.mode}) on {server.origin}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
