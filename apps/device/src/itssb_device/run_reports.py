"""Driver delay and issue reports (docs/08 §9.3, docs/05 D20).

Rules enforced here (driver_api.py adds the session, CSRF, unlock and
parked checks):

- A report is one fixed category and, optionally, whole minutes of
  expected delay. There is no free text: nothing typed reaches the server
  or families.
- It belongs to the device's active run and the unlocked driver's operating
  grant, with the same run and route checks as the roster (students.py).
- It is saved in SQLite with its `requestId` (from the screen, generated
  once) and capture time, as the exact wire body, BEFORE anything is sent.
  `RunReportSyncThread` sends it and resends the same bytes after a network
  failure, a 5xx, a 429 or a 401, until the server answers. Only the
  server's `accepted` or `already_recorded` makes it "sent"; until then the
  screen says it is waiting, and a refusal stays visible with its reason.
- The grant goes to the server in the request body only; the saved payload
  is never returned to the browser or logged.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable
from http import HTTPStatus
from pathlib import Path
from typing import Any

from .database import Database
from .local_auth import KioskSession
from .students import DeviceGrantClient, GrantReply, RunContext, StudentDesk

log = logging.getLogger(__name__)

REPORTS_PATH = "/device/v1/run-reports"

# packages/contracts/src/runReports.ts
CATEGORIES = ("traffic", "mechanical", "weather", "student_incident", "other")
MIN_DELAY_MINUTES = 1
MAX_DELAY_MINUTES = 120
BACKOFF_MAX_MS = 60_000
# The dashboard and D20 show reports this recent.
SHOWN_MS = 24 * 3600 * 1000
RESOLVED_KEEP_MS = 7 * 24 * 3600 * 1000

PROBLEM_WORDS = {
    "grant_not_authorized": "Your driver authorization had ended or was withdrawn before this "
    "reached the school server. Tell your transport office.",
    "run_not_authorized": "The school server does not match this report to a trip this bus ran.",
    "capture_time_out_of_range": "It waited too long to send, or this device's clock is wrong. "
    "Tell your transport office.",
    "request_id_conflict": "The school server saw this report before with different details.",
}
WAITING_WORDS = {
    "UNAUTHENTICATED": "The school server did not accept this device's credential.",
}

Reply = tuple[int, dict[str, Any]]


def _error(status: int, code: str, message: str) -> Reply:
    return status, {"error": code, "message": message}


def _dumps(payload: Any) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _minutes(value: object) -> int | None:
    """None, or whole minutes in range. Raises ValueError otherwise."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("minutes")
    if not MIN_DELAY_MINUTES <= value <= MAX_DELAY_MINUTES:
        raise ValueError("minutes")
    return value


def report_view(row: sqlite3.Row) -> dict[str, Any]:
    """A report as the screen sees it. Never includes the payload (it holds the grant).

    `sync` is `pending` (saved here, the server has not answered), `sent`
    (the server accepted it) or `refused` (final, with `problem`)."""
    sync = {"pending": "pending", "accepted": "sent", "rejected": "refused"}[row["sync"]]
    code = row["code"]
    return {
        "requestId": row["request_id"],
        "runId": row["run_id"],
        "category": row["category"],
        "minutes": row["minutes"],
        "sync": sync,
        "capturedAtMs": row["captured_at_ms"],
        "resolvedAtMs": row["resolved_at_ms"],
        "attempts": row["attempts"],
        "waitingReason": WAITING_WORDS.get(row["last_error"] or "")
        if row["sync"] == "pending"
        else None,
        "problem": (PROBLEM_WORDS.get(code or "") or row["message"] or code)
        if row["sync"] == "rejected"
        else None,
    }


