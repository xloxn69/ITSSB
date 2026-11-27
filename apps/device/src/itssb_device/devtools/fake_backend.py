"""A local fake of `POST /device/v1/telemetry` and `/device/v1/trip-events`.

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

Trip events follow docs/08 §6: a known grant covering the route version
(`--grant GRANT:ROUTE_VERSION`), one active run, idempotent `requestId` per
content, and an end only for the run that was started. Modes `down` and
`drop_response` apply to them too.

QR codes, the roster and roster actions follow docs/08 §9.2 with FICTIONAL
students (`roster_students`, per route version). Roster actions keep a
receipt per `requestId` fingerprinted without the grant, like
apps/backend/convex/deviceRoster.ts, and every raw body is kept in
`action_bodies` so tests can check a retry resends the same bytes.
`reject_actions` forces a rejection code for every new action.

`GET /_stats` lists stored eventIds and every request's eventIds (test-only).
Binds to 127.0.0.1 only. Never use it as a real backend.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

GRANT_PATHS = ("/device/v1/qr-codes", "/device/v1/roster", "/device/v1/roster-actions")

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
        self.grants: dict[str, set[str]] = {}  # grant -> route version ids
        self.trip_requests: dict[
            str, tuple[str, dict[str, Any]]
        ] = {}  # requestId -> (body, result)
        self.runs: dict[str, dict[str, Any]] = {}
        self.qr_issued: list[dict[str, Any]] = []
        self.roster_students: dict[str, list[dict[str, Any]]] = {}  # route version -> students
        self.check_ins: dict[tuple[str, str], list[dict[str, Any]]] = {}  # (run, assignment)
        self.action_receipts: dict[str, tuple[str, dict[str, Any]]] = {}
        self.action_bodies: dict[str, list[bytes]] = {}
        self.removed: set[str] = set()
        self.reject_actions: str | None = None
        self.qr_ttl_ms = 600_000
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

    def trip_event(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """FICTIONAL run issuing, mirroring apps/backend/convex/tripEvents.ts rules."""
        now = int(time.time() * 1000)
        rid, kind = body.get("requestId"), body.get("type")
        content = json.dumps(body, sort_keys=True)

        def err(status: int, code: str) -> tuple[int, dict[str, Any]]:
            return status, {"schemaVersion": 1, "error": {"code": code, "message": code}}

        with self.lock:
            if rid in self.trip_requests:
                old, result = self.trip_requests[rid]
                return (200, result) if old == content else err(409, "REQUEST_ID_CONFLICT")
            routes = self.grants.get(body.get("driverOperatingGrant", ""))
            if routes is None:
                return err(403, "GRANT_NOT_AUTHORIZED")
            if kind == "startRun":
                if body.get("routeVersionId") not in routes:
                    return err(403, "GRANT_NOT_AUTHORIZED")
                if any(r["state"] == "active" for r in self.runs.values()):
                    return err(409, "ACTIVE_RUN_CONFLICT")
                run_id = f"demo_run_{len(self.runs) + 1:03d}"
                self.runs[run_id] = {
                    "state": "active",
                    "startedAtMs": now,
                    "route": body["routeVersionId"],
                }
            elif kind == "endRun":
                run_id = body.get("runId", "")
                run = self.runs.get(run_id)
                if run is None or run["route"] not in routes:
                    return err(403, "RUN_NOT_AUTHORIZED")
                if run["state"] != "active":
                    return err(409, "RUN_NOT_ACTIVE")
                run["state"], run["endedAtMs"] = "completed", now
            else:
                return err(400, "INVALID_REQUEST")
            run = self.runs[run_id]
            result = {
                "schemaVersion": 1,
                "requestId": rid,
                "status": "accepted",
                "runId": run_id,
                "state": run["state"],
                "startedAtMs": run["startedAtMs"],
                "endedAtMs": run.get("endedAtMs"),
                "serverNowMs": now,
            }
            self.trip_requests[rid] = (content, result)
            return 200, result

    # ── docs/08 §9.2 (FICTIONAL) ─────────────────────────────────────

    def _route_of(self, run_id: Any) -> str | None:
        run = self.runs.get(run_id) if isinstance(run_id, str) else None
        return run["route"] if run else None

    def qr_code(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        now = int(time.time() * 1000)
        with self.lock:
            routes = self.grants.get(body.get("driverOperatingGrant", ""))
            if routes is None:
                return _err(403, "GRANT_NOT_AUTHORIZED")
            purpose = body.get("purpose")
            if purpose == "trip_check_in":
                route = self._route_of(body.get("runId"))
                if route is None or route not in routes:
                    return _err(403, "RUN_NOT_AUTHORIZED")
                if self.runs[body["runId"]]["state"] != "active":
                    return _err(403, "RUN_NOT_AUTHORIZED")
                ttl, path = self.qr_ttl_ms, "/checkin"
            elif purpose == "route_enrollment":
                if body.get("routeVersionId") not in routes:
                    return _err(403, "GRANT_NOT_AUTHORIZED")
                ttl, path = 86_400_000, "/join"
            else:
                return _err(400, "INVALID_REQUEST")
            n = len(self.qr_issued) + 1
            token = f"FAKE{n:04d}" + "X" * 12  # 20 characters, FICTIONAL
            self.qr_issued.append({"purpose": purpose, "token": token})
            return 200, {
                "schemaVersion": 1,
                "purpose": purpose,
                "token": token,
                "linkPath": path,
                "expiresAtMs": now + ttl,
                "serverNowMs": now,
            }

    def _current(self, run_id: str, assignment_id: str) -> dict[str, Any] | None:
        rows = self.check_ins.get((run_id, assignment_id), [])
        return rows[-1] if rows else None

    def roster(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        now = int(time.time() * 1000)
        with self.lock:
            routes = self.grants.get(body.get("driverOperatingGrant", ""))
            if routes is None:
                return _err(403, "GRANT_NOT_AUTHORIZED")
            run_id = body.get("runId")
            route = self._route_of(run_id)
            if route is None or route not in routes:
                return _err(403, "RUN_NOT_AUTHORIZED")
            students = [
                {**s, "checkIn": self._current(run_id, s["assignmentId"])}
                for s in self.roster_students.get(route, [])
                if s["assignmentId"] not in self.removed
            ]
            students.sort(key=lambda s: (s["stopSequence"], s["studentDisplayName"]))
            return 200, {
                "schemaVersion": 1,
                "runId": run_id,
                "routeVersionId": route,
                "students": students,
                "serverNowMs": now,
            }

    def roster_action(self, raw: bytes, body: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time() * 1000)
        rid = str(body.get("requestId"))
        content = {k: v for k, v in body.items() if k != "driverOperatingGrant"}
        fingerprint = json.dumps(content, sort_keys=True)

        def result(status: str, check_in: Any = None, **extra: Any) -> dict[str, Any]:
            r = {"schemaVersion": 1, "requestId": rid, "status": status, "serverNowMs": now}
            r.update({"checkIn": check_in} if status != "rejected" else extra)
            return r

        with self.lock:
            self.action_bodies.setdefault(rid, []).append(raw)
            if rid in self.action_receipts:
                old, stored = self.action_receipts[rid]
                if old != fingerprint:
                    return result("rejected", code="request_id_conflict", message="conflict")
                return stored
            out = self._decide(body, result, now)
            self.action_receipts[rid] = (fingerprint, out)
            return out

    def _decide(self, body: dict[str, Any], result: Callable[..., dict], now: int) -> dict:
        if self.reject_actions:
            return result("rejected", code=self.reject_actions, message=self.reject_actions)
        routes = self.grants.get(body.get("driverOperatingGrant", ""))
        if routes is None:
            return result("rejected", code="grant_not_authorized", message="grant")
        aid = body.get("assignmentId")
        known = {s["assignmentId"] for r in routes for s in self.roster_students.get(r, [])}
        if aid not in known:
            return result("rejected", code="assignment_not_authorized", message="assignment")
        kind = body.get("type")
        if kind == "removeAssignment":
            if aid in self.removed:
                return result("rejected", code="already_removed", message="removed")
            self.removed.add(aid)
            return result("accepted")
        if kind == "setSeatNote":
            return result("accepted")
        run_id = body.get("runId")
        if self._route_of(run_id) not in routes:
            return result("rejected", code="run_not_authorized", message="run")
        rows = self.check_ins.setdefault((run_id, aid), [])
        n = sum(len(v) for v in self.check_ins.values()) + 1
        row = {
            "checkInId": f"fake_check_in_{n:03d}",
            "status": body.get("status"),
            "source": "staff_recorded",
            "recordedAtMs": body.get("capturedAtMs"),
            "receivedAtMs": now,
        }
        if kind == "recordAttendance":
            if rows:
                return result("already_recorded", rows[0])
            rows.append(row)
            return result("accepted", row)
        if not rows or rows[-1]["checkInId"] != body.get("correctsCheckInId"):
            return result("rejected", code="correction_target_invalid", message="target")
        row["source"] = "staff_correction"
        rows.append(row)
        return result("accepted", row)


def _err(status: int, code: str) -> tuple[int, dict[str, Any]]:
    return status, {"schemaVersion": 1, "error": {"code": code, "message": code}}


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

    def do_GET(self) -> None:
        # Test-only inspection: which eventIds were sent, in which requests.
        if self.path != "/_stats":
            self._error(404, "NOT_FOUND")
            return
        with self.server.lock:
            body = {"events": sorted(self.server.events), "requests": list(self.server.requests)}
        self._json(200, body)

    def _grant_request(self, raw: bytes) -> None:
        srv = self.server
        if srv.mode == "down":
            self._error(503, "TEMPORARILY_UNAVAILABLE")
            return
        try:
            body = json.loads(raw)
            assert isinstance(body, dict)  # noqa: S101
        except (ValueError, AssertionError):
            self._error(400, "MALFORMED_JSON")
            return
        if self.path == "/device/v1/qr-codes":
            status, result = srv.qr_code(body)
        elif self.path == "/device/v1/roster":
            status, result = srv.roster(body)
        else:
            status, result = 200, srv.roster_action(raw, body)
        if srv.mode == "drop_response":
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.shutdown(2)
            return
        self._json(status, result)

    def do_POST(self) -> None:
        srv = self.server
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        if self.path not in ("/device/v1/telemetry", "/device/v1/trip-events", *GRANT_PATHS):
            self._error(404, "NOT_FOUND")
            return
        if self.headers.get("Authorization") != f"Bearer {srv.token}" or srv.mode == "unauthorized":
            self._error(401, "UNAUTHENTICATED")
            return
        if self.path in GRANT_PATHS:
            self._grant_request(raw)
            return
        if self.path == "/device/v1/trip-events":
            if srv.mode == "down":
                self._error(503, "TEMPORARILY_UNAVAILABLE")
                return
            try:
                body = json.loads(raw)
                assert isinstance(body, dict)  # noqa: S101
            except (ValueError, AssertionError):
                self._error(400, "MALFORMED_JSON")
                return
            status, result = srv.trip_event(body)
            if srv.mode == "drop_response":
                self.close_connection = True
                with contextlib.suppress(OSError):
                    self.connection.shutdown(2)
                return
            self._json(status, result)
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
    parser.add_argument(
        "--grant", action="append", default=[], help="FICTIONAL GRANT:ROUTE_VERSION (repeatable)"
    )
    args = parser.parse_args(argv)
    server = FakeBackend(args.port, args.token, args.mode)
    for g in args.grant:
        grant, _, route = g.partition(":")
        server.grants.setdefault(grant, set()).add(route)
    print(f"fake backend ({args.mode}) on {server.origin}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
