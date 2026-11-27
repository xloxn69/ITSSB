"""Students on the driver screen: QR codes, the roster, and queued driver
actions (docs/08 §9.2, docs/09 §6-§9, docs/05 D15-D19).

Rules enforced here (driver_api.py adds the session, unlock and parked checks):

- Everything belongs to the device's active run and the unlocked driver's
  operating grant. The grant goes to the backend in a request body only; it
  is never returned to the browser, put in a URL, or logged.
- QR codes are issued by the backend, cached in memory per purpose for the
  active run, reused until shortly before they expire, then refreshed. An
  expired code is never returned, and a refused one is dropped at once. If
  the backend can't be reached, only an unexpired cached code is shown;
  nothing is minted here.
- The last good roster for the active run is kept in SQLite with its fetch
  time and served marked stale when the backend can't be reached. A refusal
  (401/403) deletes it: known revocation clears restricted content.
- A driver action is validated with the backend's own limits, then saved in
  SQLite with a `requestId` (from the screen, generated once) and its capture
  time, as the exact wire body, BEFORE anything is sent. `RosterSyncThread`
  sends it and resends the same bytes after a network failure, a 5xx, a 429
  or a 401, until the backend answers. `accepted`, `already_recorded` and
  `superseded` mark it synced; `rejected` (or a request-level 4xx) marks it
  rejected with its code, and it stays visible. A queued removal is never
  reported as done.

The tables live here, created with IF NOT EXISTS on every connection, and
leave database.py's numbered migrations alone.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Any, Literal

from .database import Database
from .local_auth import KioskSession
from .roster_contracts import FINAL_SUCCESS, QrCode, Roster, RosterAction, RosterActionResult
from .uploader import HttpTransport, TransportError

log = logging.getLogger(__name__)

QR_PATH = "/device/v1/qr-codes"
ROSTER_PATH = "/device/v1/roster"
ACTIONS_PATH = "/device/v1/roster-actions"

# A code is replaced this long before it expires, so a student never scans
# one that dies mid-scan. Replacing a check-in code revokes the old one.
QR_REFRESH_BEFORE_MS = 120_000
# A roster fetched this recently is reused instead of asking the server again.
ROSTER_REUSE_MS = 5_000
RESOLVED_KEEP_MS = 7 * 24 * 3600 * 1000
# A rejection stays on the roster this long, across runs.
REJECTED_SHOWN_MS = 24 * 3600 * 1000
BACKOFF_MAX_MS = 60_000

# Limits from packages/contracts/src/checkIns.ts (validateRosterAction).
MAX_SEAT_LABEL_LENGTH = 12
MAX_TEXT_LENGTH = 200
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

PURPOSES = {"trip_check_in": "Check in for this trip", "route_enrollment": "Join this route"}
ACTION_TYPES = ("recordAttendance", "correctAttendance", "setSeatNote", "removeAssignment")
ATTENDANCE = ("boarded", "not_boarded")

SCHEMA = """
CREATE TABLE IF NOT EXISTS roster_actions (
    request_id TEXT PRIMARY KEY,
    run_id TEXT,
    assignment_id TEXT NOT NULL,
    student_display_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN
        ('recordAttendance','correctAttendance','setSeatNote','removeAssignment')),
    intent TEXT NOT NULL,
    payload TEXT NOT NULL,
    sync TEXT NOT NULL DEFAULT 'pending' CHECK (sync IN ('pending','synced','rejected')),
    result TEXT,
    code TEXT,
    message TEXT,
    check_in TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    captured_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS roster_actions_pending ON roster_actions(sync, next_attempt_at_ms);