class RunReportDesk:
    """Report intake for driver_api.py. The caller has already checked the
    session cookie, CSRF, unlock and Parked."""

    def __init__(
        self,
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        wake: threading.Event | None = None,
    ) -> None:
        self.now_ms = now_ms
        self.wake = wake

    @staticmethod
    def recent(db: Database, now: int, route_ids: set[str]) -> list[dict[str, Any]]:
        """Recent reports on runs of the unlocked driver's routes, newest first:
        a refusal that arrives after the run ended is still seen."""
        runs = StudentDesk._runs_on_routes(db, route_ids)
        rows = db.conn.execute(
            "SELECT * FROM run_reports WHERE sync='pending' OR captured_at_ms>=? "
            "ORDER BY captured_at_ms DESC, rowid DESC LIMIT 50",
            (now - SHOWN_MS,),
        ).fetchall()
        return [report_view(r) for r in rows if r["run_id"] in runs][:10]

    def report(
        self,
        db: Database,
        session: KioskSession,
        data: dict[str, Any],
        guard: Callable[[], None] | None = None,
    ) -> Reply:
        try:
            request_id = str(uuid.UUID(str(data.get("requestId"))))
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_REQUEST_ID", "requestId must be a UUID.")
        category = data.get("category")
        if category not in CATEGORIES:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_INPUT", "Choose a reason.")
        try:
            minutes = _minutes(data.get("minutes"))
        except ValueError:
            return _error(
                HTTPStatus.BAD_REQUEST,
                "BAD_INPUT",
                f"Minutes must be {MIN_DELAY_MINUTES} to {MAX_DELAY_MINUTES}, or not given.",
            )
        ctx = StudentDesk.run_context(session, db)
        if not isinstance(ctx, RunContext):
            return ctx
        seen = self._seen(db, request_id, ctx.run_id, category, minutes)
        if seen is not None:
            return seen
        captured = self.now_ms()
        wire = {
            "schemaVersion": 1,
            "requestId": request_id,
            "driverOperatingGrant": ctx.grant,
            "runId": ctx.run_id,
            "capturedAtMs": captured,
            "category": category,
            "expectedDelayMinutes": minutes,
        }
        db.write_guard = guard
        try:
            with db.transaction() as tx:
                tx.execute(
                    "INSERT INTO run_reports(request_id, run_id, category, minutes, payload, "
                    "captured_at_ms) VALUES(?, ?, ?, ?, ?, ?)",
                    (request_id, ctx.run_id, category, minutes, _dumps(wire), captured),
                )
        except sqlite3.IntegrityError:
            # The same requestId arrived twice at once: answer from the saved row.
            db.write_guard = None
            seen = self._seen(db, request_id, ctx.run_id, category, minutes)
            if seen is not None:
                return seen
            raise
        finally:
            db.write_guard = None
        log.info("run report saved: category=%s requestId=%s", category, request_id)
        if self.wake is not None:
            self.wake.set()
        row = db.conn.execute(
            "SELECT * FROM run_reports WHERE request_id=?", (request_id,)
        ).fetchone()
        return HTTPStatus.OK, {"report": report_view(row)}

    @staticmethod
    def _seen(
        db: Database, request_id: str, run_id: str, category: str, minutes: int | None
    ) -> Reply | None:
        row = db.conn.execute(
            "SELECT * FROM run_reports WHERE request_id=?", (request_id,)
        ).fetchone()
        if row is None:
            return None
        if row["run_id"] != run_id or row["category"] != category or row["minutes"] != minutes:
            return _error(
                HTTPStatus.CONFLICT,
                "REQUEST_ID_CONFLICT",
                "This report was already saved with different details.",
            )
        return HTTPStatus.OK, {"report": report_view(row)}


# ── Sync ─────────────────────────────────────────────────────────────


def _backoff_ms(attempts: int) -> int:
    return min(BACKOFF_MAX_MS, 1_000 * 2 ** min(attempts, 16))


