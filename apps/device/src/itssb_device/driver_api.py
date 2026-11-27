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
- static files are served only from the built UI directory
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .database import Database
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

NOT_YET = {
    "startRoute": "Starting a run needs the school server's trip service on this device.",
    "showQr": "QR codes need the school server's QR service, which is not available yet.",
    "showStudents": "The roster comes from the school server, which does not provide it yet.",
}


@dataclass
class Response:
    status: int
    body: bytes = b""
    content_type: str = "application/json"
    headers: list[tuple[str, str]] = field(default_factory=list)


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
    ) -> None:
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
        snap.update(
            {
                "motion": self.judge.snapshot(),
                "session": {
                    "unlocked": unlocked,
                    "driverName": session.driver.display_name if session.driver else None,
                },
                "capabilities": {
                    "recordRoute": {"available": True},
                    "startRoute": {"available": False, "reason": NOT_YET["startRoute"]},
                    "showQr": {"available": False, "reason": NOT_YET["showQr"]},
                    "showStudents": {"available": False, "reason": NOT_YET["showStudents"]},
                },
                # Only for an unlocked driver: route drafts are protected.
                "recording": recording,
            }
        )
        return snap

    def _get(self, path: str, session: KioskSession) -> Response:
        if path == "/api/status":
            return _json(HTTPStatus.OK, self.status(session))
        if session.driver is None:
            return _error(HTTPStatus.FORBIDDEN, "LOCKED", "Unlock with your driver PIN first.")
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

    def _post(self, path: str, session: KioskSession, data: dict[str, Any]) -> Response:
        if path == "/api/session/unlock":
            if self.judge.state() == "moving":
                return _error(HTTPStatus.CONFLICT, "MOVING", "Unlock when the bus is stopped.")
            result = self.sessions.unlock(session, data.get("driverId"), data.get("pin"))
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

        # Everything below edits a route draft: safely stopped only.
        if not self.judge.parked():
            return _error(
                HTTPStatus.CONFLICT, "NOT_PARKED", "Stop safely and confirm parked first."
            )

        with self._db() as db:
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
        return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "Not found.")

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