CREATE TABLE IF NOT EXISTS roster_cache (
    run_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    fetched_at_ms INTEGER NOT NULL
);
"""

# What a rejection means, in words a driver can act on.
PROBLEM_WORDS = {
    "grant_not_authorized": "Your driver authorization had ended or was withdrawn before this "
    "reached the school server. Ask staff to record it.",
    "assignment_not_authorized": "This student is not on a route you may manage now.",
    "run_not_authorized": "This does not match a trip this bus ran.",
    "already_removed": "This student was already removed from the route.",
    "correction_target_invalid": "The record to correct changed. Reload the roster and try again.",
    "capture_time_out_of_range": "It waited too long to sync, or this device's clock is wrong. "
    "Ask staff to record it.",
    "request_id_conflict": "The school server saw this change before with different details.",
}
SERVER_REFUSAL_WORDS = {
    "GRANT_NOT_AUTHORIZED": "The school server did not accept your driver authorization. "
    "Ask your transport office.",
    "RUN_NOT_AUTHORIZED": "The school server does not recognize this run for this device.",
    "UNAUTHENTICATED": "The school server did not accept this device's credential.",
}
QR_FALLBACK = {
    "trip_check_in": "No current code from the school server, so none is shown. "
    "Record attendance in Show Students instead.",
    "route_enrollment": "No current code from the school server, so none is shown. "
    "Families can ask school staff to add them instead.",
}


def ensure_schema(db: Database) -> None:
    with db.transaction() as tx:
        for statement in filter(str.strip, SCHEMA.split(";")):
            tx.execute(statement)


def _dumps(payload: Any) -> str:
    return json.dumps(payload, separators=(",", ":"))


# ── Backend client ───────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class GrantReply:
    """ok: 200 with a JSON object. refused: the server said no (4xx except 429).
    unknown: no usable answer (network, 5xx, 429); the outcome may be unknown."""

    kind: Literal["ok", "refused", "unknown"]
    http_status: int | None
    data: dict[str, Any]
    code: str | None
    # False only when the request certainly never reached the server (no
    # connection, or a 429). An unknown reply may still have been applied.
    maybe_applied: bool = True


class DeviceGrantClient:
    """Posts driver-grant requests with the device credential."""

    def __init__(self, transport: HttpTransport, token: str) -> None:
        self.transport = transport
        self._token = token
        self._lock = threading.Lock()  # one connection, several callers

    def post(self, path: str, body: bytes) -> GrantReply:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
        }
        try:
            with self._lock:
                resp = self.transport.post(path, body, headers)
        except TransportError as exc:
            # "no_response": connected and possibly sent; anything else failed
            # before the request went out.
            return GrantReply("unknown", None, {}, exc.reason, exc.backend == "no_response")
        try:
            data = json.loads(resp.body)
        except ValueError:
            data = None
        if not isinstance(data, dict):
            data = {}
        if resp.status == 200:
            if not data:
                return GrantReply("unknown", 200, {}, "BAD_RESPONSE")
            return GrantReply("ok", 200, data, None)
        err = data.get("error")
        code = err.get("code") if isinstance(err, dict) else None
        code = code if isinstance(code, str) else f"HTTP_{resp.status}"
        if resp.status >= 500 or resp.status == 429:
            return GrantReply("unknown", resp.status, data, code, resp.status != 429)
        return GrantReply("refused", resp.status, data, code)


# ── Local API side ───────────────────────────────────────────────────


@dataclass(slots=True)
class _CachedQr:
    code: QrCode
    run_id: str
    driver_id: str
    route_version_id: str | None
    fetched_at_ms: int
    lifetime_ms: int

    def remaining_ms(self, now_ms: int) -> int:
        # Measured on this device's monotonic clock from the server's own
        # lifetime, so neither clock skew nor a wall-clock step stretches it.
        return max(0, self.lifetime_ms - max(0, now_ms - self.fetched_at_ms))


class ActionInputError(ValueError):
    pass


def _text(value: object, limit: int, *, required: bool) -> str | None:
    """Trimmed text, or None for blank. The backend rejects "" on the wire."""
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ActionInputError("A reason is required.")
        return None
    if not isinstance(value, str):
        raise ActionInputError("Text expected.")
    text = value.strip()
    if len(text) > limit:
        raise ActionInputError(f"Keep it to {limit} characters.")
    return text


def _intent(data: dict[str, Any]) -> dict[str, Any]:
    """The driver's choice, normalized: what a retried requestId must repeat."""
    kind = data.get("type")
    if kind not in ACTION_TYPES:
        raise ActionInputError("Unknown change.")
    assignment = data.get("assignmentId")
    if not isinstance(assignment, str) or not _ID.match(assignment):
        raise ActionInputError("Choose a student.")
    intent: dict[str, Any] = {"type": kind, "assignmentId": assignment}
    if kind in ("recordAttendance", "correctAttendance"):
        if data.get("status") not in ATTENDANCE:
            raise ActionInputError("Choose boarded or not boarded.")
        intent["status"] = data["status"]
    if kind in ("correctAttendance", "removeAssignment"):
        intent["reason"] = _text(data.get("reason"), MAX_TEXT_LENGTH, required=True)
    if kind == "setSeatNote":
        intent["seatLabel"] = _text(data.get("seatLabel"), MAX_SEAT_LABEL_LENGTH, required=False)
        intent["driverNote"] = _text(data.get("driverNote"), MAX_TEXT_LENGTH, required=False)
    return intent