class RunReportSyncThread(threading.Thread):
    """Sends saved reports, oldest first, resending the same bytes until the
    server answers. Woken right after a new report is saved."""

    def __init__(
        self,
        database_path: Path | str,
        client: DeviceGrantClient,
        stop: threading.Event,
        wake: threading.Event | None = None,
        interval_s: float = 10.0,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(name="run-report-sync", daemon=True)
        self.database_path, self.client, self.stop_event = database_path, client, stop
        self.wake = wake or threading.Event()
        self.interval_s = interval_s
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)

    def tick(self, db: Database) -> int:
        """One pass. Returns how many were sent; stops at the first unanswered one."""
        now = self.now_ms()
        rows = db.conn.execute(
            "SELECT request_id, payload, attempts, next_attempt_at_ms FROM run_reports "
            "WHERE sync='pending' ORDER BY captured_at_ms, rowid LIMIT 20"
        ).fetchall()
        sent = 0
        for row in rows:
            if row["next_attempt_at_ms"] > now:
                continue  # independent reports: one waiting never holds back another
            reply = self.client.post(REPORTS_PATH, row["payload"].encode())
            sent += 1
            if not self._resolve(db, row, reply, now):
                break
        with db.transaction() as tx:
            tx.execute(
                "DELETE FROM run_reports WHERE sync<>'pending' AND resolved_at_ms<?",
                (now - RESOLVED_KEEP_MS,),
            )
        return sent

    @staticmethod
    def _resolve(db: Database, row: sqlite3.Row, reply: GrantReply, now: int) -> bool:
        """Records the outcome. False when there was no final answer."""
        rid = row["request_id"]
        if reply.kind == "ok":
            data = reply.data
            status = data.get("status")
            report = data.get("report")
            ok = (
                data.get("requestId") == rid
                and status in ("accepted", "already_recorded")
                and isinstance(report, dict)
                and isinstance(report.get("reportId"), str)
            )
            refused = data.get("requestId") == rid and status == "rejected"
            if ok:
                with db.transaction() as tx:
                    tx.execute(
                        "UPDATE run_reports SET sync='accepted', server_report_id=?, code=NULL, "
                        "message=NULL, attempts=attempts+1, last_error=NULL, resolved_at_ms=? "
                        "WHERE request_id=? AND sync='pending'",
                        (report["reportId"], now, rid),  # type: ignore[index]
                    )
                log.info("run report %s: requestId=%s", status, rid)
                return True
            if refused:
                code, message = data.get("code"), data.get("message")
                with db.transaction() as tx:
                    tx.execute(
                        "UPDATE run_reports SET sync='rejected', code=?, message=?, "
                        "attempts=attempts+1, resolved_at_ms=? "
                        "WHERE request_id=? AND sync='pending'",
                        (
                            code if isinstance(code, str) else None,
                            message if isinstance(message, str) else None,
                            now,
                            rid,
                        ),
                    )
                log.warning("run report rejected: requestId=%s code=%s", rid, code)
                return True
            reply = GrantReply("unknown", 200, {}, "BAD_RESPONSE")
        if reply.kind == "refused" and reply.http_status != 401:
            # A request-level refusal (400/403/409/413) will not change on resend.
            err = reply.data.get("error") if reply.data else None
            message = err.get("message") if isinstance(err, dict) else None
            with db.transaction() as tx:
                tx.execute(
                    "UPDATE run_reports SET sync='rejected', code=?, message=?, "
                    "attempts=attempts+1, resolved_at_ms=? WHERE request_id=? AND sync='pending'",
                    (reply.code, message if isinstance(message, str) else None, now, rid),
                )
            log.warning("run report refused: requestId=%s code=%s", rid, reply.code)
            return True
        # No answer, a 5xx/429, or a device-credential problem: keep it and resend later.
        attempts = row["attempts"] + 1
        with db.transaction() as tx:
            tx.execute(
                "UPDATE run_reports SET attempts=?, next_attempt_at_ms=?, last_error=? "
                "WHERE request_id=? AND sync='pending'",
                (attempts, now + _backoff_ms(attempts), reply.code, rid),
            )
        log.info("run report not answered (%s); will resend requestId=%s", reply.code, rid)
        return False

    def run(self) -> None:
        db = Database(self.database_path)
        try:
            while not self.stop_event.is_set():
                try:
                    self.tick(db)
                except Exception:
                    log.exception("run report sync tick failed")
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
