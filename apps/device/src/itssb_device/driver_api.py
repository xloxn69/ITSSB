"""Driver touchscreen routes on the local API (docs/04 §12, docs/05 §8).

Transport-free: `DriverApi.handle()` takes a method, path, headers, and body
and returns a `Response`, so every rule here is tested without sockets.
api.py does the HTTP plumbing and the loopback Host check.

Rules enforced here, not in the browser:
- protected reads need the kiosk session cookie; state changes also need
  this exact Origin, a JSON body, and the session's CSRF token (local_auth.py)
- route and recording actions need an unlocked driver
- anything that changes a draft needs the bus confirmed parked; recording
  itself keeps sampling while driving
- stop coordinates come from this device's own fresh fix, never the request
- submitting a draft for review queues it (draft_submit.py); it reads as
  submitted only after the server accepted it
- static files are served only from the built UI directory
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from zoneinfo import ZoneInfo

from .database import Database, GuardRefused, RunNotActive
from .draft_submit import DraftDesk
from .drafts import DraftError, Drafts
from .gps_reader import LatestFixHolder
from .local_auth import (
    CSRF_HEADER,
    SESSION_COOKIE,
    KioskSession,
    SessionManager,
    UnlockResult,
    check_protected_read,
    check_state_change,
    read_cookie,
)
from .models import Fix
from .motion import FIX_FRESH_S, MotionJudge
from .status import StatusBoard
from .students import StudentDesk
from .trips import HttpRunStarter, HttpTripEvents, StartRunRequest, end_run, start_run_online

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 16 * 1024

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'"
)
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".json": "application/json",
}

SERVER_WORDS = {
    "GRANT_NOT_AUTHORIZED": "The school server did not accept your driver authorization for this "
    "route. Ask your transport office.",
    "ACTIVE_RUN_CONFLICT": "The school server says this bus or route already has an active run.",
    "SERVICE_DATE_OUT_OF_RANGE": "This device's date does not match the school server.",
    "CLOCK_OUT_OF_RANGE": "This device's clock does not match the school server.",
    "UNAUTHENTICATED": "The school server did not accept this device's credential.",
    "REQUEST_ID_CONFLICT": "The school server saw this request before with different details.",
    "RUN_NOT_AUTHORIZED": "The school server does not recognize this run for this device.",
    "RUN_NOT_ACTIVE": "The school server says this run was already ended.",
}

NOT_YET = {
    "showQr": "QR codes come from the school server, and this device has none set up.",
    "showStudents": "The roster comes from the school server, and this device has none set up.",
    "submitRoute": "Route review is on the school server, and this device has none set up.",
}


@dataclass
class Response:
    status: int
    body: bytes = b""
    content_type: str = "application/json"
    headers: list[tuple[str, str]] = field(default_factory=list)


def _motion_unknown() -> Response:
    return _error(
        HTTPStatus.CONFLICT,
        "MOTION_UNKNOWN",
        "Unlock when the bus is stopped and GPS has a current fix.",
    )


def _json(status: int, payload: Any, headers: list[tuple[str, str]] | None = None) -> Response:
    return Response(
        status, json.dumps(payload, separators=(",", ":")).encode(), headers=headers or []
    )


def _error(status: int, code: str, message: str, **extra: Any) -> Response:
    return _json(status, {"error": code, "message": message, **extra})


_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_DRAFT = re.compile(rf"^/api/recordings/({_UUID})$")
_DRAFT_STOPS = re.compile(rf"^/api/recordings/({_UUID})/stops$")
_DRAFT_STOP = re.compile(rf"^/api/recordings/({_UUID})/stops/({_UUID})$")
_DRAFT_FINISH = re.compile(rf"^/api/recordings/({_UUID})/finish$")
_DRAFT_SUBMIT = re.compile(rf"^/api/recordings/({_UUID})/submit$")
_RUN_END = re.compile(r"^/api/runs/([A-Za-z0-9_-]{1,128})/end$")


class DriverApi:
    def __init__(
        self,
        board: StatusBoard,
        sessions: SessionManager,
        judge: MotionJudge,
        latest: LatestFixHolder,
        database_path: Path | str,
        static_dir: Path | None,
        origins: frozenset[str],
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        monotonic: Callable[[], float] = time.monotonic,
        trip_events: HttpTripEvents | None = None,
        service_timezone: str | None = None,
        students: StudentDesk | None = None,
        draft_desk: DraftDesk | None = None,
    ) -> None:
        # Submitting drafts for review (draft_submit.py); None without a server.
        self.draft_desk = draft_desk
        # QR codes, roster and driver actions (students.py); None without a server.
        self.students = students
        self.trip_events = trip_events
        self.service_timezone = service_timezone
        # One start at a time: choosing between "resend the saved request" and
        # "build a new one" must not interleave, or two requests with the same
        # requestId could carry different content.
        self._start_lock = threading.Lock()
        self.board = board
        self.sessions = sessions
        self.judge = judge
        self.latest = latest
        self.database_path = database_path
        self.static_dir = static_dir.resolve() if static_dir and static_dir.is_dir() else None
        self.origins = origins
        self.now_ms = now_ms
        self.mono = monotonic

    @property
    def serves_ui(self) -> bool:
        return self.static_dir is not None and (self.static_dir / "index.html").is_file()

    # ── Entry point ──────────────────────────────────────────────────

    def handle(self, method: str, path: str, headers: Mapping[str, str], body: bytes) -> Response:
        if not path.startswith("/api/"):
            if method != "GET":
                return _error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD", "Method not allowed.")
            return self._static(path, headers)
        session = self.sessions.get(read_cookie(headers.get("Cookie")))
        if method == "GET":
            refused = check_protected_read(headers)
            if refused:
                return _error(HTTPStatus.FORBIDDEN, "FORBIDDEN", refused)
            if path == "/api/session":
                return self._session_info(session)
            if session is None:
                return _error(HTTPStatus.UNAUTHORIZED, "NO_SESSION", "Reload the driver screen.")
            return self._get(path, session)
        if method != "POST":
            return _error(HTTPStatus.METHOD_NOT_ALLOWED, "METHOD", "Method not allowed.")
        refused = check_state_change(headers, self.origins)
        if refused:
            return _error(HTTPStatus.FORBIDDEN, "FORBIDDEN", refused)
        if session is None:
            return _error(HTTPStatus.UNAUTHORIZED, "NO_SESSION", "Reload the driver screen.")
        if not self.sessions.csrf_ok(session, headers.get(CSRF_HEADER)):
            return _error(HTTPStatus.FORBIDDEN, "CSRF", "Request token missing or wrong.")
        if len(body) > MAX_BODY_BYTES:
            return _error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "TOO_LARGE", "Request too large.")
        try:
            data = json.loads(body or b"{}")
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_JSON", "Body must be JSON.")
        if not isinstance(data, dict):
            return _error(HTTPStatus.BAD_REQUEST, "BAD_JSON", "Body must be a JSON object.")
        try:
            return self._post(path, session, data)
        except GuardRefused as exc:
            return _error(HTTPStatus.CONFLICT, exc.code, str(exc))
        except DraftError as exc:
            status = HTTPStatus.NOT_FOUND if exc.code == "NOT_FOUND" else HTTPStatus.CONFLICT
            if exc.code.startswith("BAD_"):
                status = HTTPStatus.BAD_REQUEST
            return _error(status, exc.code, str(exc))

    # ── Static UI ────────────────────────────────────────────────────

    def _static(self, path: str, headers: Mapping[str, str]) -> Response:
        if self.static_dir is None:
            return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Driver UI not installed.")
        rel = unquote(path.split("?", 1)[0]).lstrip("/") or "index.html"
        parts = rel.split("/")
        if any(p in ("", ".", "..") or p.startswith(".") or "\\" in p or "\0" in p for p in parts):
            return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")
        target = (self.static_dir / rel).resolve()
        if not target.is_relative_to(self.static_dir) or not target.is_file():
            return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")
        ctype = STATIC_TYPES.get(target.suffix.lower())
        if ctype is None:
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        extra = [("Content-Security-Policy", CSP)]
        # index.html carries the kiosk session. Reuse a live one so a reload
        # keeps the driver unlocked; otherwise start a new one.
        if (
            target.name == "index.html"
            and self.sessions.get(read_cookie(headers.get("Cookie"))) is None
        ):
            extra.append(("Set-Cookie", self._cookie(self.sessions.new_session())))
        return Response(HTTPStatus.OK, target.read_bytes(), ctype, extra)

    @staticmethod
    def _cookie(s: KioskSession) -> str:
        return f"{SESSION_COOKIE}={s.session_id}; Path=/; HttpOnly; SameSite=Strict"

    # ── Reads ────────────────────────────────────────────────────────

    def _session_info(self, session: KioskSession | None) -> Response:
        headers = []
        if session is None:
            session = self.sessions.new_session()
            headers.append(("Set-Cookie", self._cookie(session)))
        return _json(
            HTTPStatus.OK,
            {
                "csrfToken": session.csrf,
                "driver": self._driver_public(session),
                "routes": [
                    {"routeVersionId": r.route_version_id, "label": r.label}
                    for r in (session.driver.route_versions if session.driver else ())
                ],
                "drivers": [
                    {"driverId": d.driver_id, "displayName": d.display_name}
                    for d in self.sessions.drivers.values()
                ],
                "lockoutRemainingS": round(self.sessions.lockout_remaining_s()),
            },
            headers,
        )

    @staticmethod
    def _driver_public(session: KioskSession) -> dict[str, str] | None:
        d = session.driver
        return {"driverId": d.driver_id, "displayName": d.display_name} if d else None

    def status(self, session: KioskSession) -> dict[str, Any]:
        snap = self.board.snapshot()
        unlocked = session.driver is not None
        with self._db() as db:
            recording = Drafts(db).recording() if unlocked else None
            pending = db.pending_start()
            last_start = db.last_start_result()
            last_ended = db.last_ended_run()
            # The run and queue straight from SQLite: the board refreshes only
            # every publish interval, and a just-ended run must not read as active.
            run = db.active_run()
            outbox = db.outbox_counts()
            # Driver changes to students (students.py); names only when unlocked.
            changes = (
                self.students.summary(
                    db,
                    self.now_ms(),
                    {r.route_version_id for r in session.driver.route_versions},
                )
                if self.students is not None and session.driver is not None
                else None
            )
        snap.update(
            {
                "motion": self.judge.snapshot(),
                "session": {
                    "unlocked": unlocked,
                    "driverName": session.driver.display_name if session.driver else None,
                },
                "capabilities": {
                    "recordRoute": {"available": True},
                    "startRoute": self._start_capability(session),
                    "showQr": self._students_capability(session, run, "showQr"),
                    "showStudents": self._students_capability(session, run, "showStudents"),
                    "submitRoute": self.draft_desk.capability(session)
                    if self.draft_desk is not None
                    else {"available": False, "reason": NOT_YET["submitRoute"]},
                },
                # Only for an unlocked driver: route drafts are protected.
                "recording": recording,
                "runStart": {
                    "pending": pending is not None,
                    "routeVersionId": pending["payload"]["routeVersionId"] if pending else None,
                    "lastStatus": last_start["status"] if last_start else None,
                    "lastCode": last_start["code"] if last_start else None,
                },
                "lastEndedRun": last_ended,
                "run": run,
                "outbox": outbox,
                "studentChanges": changes,
            }
        )
        return snap

    def _students_capability(
        self, session: KioskSession, run: dict[str, Any] | None, kind: str
    ) -> dict[str, Any]:
        if self.students is None:
            return {"available": False, "reason": NOT_YET[kind]}
        return self.students.capability(session, run)

    def _start_capability(self, session: KioskSession) -> dict[str, Any]:
        def no(reason: str) -> dict[str, Any]:
            return {"available": False, "reason": reason}

        if self.trip_events is None:
            return no("This device has no school server set up, so it cannot start runs.")
        if self.service_timezone is None:
            return no("This device's service time zone is not set, so it cannot start runs.")
        d = session.driver
        if d is not None and not d.operating_grant:
            return no("Your transport office has not authorized you to start runs on this device.")
        if d is not None and not d.route_versions:
            return no("No approved routes are assigned to you on this device.")
        return {"available": True}

    def _get(self, path: str, session: KioskSession) -> Response:
        if path == "/api/status":
            return _json(HTTPStatus.OK, self.status(session))
        if session.driver is None:
            return _error(HTTPStatus.FORBIDDEN, "LOCKED", "Unlock with your driver PIN first.")
        if path == "/api/roster" and self.students is not None:
            # Never behind an unknown or moving bus (docs/05 §3).
            if not self.judge.parked():
                return _error(
                    HTTPStatus.CONFLICT, "NOT_PARKED", "Stop safely and confirm parked first."
                )
            return _json(*self.students.roster(session))
        with self._db() as db:
            drafts = Drafts(db)
            if path == "/api/recordings":
                return _json(HTTPStatus.OK, {"drafts": drafts.list()})
            m = _DRAFT.match(path)
            if m:
                try:
                    return _json(HTTPStatus.OK, drafts.detail(m.group(1)))
                except DraftError as exc:
                    return _error(HTTPStatus.NOT_FOUND, exc.code, str(exc))
        return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")

    # ── Writes ───────────────────────────────────────────────────────

    def _fresh_fix(self) -> Fix | None:
        lf = self.latest.get()
        if lf is None or self.mono() - lf.received_mono > FIX_FRESH_S:
            return None
        return lf.fix

    def _unlock_motion_ok(self) -> bool:
        """During a run, unknown motion (no fix, or a stale one) is not a stop:
        the bus may be moving. Before a run, unknown is allowed so a driver can
        unlock indoors without a fix."""
        state = self.judge.state()
        if state == "moving":
            return False
        if state == "stopped":
            return True
        with self._db() as db:
            return db.active_run_id() is None

    def _post(self, path: str, session: KioskSession, data: dict[str, Any]) -> Response:
        if path == "/api/session/unlock":
            if self.judge.state() == "moving":
                return _error(HTTPStatus.CONFLICT, "MOVING", "Unlock when the bus is stopped.")
            if not self._unlock_motion_ok():
                return _motion_unknown()
            # Checked again at the moment of granting: a run may have started
            # (from another page) while the PIN was being verified.
            result = self.sessions.unlock(
                session, data.get("driverId"), data.get("pin"), self._unlock_motion_ok
            )
            if result == UnlockResult.NOT_ALLOWED_NOW:
                return _motion_unknown()
            if result == UnlockResult.OK:
                return _json(HTTPStatus.OK, {"driver": self._driver_public(session)})
            if result == UnlockResult.BAD_INPUT:
                return _error(
                    HTTPStatus.BAD_REQUEST, "BAD_INPUT", "Choose a driver and enter the PIN."
                )
            wait = round(self.sessions.lockout_remaining_s())
            if result == UnlockResult.LOCKED_OUT or wait > 0:
                return _error(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "LOCKED_OUT",
                    f"Too many wrong PINs. Try again in {wait} s.",
                    lockoutRemainingS=wait,
                )
            # Same answer for an unknown driver and a wrong PIN.
            return _error(HTTPStatus.FORBIDDEN, "WRONG_PIN", "That PIN is not right.")
        if path == "/api/session/lock":
            self.sessions.lock(session)
            return _json(HTTPStatus.OK, {"driver": None})

        driver = session.driver
        if driver is None:
            return _error(HTTPStatus.FORBIDDEN, "LOCKED", "Unlock with your driver PIN first.")

        if path == "/api/motion/parked":
            if not self.judge.confirm_parked(self.now_ms()):
                return _error(
                    HTTPStatus.CONFLICT,
                    "NOT_STOPPED",
                    "The bus is not known to be stopped. Parked needs a current GPS fix "
                    "showing no movement.",
                    motion=self.judge.snapshot(),
                )
            return _json(HTTPStatus.OK, {"motion": self.judge.snapshot()})

        if path in ("/api/qr-codes", "/api/roster-actions") and self.students is not None:
            if not self.judge.parked():
                return _error(
                    HTTPStatus.CONFLICT, "NOT_PARKED", "Stop safely and confirm parked first."
                )
            if path == "/api/qr-codes":
                return _json(*self.students.qr(session, data))
            return _json(*self.students.action(session, data, guard=self._require_parked))

        if path == "/api/recordings/review-status":
            # A read from the server with the driver's grant; no draft changes.
            if self.draft_desk is None:
                return _error(HTTPStatus.CONFLICT, "NO_SERVER", NOT_YET["submitRoute"])
            with self._db() as db:
                refreshed = self.draft_desk.refresh(db, session)
                return _json(HTTPStatus.OK, {**refreshed, "drafts": Drafts(db).list()})

        if path == "/api/runs/start" or _RUN_END.match(path):
            if not self.judge.parked():
                return _error(
                    HTTPStatus.CONFLICT, "NOT_PARKED", "Stop safely and confirm parked first."
                )
            if path == "/api/runs/start":
                return self._start_run(session, data)
            m = _RUN_END.match(path)
            assert m is not None  # noqa: S101 - matched above
            return self._end_run(session, m.group(1), data)

        # Everything below edits a route draft: safely stopped only.
        if not self.judge.parked():
            return _error(
                HTTPStatus.CONFLICT, "NOT_PARKED", "Stop safely and confirm parked first."
            )

        with self._db() as db:
            # Parked again AFTER any wait for the SQLite writer: the bus may
            # have moved while this request was queued.
            db.write_guard = self._require_parked
            drafts = Drafts(db)
            if path == "/api/recordings":
                if db.active_run_id() is not None:
                    return _error(HTTPStatus.CONFLICT, "RUN_ACTIVE", "End the active run first.")
                if self._fresh_fix() is None:
                    return _error(
                        HTTPStatus.CONFLICT, "NO_FIX", "Recording needs a current GPS fix."
                    )
                summary = drafts.start(
                    data.get("requestId"),
                    data.get("name"),
                    data.get("direction"),
                    driver.driver_id,
                    self.now_ms(),
                )
                return _json(HTTPStatus.OK, summary)
            m = _DRAFT_STOPS.match(path)
            if m:
                fix = self._fresh_fix()
                if fix is None:
                    return _error(
                        HTTPStatus.CONFLICT, "NO_FIX", "Marking a stop needs a current GPS fix."
                    )
                stop = drafts.mark_stop(
                    m.group(1), data.get("requestId"), data.get("name"), fix, driver.driver_id
                )
                return _json(HTTPStatus.OK, stop)
            m = _DRAFT_STOP.match(path)
            if m:
                draft_id, stop_id = m.groups()
                if data.get("remove") is True:
                    drafts.remove_stop(draft_id, stop_id)
                elif "position" in data:
                    drafts.move_stop(draft_id, stop_id, data["position"])
                elif "name" in data:
                    drafts.rename_stop(draft_id, stop_id, data["name"])
                else:
                    return _error(HTTPStatus.BAD_REQUEST, "BAD_INPUT", "Nothing to change.")
                return _json(HTTPStatus.OK, {"stops": drafts.stops(draft_id)})
            m = _DRAFT_FINISH.match(path)
            if m:
                return _json(HTTPStatus.OK, drafts.finish(m.group(1), self.now_ms()))
            m = _DRAFT_SUBMIT.match(path)
            if m:
                if self.draft_desk is None:
                    return _error(HTTPStatus.CONFLICT, "NO_SERVER", NOT_YET["submitRoute"])
                code, body = self.draft_desk.submit(db, session, m.group(1), data)
                if code != HTTPStatus.OK:
                    return _json(code, body)
                return _json(HTTPStatus.OK, drafts.summary(m.group(1)))
        return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")

    def _require_parked(self) -> None:
        if not self.judge.parked():
            raise GuardRefused("NOT_PARKED", "The bus moved. Stop safely and confirm parked again.")

    # ── Runs ─────────────────────────────────────────────────────────

    def _start_run(self, session: KioskSession, data: dict[str, Any]) -> Response:
        with self._start_lock:
            return self._start_run_locked(session, data)

    def _start_run_locked(self, session: KioskSession, data: dict[str, Any]) -> Response:
        """Online start (docs/05 §5, docs/08 §6). The run exists only once the
        server answers `accepted` with its runId; nothing is invented here."""
        cap = self._start_capability(session)
        driver = session.driver
        if not cap["available"] or driver is None or not driver.operating_grant:
            return _error(
                HTTPStatus.CONFLICT, "START_UNAVAILABLE", cap.get("reason") or "Unavailable."
            )
        assert self.trip_events is not None and self.service_timezone is not None  # noqa: S101
        route = data.get("routeVersionId")
        if route not in {r.route_version_id for r in driver.route_versions}:
            return _error(
                HTTPStatus.BAD_REQUEST, "BAD_ROUTE", "Choose one of your approved routes."
            )
        now = self.now_ms()
        with self._db() as db:
            # A requestId the device has seen before is answered from its saved
            # outcome, never rebuilt with new content.
            seen = db.start_request(str(data.get("requestId")))
            if seen is not None and seen["status"] == "accepted":
                return _json(HTTPStatus.OK, {"status": "accepted", "runId": seen["runId"]})
            if seen is not None and seen["status"] == "rejected":
                code = seen["code"] or "REJECTED"
                words = SERVER_WORDS.get(code, f"The school server refused the start ({code}).")
                return _error(HTTPStatus.CONFLICT, code, words)
            if db.active_run_id() is not None:
                return _error(HTTPStatus.CONFLICT, "RUN_ACTIVE", "A run is already active.")
            if Drafts(db).recording() is not None:
                return _error(HTTPStatus.CONFLICT, "RECORDING", "Finish the route recording first.")
            pending = db.pending_start()
            if pending is not None:
                # An earlier start got no answer: resend exactly that request
                # (same requestId) instead of risking a second run.
                if pending["payload"]["routeVersionId"] != route:
                    return _error(
                        HTTPStatus.CONFLICT,
                        "START_PENDING",
                        "An earlier start for another route is still waiting for an answer.",
                    )
                request = StartRunRequest(
                    request_id=pending["requestId"],
                    route_version_id=pending["payload"]["routeVersionId"],
                    service_date=pending["payload"]["serviceDate"],
                    service_timezone=pending["payload"]["serviceTimezone"],
                    captured_at_ms=pending["payload"]["capturedAtMs"],
                    driver_operating_grant=pending["payload"]["driverOperatingGrant"],
                )
            else:
                try:
                    rid = str(uuid.UUID(str(data.get("requestId"))))
                except ValueError:
                    return _error(
                        HTTPStatus.BAD_REQUEST, "BAD_REQUEST_ID", "requestId must be a UUID."
                    )
                zone = ZoneInfo(self.service_timezone)
                request = StartRunRequest(
                    request_id=rid,
                    route_version_id=route,
                    service_date=datetime.fromtimestamp(now / 1000, zone).date().isoformat(),
                    service_timezone=self.service_timezone,
                    captured_at_ms=now,
                    driver_operating_grant=driver.operating_grant,
                )
            result = start_run_online(db, HttpRunStarter(self.trip_events), request, now)
        if result.status == "accepted":
            return _json(HTTPStatus.OK, {"status": "accepted", "runId": result.run_id})
        if result.status == "unknown":
            return _json(
                HTTPStatus.ACCEPTED,
                {
                    "status": "unknown",
                    "message": "No answer from the school server. No run has started on this "
                    "device. Tap Start again to resend the same request.",
                },
            )
        words = SERVER_WORDS.get(
            result.code or "", f"The school server refused the start ({result.code})."
        )
        return _error(HTTPStatus.CONFLICT, result.code or "REJECTED", words)

    def _end_run(self, session: KioskSession, run_id: str, data: dict[str, Any]) -> Response:
        driver = session.driver
        if driver is None or not driver.operating_grant:
            return _error(
                HTTPStatus.FORBIDDEN,
                "END_UNAVAILABLE",
                "Your transport office has not authorized you to end runs on this device.",
            )
        try:
            rid = str(uuid.UUID(str(data.get("requestId"))))
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_REQUEST_ID", "requestId must be a UUID.")
        with self._db() as db:
            try:
                payload, result = end_run(
                    db, self.trip_events, run_id, rid, driver.operating_grant, self.now_ms()
                )
            except RunNotActive:
                return _error(
                    HTTPStatus.CONFLICT, "RUN_NOT_ACTIVE", "That run is not active on this device."
                )
            summary = db.last_ended_run()
        sync = "pending" if result is None or result.status == "unknown" else result.status
        body: dict[str, Any] = {
            "completedLocally": True,
            "runId": payload["runId"],
            "endSync": sync,
            "summary": summary,
        }
        if result is not None and result.status == "rejected":
            body["message"] = SERVER_WORDS.get(
                result.code or "", f"The school server refused the end ({result.code})."
            )
        return _json(HTTPStatus.OK, body)

    def _db(self) -> _DbContext:
        return _DbContext(self.database_path)


class _DbContext:
    """One connection per request: the server runs a thread per request."""

    def __init__(self, path: Path | str) -> None:
        self.path = path

    def __enter__(self) -> Database:
        self.db = Database(self.path)
        return self.db

    def __exit__(self, *exc: object) -> None:
        self.db.close()