def _action_view(row: sqlite3.Row) -> dict[str, Any]:
    """An action as the screen sees it. Never includes the payload (it holds the grant)."""
    intent = json.loads(row["intent"])
    code = row["code"]
    problem = None
    if row["sync"] == "rejected":
        problem = PROBLEM_WORDS.get(code or "") or row["message"] or code
    return {
        "requestId": row["request_id"],
        "type": row["type"],
        "assignmentId": row["assignment_id"],
        "studentDisplayName": row["student_display_name"],
        "runId": row["run_id"],
        "sync": row["sync"],
        "result": row["result"],
        "code": code,
        "problem": problem,
        "checkIn": json.loads(row["check_in"]) if row["check_in"] else None,
        "capturedAtMs": row["captured_at_ms"],
        "attempts": row["attempts"],
        "details": {k: v for k, v in intent.items() if k not in ("type", "assignmentId")},
    }


Reply = tuple[int, dict[str, Any]]


@dataclass(frozen=True, slots=True)
class _Ctx:
    run_id: str
    driver_id: str
    grant: str = field(repr=False)


def _error(status: int, code: str, message: str, **extra: Any) -> Reply:
    return status, {"error": code, "message": message, **extra}


class StudentDesk:
    """QR codes, roster and action intake for driver_api.py. The caller has
    already checked the session cookie, CSRF, unlock and Parked."""

    def __init__(
        self,
        database_path: Path | str,
        client: DeviceGrantClient,
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        wake: threading.Event | None = None,
        mono_ms: Callable[[], int] = lambda: time.monotonic_ns() // 1_000_000,
    ) -> None:
        self.database_path = database_path
        self.client = client
        self.now_ms = now_ms
        # Elapsed time for code lifetimes: a wall clock that steps back must
        # never make an expired code valid again.
        self.mono_ms = mono_ms
        self.wake = wake
        self._qr_lock = threading.Lock()  # issuing a check-in code revokes the last one
        self._qr: dict[str, _CachedQr] = {}
        self._roster_lock = threading.Lock()

    def _db(self) -> Database:
        db = Database(self.database_path)
        ensure_schema(db)
        return db

    # ── Capabilities (for /api/status) ───────────────────────────────

    @staticmethod
    def summary(db: Database, now: int) -> dict[str, Any]:
        """Waiting and recently rejected changes, for the dashboard: shown even
        with no run, so a rejection that arrives after the run ends is seen."""
        exists = db.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='roster_actions'"
        ).fetchone()
        if exists is None:
            return {"pending": 0, "rejected": []}
        pending = db.conn.execute(
            "SELECT COUNT(*) FROM roster_actions WHERE sync='pending'"
        ).fetchone()[0]
        rows = db.conn.execute(
            "SELECT * FROM roster_actions WHERE sync='rejected' AND resolved_at_ms>=? "
            "ORDER BY resolved_at_ms DESC LIMIT 5",
            (now - REJECTED_SHOWN_MS,),
        ).fetchall()
        return {"pending": pending, "rejected": [_action_view(r) for r in rows]}

    @staticmethod
    def capability(session: KioskSession, run: dict[str, Any] | None) -> dict[str, Any]:
        if run is None or run.get("state") != "active":
            return {
                "available": False,
                "reason": "Start a run first. Codes and the roster belong to the active run.",
            }
        d = session.driver
        if d is not None and not d.operating_grant:
            return {
                "available": False,
                "reason": "Your transport office has not authorized you on this device.",
            }
        return {"available": True}

    def _context(self, session: KioskSession, db: Database) -> _Ctx | Reply:
        driver = session.driver
        if driver is None:
            return _error(HTTPStatus.FORBIDDEN, "LOCKED", "Unlock with your driver PIN first.")
        run_id = db.active_run_id()
        if run_id is None:
            return _error(
                HTTPStatus.CONFLICT,
                "NO_ACTIVE_RUN",
                "Start a run first. This needs the active run.",
            )
        if not driver.operating_grant:
            return _error(
                HTTPStatus.FORBIDDEN,
                "NO_GRANT",
                "Your transport office has not authorized you on this device.",
            )
        # The run must be on one of this driver's routes. Checked here, not
        # only by the server, because an offline device answers from its
        # cache: another route's driver must never see this run's names.
        route = self._route_version(db, run_id)
        if route is None or route not in {r.route_version_id for r in driver.route_versions}:
            return _error(
                HTTPStatus.FORBIDDEN,
                "NOT_YOUR_ROUTE",
                "This run is not on one of your routes. The driver who started it can use it.",
            )
        return _Ctx(run_id, driver.driver_id, driver.operating_grant)

    @staticmethod
    def _latest_check_in(db: Database, run_id: str, assignment_id: str) -> dict[str, Any] | None:
        """The record the server most recently accepted from this device for
        this student and run, if newer than the cached roster could show."""
        row = db.conn.execute(
            "SELECT check_in FROM roster_actions WHERE run_id=? AND assignment_id=? "
            "AND sync='synced' AND check_in IS NOT NULL "
            "ORDER BY resolved_at_ms DESC, rowid DESC LIMIT 1",
            (run_id, assignment_id),
        ).fetchone()
        return json.loads(row["check_in"]) if row is not None else None

    @staticmethod
    def _route_version(db: Database, run_id: str) -> str | None:
        row = db.conn.execute(
            "SELECT payload FROM run_start_requests WHERE run_id=? AND status='accepted' "
            "ORDER BY rowid DESC LIMIT 1",
            (run_id,),
        ).fetchone()
        if row is None:
            return None
        route = json.loads(row["payload"]).get("routeVersionId")
        return route if isinstance(route, str) else None

    # ── QR codes ─────────────────────────────────────────────────────

    def qr(self, session: KioskSession, data: dict[str, Any]) -> Reply:
        purpose = data.get("purpose")
        if purpose not in PURPOSES:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "BAD_PURPOSE",
                "Choose Check in for this trip or Join this route.",
            )
        db = self._db()
        try:
            ctx = self._context(session, db)
            if not isinstance(ctx, _Ctx):
                if db.active_run_id() is None:
                    with self._qr_lock:
                        self._qr.clear()  # the run ended: no code outlives it
                return ctx
            route = self._route_version(db, ctx.run_id)
        finally:
            db.close()
        with self._qr_lock:
            return self._qr_locked(purpose, ctx.run_id, ctx.driver_id, ctx.grant, route)

    def _qr_locked(
        self, purpose: str, run_id: str, driver_id: str, grant: str, route: str | None
    ) -> Reply:
        # Lifetimes run on the monotonic clock: a wall clock stepping back
        # must never make an expired code valid again.
        now = self.mono_ms()
        cached = self._qr.get(purpose)
        if cached is not None and (cached.run_id != run_id or cached.driver_id != driver_id):
            cached = None
            self._qr.pop(purpose, None)
        if cached is not None and cached.remaining_ms(now) > QR_REFRESH_BEFORE_MS:
            return HTTPStatus.OK, self._qr_view(cached, now, refresh_failed=False)
        body: dict[str, Any] = {
            "schemaVersion": 1,
            "driverOperatingGrant": grant,
            "purpose": purpose,
        }
        if purpose == "trip_check_in":
            body["runId"] = run_id
        else:
            if route is None:
                return _error(
                    HTTPStatus.CONFLICT,
                    "NO_ROUTE",
                    "This device does not know the active run's route, so it cannot invite "
                    "families to join it.",
                )
            body["routeVersionId"] = route
        reply = self.client.post(QR_PATH, _dumps(body).encode())
        if reply.kind == "ok":
            try:
                code = QrCode.from_wire(reply.data)
                if code.purpose != purpose or not code.token:
                    raise ValueError("purpose")
            except (KeyError, TypeError, ValueError):
                reply = GrantReply("unknown", 200, {}, "BAD_RESPONSE")
            else:
                fresh = _CachedQr(
                    code,
                    run_id,
                    driver_id,
                    route,
                    now,
                    max(0, code.expires_at_ms - code.server_now_ms),
                )
                self._qr[purpose] = fresh
                return HTTPStatus.OK, self._qr_view(fresh, now, refresh_failed=False)
        if reply.kind == "refused":
            self._qr.pop(purpose, None)
            code_name = reply.code or "REFUSED"
            words = SERVER_REFUSAL_WORDS.get(
                code_name, f"The school server refused the code ({code_name})."
            )
            return _error(HTTPStatus.FORBIDDEN, code_name, words)
        # Issuing a check-in code revokes the previous one on the server. If
        # this refresh may have been applied, the cached code may be dead:
        # never show it as valid. An enrollment code is not revoked that way.
        keep = purpose == "route_enrollment" or not reply.maybe_applied
        if keep and cached is not None and cached.remaining_ms(now) > 0:
            return HTTPStatus.OK, self._qr_view(cached, now, refresh_failed=True)
        self._qr.pop(purpose, None)
        return _error(HTTPStatus.SERVICE_UNAVAILABLE, "QR_UNAVAILABLE", QR_FALLBACK[purpose])

    @staticmethod
    def _qr_view(c: _CachedQr, now: int, *, refresh_failed: bool) -> dict[str, Any]:
        remaining = c.remaining_ms(now)
        return {
            "purpose": c.code.purpose,
            "label": PURPOSES[c.code.purpose],
            "token": c.code.token,
            "linkPath": c.code.link_path,
            "expiresAtMs": c.code.expires_at_ms,
            "remainingMs": remaining,
            # Ask again then; while the server is unreachable, sooner.
            "refreshInMs": 15_000
            if refresh_failed
            else max(1_000, remaining - QR_REFRESH_BEFORE_MS),
            "runId": c.run_id,
            "routeVersionId": c.route_version_id,
            "refreshFailed": refresh_failed,
        }

    # ── Roster ───────────────────────────────────────────────────────

    def roster(self, session: KioskSession) -> Reply:
        db = self._db()
        try:
            ctx = self._context(session, db)
            if not isinstance(ctx, _Ctx):
                return ctx
            with self._roster_lock:
                return self._roster_locked(db, ctx.run_id, ctx.grant)
        finally:
            db.close()

    def _roster_locked(self, db: Database, run_id: str, grant: str) -> Reply:
        now = self.now_ms()
        row = db.conn.execute(
            "SELECT body, fetched_at_ms FROM roster_cache WHERE run_id=?", (run_id,)
        ).fetchone()
        if row is not None and 0 <= now - row["fetched_at_ms"] < ROSTER_REUSE_MS:
            return HTTPStatus.OK, self._roster_view(db, run_id, row, now, None)
        body = {"schemaVersion": 1, "driverOperatingGrant": grant, "runId": run_id}
        reply = self.client.post(ROSTER_PATH, _dumps(body).encode())
        if reply.kind == "ok":
            try:
                parsed = Roster.from_wire(reply.data)
                if parsed.run_id != run_id:
                    raise ValueError("runId")
            except (KeyError, TypeError, ValueError):
                reply = GrantReply("unknown", 200, {}, "BAD_RESPONSE")
            else:
                with db.transaction() as tx:
                    # Only the active run's roster is kept on the device.
                    tx.execute("DELETE FROM roster_cache WHERE run_id<>?", (run_id,))
                    tx.execute(
                        "INSERT INTO roster_cache(run_id, body, fetched_at_ms) VALUES(?, ?, ?) "
                        "ON CONFLICT(run_id) DO UPDATE SET body=excluded.body, "
                        "fetched_at_ms=excluded.fetched_at_ms",
                        (run_id, _dumps(reply.data), now),
                    )
                fresh = {"body": _dumps(reply.data), "fetched_at_ms": now}
                return HTTPStatus.OK, self._roster_view(db, run_id, fresh, now, None)
        actions = self._actions(db, run_id, now)
        if reply.kind == "refused":
            with db.transaction() as tx:
                tx.execute("DELETE FROM roster_cache WHERE run_id=?", (run_id,))
            code = reply.code or "REFUSED"
            words = SERVER_REFUSAL_WORDS.get(
                code, f"The school server refused the roster ({code})."
            )
            return _error(HTTPStatus.FORBIDDEN, code, words, actions=actions)
        if row is not None:
            reason = "The school server did not answer. This is the last roster it sent."
            return HTTPStatus.OK, self._roster_view(db, run_id, row, now, reason)
        return _error(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "ROSTER_UNAVAILABLE",
            "The school server did not answer and this device has no roster for this run yet.",
            actions=actions,
        )

    def _roster_view(
        self, db: Database, run_id: str, row: Any, now: int, stale_reason: str | None
    ) -> dict[str, Any]:
        data = json.loads(row["body"])
        fetched = row["fetched_at_ms"]
        return {
            "runId": run_id,
            "routeVersionId": data.get("routeVersionId"),
            "students": data.get("students", []),
            "fetchedAtMs": fetched,
            "ageMs": max(0, now - fetched),
            "stale": stale_reason is not None,
            "staleReason": stale_reason,
            "actions": self._actions(db, run_id, now),
        }

    @staticmethod
    def _actions(db: Database, run_id: str, now: int) -> list[dict[str, Any]]:
        """This run's changes, everything still pending, and any recent
        rejection, even from an earlier run: a rejection is never hidden."""
        rows = db.conn.execute(
            "SELECT * FROM roster_actions WHERE run_id=? OR sync='pending' "
            "OR (sync='rejected' AND resolved_at_ms>=?) "
            "ORDER BY captured_at_ms, rowid",
            (run_id, now - REJECTED_SHOWN_MS),
        ).fetchall()
        return [_action_view(r) for r in rows]

    # ── Driver actions ───────────────────────────────────────────────

    def action(
        self,
        session: KioskSession,
        data: dict[str, Any],
        guard: Callable[[], None] | None = None,
    ) -> Reply:
        try:
            request_id = str(uuid.UUID(str(data.get("requestId"))))
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_REQUEST_ID", "requestId must be a UUID.")
        try:
            intent = _intent(data)
        except ActionInputError as exc:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_INPUT", str(exc))
        db = self._db()
        try:
            ctx = self._context(session, db)
            if not isinstance(ctx, _Ctx):
                return ctx
            run_id, grant = ctx.run_id, ctx.grant
            seen = self._seen(db, request_id, intent)
            if seen is not None:
                return seen
            cached = db.conn.execute(
                "SELECT body FROM roster_cache WHERE run_id=?", (run_id,)
            ).fetchone()
            if cached is None:
                return _error(
                    HTTPStatus.CONFLICT, "NO_ROSTER", "Open Show Students to load the roster first."
                )
            students = json.loads(cached["body"]).get("students", [])
            student = next(
                (s for s in students if s.get("assignmentId") == intent["assignmentId"]), None
            )
            if student is None:
                return _error(
                    HTTPStatus.CONFLICT,
                    "NOT_ON_ROSTER",
                    "That student is not on this run's roster. Reload the roster.",
                )
            fields: list[tuple[str, Any]] = []
            kind = intent["type"]
            if kind in ("recordAttendance", "correctAttendance"):
                fields += [("runId", run_id), ("status", intent["status"])]
            if kind == "correctAttendance":
                # The newest record: the roster's, or one the server accepted
                # from this device since the roster was fetched.
                current = self._latest_check_in(db, run_id, intent["assignmentId"]) or student.get(
                    "checkIn"
                )
                if not current:
                    return _error(
                        HTTPStatus.CONFLICT,
                        "NOTHING_TO_CORRECT",
                        "There is no record to correct yet. Record boarded or not boarded.",
                    )
                fields += [
                    ("correctsCheckInId", current["checkInId"]),
                    ("reason", intent["reason"]),
                ]
            if kind == "setSeatNote":
                fields += [("seatLabel", intent["seatLabel"]), ("driverNote", intent["driverNote"])]
            if kind == "removeAssignment":
                fields.append(("reason", intent["reason"]))
            captured = self.now_ms()
            wire = RosterAction(
                request_id, kind, captured, intent["assignmentId"], tuple(fields)
            ).to_wire(grant)
            db.write_guard = guard
            try:
                with db.transaction() as tx:
                    if (
                        kind == "removeAssignment"
                        and tx.execute(
                            "SELECT 1 FROM roster_actions WHERE assignment_id=? AND "
                            "type='removeAssignment' AND sync='pending'",
                            (intent["assignmentId"],),
                        ).fetchone()
                    ):
                        return _error(
                            HTTPStatus.CONFLICT,
                            "REMOVAL_PENDING",
                            "A removal for this student is already waiting to sync.",
                        )
                    tx.execute(
                        "INSERT INTO roster_actions(request_id, run_id, assignment_id, "
                        "student_display_name, type, intent, payload, captured_at_ms) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            request_id,
                            run_id,
                            intent["assignmentId"],
                            str(student.get("studentDisplayName", "")),
                            kind,
                            _dumps(intent),
                            _dumps(wire),
                            captured,
                        ),
                    )
            except sqlite3.IntegrityError:
                # The same requestId arrived twice at once: answer from the saved row.
                db.write_guard = None
                seen = self._seen(db, request_id, intent)
                if seen is not None:
                    return seen
                raise
            db.write_guard = None
            log.info("driver action saved: type=%s requestId=%s", kind, request_id)
            row = db.conn.execute(
                "SELECT * FROM roster_actions WHERE request_id=?", (request_id,)
            ).fetchone()
        finally:
            db.close()
        if self.wake is not None:
            self.wake.set()
        return HTTPStatus.OK, {"action": _action_view(row)}

    @staticmethod
    def _seen(db: Database, request_id: str, intent: dict[str, Any]) -> Reply | None:
        row = db.conn.execute(
            "SELECT * FROM roster_actions WHERE request_id=?", (request_id,)
        ).fetchone()
        if row is None:
            return None
        if json.loads(row["intent"]) != intent:
            return _error(
                HTTPStatus.CONFLICT,
                "REQUEST_ID_CONFLICT",
                "This change was already saved with different details.",
            )
        return HTTPStatus.OK, {"action": _action_view(row)}


