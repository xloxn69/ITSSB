"""A local fake of the device endpoints (`POST /device/v1/telemetry`, `/trip-events`, …).

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

Route drafts follow docs/08 §7.1: a known grant, one stored draft per
`deviceDraftId` and content (a resend returns `already_submitted`, other
content is a conflict), always stored `submitted`. `decide_draft()` stands in
for staff approval or rejection; every raw submit body is kept in
`draft_bodies`.

Health (`POST /device/v1/health`, docs/08 §7) is answered `accepted`, with
the named run's `run` state when it is one this fake started.
`cancel_run()` stands in for staff cancelling a run in the console
(apps/backend/convex/runOps.ts): its positions are then rejected
`RUN_CANCELLED` and health reports for it carry `state: "cancelled"`.

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

GRANT_PATHS = (
    "/device/v1/qr-codes",
    "/device/v1/roster",
    "/device/v1/roster-actions",
    "/device/v1/route-drafts",
    "/device/v1/route-drafts/status",
)

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
        self.action_log: list[str] = []  # requestIds in the order they arrived
        self.removed: set[str] = set()
        self.reject_actions: str | None = None
        self.qr_ttl_ms = 600_000
        # Route drafts (docs/08 §7.1): server draft id -> stored draft.
        self.route_drafts: dict[str, dict[str, Any]] = {}
        self.draft_bodies: list[bytes] = []  # every submit body that arrived
        self.health_reports: list[dict[str, Any]] = []
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
                run = self.runs.get(e.get("runId", ""))
                if old is None and run is not None and run["state"] == "cancelled":
                    results.append(
                        {
                            "eventId": eid,
                            "status": "rejected",
                            "code": "RUN_CANCELLED",
                            "message": "The school cancelled this run.",
                            "runState": "cancelled",
                            "cancelledAtMs": run["cancelledAtMs"],
                        }
                    )
                elif old is None:
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

    def cancel_run(self, run_id: str) -> int:
        """Staff cancel (or replace the bus on) an active run. Returns cancelledAtMs."""
        now = int(time.time() * 1000)
        with self.lock:
            run = self.runs[run_id]
            assert run["state"] == "active"  # noqa: S101 - test helper
            run["state"], run["endedAtMs"], run["cancelledAtMs"] = "cancelled", now, now
        return now

    def health(self, body: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time() * 1000)
        with self.lock:
            self.health_reports.append(body)
            answer: dict[str, Any] = {
                "schemaVersion": 1,
                "status": "accepted",
                "receivedAtMs": now,
                "serverNowMs": now,
            }
            run_id = body.get("runId") or body.get("unconfirmedEndRunId")
            run = self.runs.get(run_id) if isinstance(run_id, str) else None
            if run is not None:
                answer["run"] = {
                    "runId": run_id,
                    "state": run["state"],
                    "cancelledAtMs": run.get("cancelledAtMs"),
                }
            return answer

    def trip_event(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """FICTIONAL run issuing, mirroring apps/backend/convex/tripEvents.ts rules."""
        now = int(time.time() * 1000)
        rid, kind = body.get("requestId"), body.get("type")
        content = json.dumps(body, sort_keys=True)

        def err(status: int, code: str, **extra: Any) -> tuple[int, dict[str, Any]]:
            return status, {"schemaVersion": 1, "error": {"code": code, "message": code, **extra}}

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
                if run["state"] == "cancelled":
                    return err(
                        409,
                        "RUN_NOT_ACTIVE",
                        runState="cancelled",
                        cancelledAtMs=run["cancelledAtMs"],
                    )
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

    def roster_action(self, body: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time() * 1000)
        rid = str(body.get("requestId"))
        content = {k: v for k, v in body.items() if k != "driverOperatingGrant"}
        fingerprint = json.dumps(content, sort_keys=True)

        def result(status: str, check_in: Any = None, **extra: Any) -> dict[str, Any]:
            r = {"schemaVersion": 1, "requestId": rid, "status": status, "serverNowMs": now}
            r.update({"checkIn": check_in} if status != "rejected" else extra)
            return r

        with self.lock:
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

    def route_draft(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Stores a submitted draft as `submitted`; never approves it."""
        now = int(time.time() * 1000)
        rid = str(body.get("requestId"))
        content = {
            k: v
            for k, v in body.items()
            if k not in ("driverOperatingGrant", "requestId", "capturedAtMs")
        }
        fingerprint = json.dumps(content, sort_keys=True)

        def reject(code: str) -> tuple[int, dict[str, Any]]:
            return 200, {
                "schemaVersion": 1,
                "requestId": rid,
                "status": "rejected",
                "code": code,
                "message": code,
                "serverNowMs": now,
            }

        def ok(status: str, d: dict[str, Any]) -> tuple[int, dict[str, Any]]:
            return 200, {
                "schemaVersion": 1,
                "requestId": rid,
                "status": status,
                "draft": self._review(d),
                "serverNowMs": now,
            }

        if len(body.get("path", [])) > 2000:
            return _err(413, "TOO_MANY_POINTS")
        with self.lock:
            if body.get("driverOperatingGrant") not in self.grants:
                return reject("grant_not_authorized")
            for d in self.route_drafts.values():
                if rid in d["requestIds"] and d["fingerprint"] != fingerprint:
                    return reject("request_id_conflict")
                if d["deviceDraftId"] == body.get("deviceDraftId"):
                    if d["fingerprint"] != fingerprint:
                        return reject("draft_conflict")
                    d["requestIds"].add(rid)
                    return ok("already_submitted", d)
            draft_id = f"fake_draft_{len(self.route_drafts) + 1:03d}"
            d = {
                "draftId": draft_id,
                "deviceDraftId": body.get("deviceDraftId"),
                "fingerprint": fingerprint,
                "requestIds": {rid},
                "body": body,
                "status": "submitted",
                "submittedAtMs": now,
                "reviewedAtMs": None,
                "decisionReason": None,
                "routeVersionId": None,
            }
            self.route_drafts[draft_id] = d
            return ok("accepted", d)

    @staticmethod
    def _review(d: dict[str, Any]) -> dict[str, Any]:
        keys = ("draftId", "deviceDraftId", "status", "submittedAtMs", "reviewedAtMs")
        return {
            **{k: d[k] for k in keys},
            "decisionReason": d["decisionReason"],
            "routeVersionId": d["routeVersionId"],
        }

    def decide_draft(self, draft_id: str, status: str, reason: str | None = None) -> None:
        """Test hook: staff approve or reject a draft."""
        with self.lock:
            d = self.route_drafts[draft_id]
            d.update(status=status, reviewedAtMs=int(time.time() * 1000), decisionReason=reason)
            if status == "approved":
                d["routeVersionId"] = f"fake_version_for_{draft_id}"

    def route_draft_status(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        with self.lock:
            if body.get("driverOperatingGrant") not in self.grants:
                return _err(403, "GRANT_NOT_AUTHORIZED")
            drafts = [
                self._review(self.route_drafts[i])
                if i in self.route_drafts
                else {"draftId": i, "status": "not_found"}
                for i in body.get("draftIds", [])
            ]
        return 200, {"schemaVersion": 1, "drafts": drafts, "serverNowMs": int(time.time() * 1000)}


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
        if self.path == "/device/v1/roster-actions":
            # Every body that reached the server, even one it then failed on.
            with srv.lock:
                try:
                    rid = str(json.loads(raw).get("requestId"))
                except (ValueError, AttributeError):
                    rid = ""
                srv.action_bodies.setdefault(rid, []).append(raw)
                srv.action_log.append(rid)
        if self.path == "/device/v1/route-drafts":
            with srv.lock:
                srv.draft_bodies.append(raw)
        if srv.mode == "down":
            self._error(503, "TEMPORARILY_UNAVAILABLE")
            return
        if srv.mode == "rate_limited":
            self._error(429, "RATE_LIMITED", {"Retry-After": "1"})
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
        elif self.path == "/device/v1/route-drafts":
            status, result = srv.route_draft(body)
        elif self.path == "/device/v1/route-drafts/status":
            status, result = srv.route_draft_status(body)
        else:
            status, result = 200, srv.roster_action(body)
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
        if self.path not in (
            "/device/v1/telemetry",
            "/device/v1/trip-events",
            "/device/v1/health",
            *GRANT_PATHS,
        ):
            self._error(404, "NOT_FOUND")
            return
        if self.headers.get("Authorization") != f"Bearer {srv.token}" or srv.mode == "unauthorized":
            self._error(401, "UNAUTHENTICATED")
            return
        if self.path in GRANT_PATHS:
            self._grant_request(raw)
            return
        if self.path == "/device/v1/health":
            if srv.mode == "down":
                self._error(503, "TEMPORARILY_UNAVAILABLE")
                return
            try:
                body = json.loads(raw)
                assert isinstance(body, dict)  # noqa: S101
            except (ValueError, AssertionError):
                self._error(400, "MALFORMED_JSON")
                return
            self._json(200, srv.health(body))
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