# ── Sync ─────────────────────────────────────────────────────────────


def _backoff_ms(attempts: int) -> int:
    return min(BACKOFF_MAX_MS, 1_000 * 2 ** min(attempts, 16))


class RosterSyncThread(threading.Thread):
    """Sends saved driver actions, oldest first, resending the same bytes until
    the backend answers. Woken right after a new action is saved."""

    def __init__(
        self,
        database_path: Path | str,
        client: DeviceGrantClient,
        stop: threading.Event,
        wake: threading.Event | None = None,
        interval_s: float = 10.0,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(name="roster-sync", daemon=True)
        self.database_path, self.client, self.stop_event = database_path, client, stop
        self.wake = wake or threading.Event()
        self.interval_s = interval_s
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)

    def tick(self, db: Database) -> int:
        """One pass. Returns how many actions were sent. Stops at the first
        action that got no answer: the server is unreachable for the rest too."""
        ensure_schema(db)
        now = self.now_ms()
        # Strictly in capture order: a later change (a removal) must never
        # overtake an earlier one (attendance) that is waiting to be resent.
        rows = db.conn.execute(
            "SELECT request_id, payload, attempts, next_attempt_at_ms FROM roster_actions "
            "WHERE sync='pending' ORDER BY captured_at_ms, rowid LIMIT 50"
        ).fetchall()
        sent = 0
        for row in rows:
            if row["next_attempt_at_ms"] > now:
                break  # the oldest waits, and so does everything after it
            reply = self.client.post(ACTIONS_PATH, row["payload"].encode())
            sent += 1
            if not self._resolve(db, row, reply, now):
                break
        with db.transaction() as tx:
            tx.execute(
                "DELETE FROM roster_actions WHERE sync<>'pending' AND resolved_at_ms<?",
                (now - RESOLVED_KEEP_MS,),
            )
        return sent

    @staticmethod
    def _resolve(db: Database, row: sqlite3.Row, reply: GrantReply, now: int) -> bool:
        """Records the outcome. False when there was no final answer."""
        rid = row["request_id"]
        if reply.kind == "ok":
            try:
                result = RosterActionResult.from_wire(reply.data)
                if result.request_id != rid or not result.is_final:
                    raise ValueError("unexpected result")
            except (KeyError, TypeError, ValueError):
                reply = GrantReply("unknown", 200, {}, "BAD_RESPONSE")
            else:
                sync = "synced" if result.status in FINAL_SUCCESS else "rejected"
                check_in = reply.data.get("checkIn") if sync == "synced" else None
                with db.transaction() as tx:
                    tx.execute(
                        "UPDATE roster_actions SET sync=?, result=?, code=?, message=?, "
                        "check_in=?, attempts=attempts+1, last_error=NULL, resolved_at_ms=? "
                        "WHERE request_id=? AND sync='pending'",
                        (
                            sync,
                            result.status,
                            result.code,
                            result.message,
                            _dumps(check_in) if check_in else None,
                            now,
                            rid,
                        ),
                    )
                if sync == "rejected":
                    log.warning("driver action rejected: requestId=%s code=%s", rid, result.code)
                return True
        if reply.kind == "refused" and reply.http_status != 401:
            # A request-level refusal (400/403/409/413) will not change on resend.
            message = reply.data.get("error", {}).get("message") if reply.data else None
            with db.transaction() as tx:
                tx.execute(
                    "UPDATE roster_actions SET sync='rejected', result='rejected', code=?, "
                    "message=?, attempts=attempts+1, resolved_at_ms=? "
                    "WHERE request_id=? AND sync='pending'",
                    (reply.code, message if isinstance(message, str) else None, now, rid),
                )
            log.warning("driver action refused: requestId=%s code=%s", rid, reply.code)
            return True
        # No answer, a 5xx/429, or a device-credential problem: keep it and resend later.
        attempts = row["attempts"] + 1
        with db.transaction() as tx:
            tx.execute(
                "UPDATE roster_actions SET attempts=?, next_attempt_at_ms=?, last_error=? "
                "WHERE request_id=? AND sync='pending'",
                (attempts, now + _backoff_ms(attempts), reply.code, rid),
            )
        log.info("driver action not answered (%s); will resend requestId=%s", reply.code, rid)
        return False

    def run(self) -> None:
        db = Database(self.database_path)
        try:
            while not self.stop_event.is_set():
                try:
                    self.tick(db)
                except Exception:
                    log.exception("roster sync tick failed")
                waited = 0.0
                while (
                    waited < self.interval_s
                    and not self.stop_event.is_set()
                    and not self.wake.is_set()
                ):
                    self.wake.wait(1.0)
                    waited += 1.0
                self.wake.clear()
        finally:
            db.close()
