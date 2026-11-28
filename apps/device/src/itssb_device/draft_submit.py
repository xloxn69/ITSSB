"""Submitting a finished route draft for staff review (docs/08 §7.1, docs/05 D10-D11).

Rules enforced here (driver_api.py adds the session, unlock and parked checks):

- Submit builds the exact wire body from the saved draft and the unlocked
  driver's operating grant, checks it against the server's limits, and saves
  it in SQLite with its `requestId` BEFORE anything is sent. A draft that
  could never be accepted (too many points or stops, no stops) is refused
  here instead of being queued.
- `DraftSyncThread` sends it and resends the same bytes after a network
  failure, a 5xx, a 429 or a 401, until the server answers. Only the
  server's `accepted` or `already_submitted` makes the draft "submitted"; a
  queued draft is "pending" and is never shown as submitted.
- Once Submit is pressed the draft's content is frozen (drafts.py refuses
  edits), so every retry, and a later "Submit again" after a refusal,
  carries the same recording and the server keeps one draft.
- Review status (awaiting approval, approved, rejected with reason) is read
  from the server with the unlocked driver's grant when the screen asks,
  and stored with the device time it was read, so the screen shows its age.
- The grant goes to the server in a request body only; it is never returned
  to the browser, put in a URL, or logged.
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
from .route_draft_contracts import (
    MAX_ROUTE_DRAFT_BODY_BYTES,
    MAX_ROUTE_DRAFT_STATUS_IDS,
    MAX_ROUTE_DRAFT_STOPS,
    MAX_ROUTE_PATH_POINTS,
    DraftPoint,
    DraftStop,
    RouteDraftSubmission,
    RouteDraftSubmitResult,
    reviews_from_wire,
    status_request,
)
from .students import DeviceGrantClient, GrantReply

log = logging.getLogger(__name__)

SUBMIT_PATH = "/device/v1/route-drafts"
STATUS_PATH = "/device/v1/route-drafts/status"
BACKOFF_MAX_MS = 5 * 60_000
# Review status is read at most this often; staff decide in minutes, not seconds.
STATUS_REFRESH_MS = 30_000

# What a refusal means, in words a driver can act on.
PROBLEM_WORDS = {
    "grant_not_authorized": "Your driver authorization had ended or was withdrawn before this "
    "reached the school server. Unlock with your PIN and submit again.",
    "request_id_conflict": "The school server already has this draft with different stops or "
    "path. Record the route again to change it.",
    "draft_conflict": "The school server already has this draft with different stops or path. "
    "Record the route again to change it.",
    "TOO_MANY_POINTS": "This recording has more points than the school server accepts.",
    "TOO_MANY_STOPS": f"Routes can have at most {MAX_ROUTE_DRAFT_STOPS} stops.",
    "BODY_TOO_LARGE": "This recording is too large for the school server.",
    "GRANT_NOT_AUTHORIZED": "The school server did not accept your driver authorization.",
}
WAITING_WORDS = {
    "UNAUTHENTICATED": "The school server did not accept this device's credential.",
}


def _dumps(payload: Any) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _error(status: int, code: str, message: str) -> tuple[int, dict[str, Any]]:
    return status, {"error": code, "message": message}


Reply = tuple[int, dict[str, Any]]


def submission_view(conn: sqlite3.Connection, draft_id: str) -> dict[str, Any]:
    """The draft's submission state for the screen: the latest Submit press.

    `submission` is one of:
    - `not_submitted`: never submitted
    - `pending`: saved on this device, the server has not answered yet
    - `refused`: the server refused the upload; Submit again is possible
    - `submitted`: the server accepted it; awaiting staff review
    - `approved` / `rejected`: staff decided (`rejected` carries the reason)
    - `unknown`: the server no longer recognizes this draft
    """
    row = conn.execute(
        "SELECT * FROM route_draft_submissions WHERE draft_id=? "
        "ORDER BY captured_at_ms DESC, rowid DESC LIMIT 1",
        (draft_id,),
    ).fetchone()
    if row is None:
        return {"submission": "not_submitted", "submissionDetail": None}
    if row["sync"] == "pending":
        state = "pending"
    elif row["sync"] == "rejected":
        state = "refused"
    else:
        state = {"not_found": "unknown"}.get(row["review_status"], row["review_status"])
    code = row["code"]
    problem = None
    if row["sync"] == "rejected":
        problem = PROBLEM_WORDS.get(code or "") or row["message"] or code
    return {
        "submission": state,
        "submissionDetail": {
            "requestId": row["request_id"],
            "queuedAtMs": row["captured_at_ms"],
            "attempts": row["attempts"],
            "waitingReason": WAITING_WORDS.get(row["last_error"] or "")
            if row["sync"] == "pending"
            else None,
            "code": code,
            "problem": problem,
            "decisionReason": row["review_reason"],
            "reviewedAtMs": row["reviewed_at_ms"],
            "reviewCheckedAtMs": row["review_checked_at_ms"],
        },
    }


def frozen(conn: sqlite3.Connection, draft_id: str) -> bool:
    """True once Submit was pressed: the content may already be on the server."""
    return (
        conn.execute(
            "SELECT 1 FROM route_draft_submissions WHERE draft_id=? LIMIT 1", (draft_id,)
        ).fetchone()
        is not None
    )


class DraftDesk:
    """Submit and review-status reads for driver_api.py. The caller has
    already checked the session cookie, CSRF, unlock and (for submit) Parked."""

    def __init__(
        self,
        client: DeviceGrantClient,
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
        wake: threading.Event | None = None,
        mono_ms: Callable[[], int] = lambda: time.monotonic_ns() // 1_000_000,
    ) -> None:
        self.client = client
        self.now_ms = now_ms
        self.mono_ms = mono_ms
        self.wake = wake
        self._refresh_lock = threading.Lock()
        self._last_refresh_mono: int | None = None

    @staticmethod
    def capability(session: KioskSession) -> dict[str, Any]:
        d = session.driver
        if d is not None and not d.operating_grant:
            return {
                "available": False,
                "reason": "Your transport office has not authorized you on this device.",
            }
        return {"available": True}

    # ── Submit ───────────────────────────────────────────────────────

    def submit(
        self, db: Database, session: KioskSession, draft_id: str, data: dict[str, Any]
    ) -> Reply:
        try:
            request_id = str(uuid.UUID(str(data.get("requestId"))))
        except ValueError:
            return _error(HTTPStatus.BAD_REQUEST, "BAD_REQUEST_ID", "requestId must be a UUID.")
        driver = session.driver
        if driver is None:
            return _error(HTTPStatus.FORBIDDEN, "LOCKED", "Unlock with your driver PIN first.")
        if not driver.operating_grant:
            return _error(
                HTTPStatus.FORBIDDEN,
                "NO_GRANT",
                "Your transport office has not authorized you on this device.",
            )
        seen = db.conn.execute(
            "SELECT draft_id FROM route_draft_submissions WHERE request_id=?", (request_id,)
        ).fetchone()
        if seen is not None:
            if seen["draft_id"] != draft_id:
                return _error(HTTPStatus.CONFLICT, "REQUEST_ID_CONFLICT", "requestId already used.")
            return HTTPStatus.OK, submission_view(db.conn, draft_id)
        driver_grant = driver.operating_grant
        # Built and saved in one write transaction: no edit can land between
        # what is checked and what is queued.
        with db.transaction() as tx:
            last = tx.execute(
                "SELECT sync FROM route_draft_submissions WHERE draft_id=? "
                "ORDER BY captured_at_ms DESC, rowid DESC LIMIT 1",
                (draft_id,),
            ).fetchone()
            if last is not None and last["sync"] != "rejected":
                return _error(
                    HTTPStatus.CONFLICT,
                    "ALREADY_SUBMITTED",
                    "This draft is already submitted or waiting to send.",
                )
            built = self._build(db, draft_id, request_id)
            if not isinstance(built, RouteDraftSubmission):
                return built
            body = _dumps(built.to_wire(driver_grant))
            if len(body.encode()) > MAX_ROUTE_DRAFT_BODY_BYTES:
                return _error(
                    HTTPStatus.CONFLICT, "TOO_LARGE", "This recording is too large to submit."
                )
            tx.execute(
                "INSERT INTO route_draft_submissions(request_id, draft_id, payload, "
                "captured_at_ms) VALUES(?, ?, ?, ?)",
                (request_id, draft_id, body, built.captured_at_ms),
            )
        log.info("route draft queued for review: draft=%s requestId=%s", draft_id, request_id)
        if self.wake is not None:
            self.wake.set()
        return HTTPStatus.OK, submission_view(db.conn, draft_id)

    def _build(self, db: Database, draft_id: str, request_id: str) -> RouteDraftSubmission | Reply:
        d = db.conn.execute("SELECT * FROM route_drafts WHERE draft_id=?", (draft_id,)).fetchone()
        if d is None:
            return _error(HTTPStatus.NOT_FOUND, "NOT_FOUND", "No such draft on this device.")
        if d["status"] != "finished":
            return _error(
                HTTPStatus.CONFLICT, "NOT_FINISHED", "Finish the recording before submitting."
            )
        points = db.conn.execute(
            "SELECT captured_at_ms, latitude, longitude, gap_before FROM route_draft_points "
            "WHERE draft_id=? ORDER BY seq",
            (draft_id,),
        ).fetchall()
        stops = db.conn.execute(
            "SELECT name, latitude, longitude, captured_at_ms FROM route_draft_stops "
            "WHERE draft_id=? ORDER BY position",
            (draft_id,),
        ).fetchall()
        if len(points) < 2:
            return _error(
                HTTPStatus.CONFLICT,
                "TOO_FEW_POINTS",
                "This recording has too few points to submit. Record the route again.",
            )
        if len(points) > MAX_ROUTE_PATH_POINTS:
            return _error(
                HTTPStatus.CONFLICT,
                "TOO_MANY_POINTS",
                f"This recording has {len(points)} points; the school server accepts at most "
                f"{MAX_ROUTE_PATH_POINTS}. Record the route in shorter parts.",
            )
        if not stops:
            return _error(HTTPStatus.CONFLICT, "NO_STOPS", "Mark at least one stop to submit.")
        if len(stops) > MAX_ROUTE_DRAFT_STOPS:
            return _error(
                HTTPStatus.CONFLICT,
                "TOO_MANY_STOPS",
                f"Routes can have at most {MAX_ROUTE_DRAFT_STOPS} stops.",
            )
        return RouteDraftSubmission(
            request_id=request_id,
            device_draft_id=draft_id,
            captured_at_ms=self.now_ms(),
            label=d["name"],
            direction=d["direction"],
            started_at_ms=d["started_at_ms"],
            finished_at_ms=d["finished_at_ms"],
            path=tuple(
                DraftPoint(
                    p["latitude"], p["longitude"], p["captured_at_ms"], bool(p["gap_before"])
                )
                for p in points
            ),
            stops=tuple(
                DraftStop(s["name"], s["latitude"], s["longitude"], s["captured_at_ms"])
                for s in stops
            ),
        )

    # ── Review status ────────────────────────────────────────────────

    def refresh(self, db: Database, session: KioskSession) -> dict[str, Any]:
        """Reads review status for drafts awaiting a decision, at most every
        STATUS_REFRESH_MS. Returns {"checked", "problem"} for the screen; the
        stored status and its read time are what the drafts list shows."""
        driver = session.driver
        if driver is None or not driver.operating_grant:
            return {"checked": False, "problem": "Unlock to check the review status."}
        # Least recently asked first, by a counter rather than a time: with
        # more drafts awaiting review than one read may ask about, successive
        # reads reach every draft even if the wall clock steps backward.
        rows = db.conn.execute(
            "SELECT request_id, server_draft_id FROM route_draft_submissions "
            "WHERE sync='accepted' AND review_status='submitted' "
            "ORDER BY review_check_seq, captured_at_ms, rowid LIMIT ?",
            (MAX_ROUTE_DRAFT_STATUS_IDS,),
        ).fetchall()
        if not rows:
            return {"checked": True, "problem": None}
        with self._refresh_lock:
            mono = self.mono_ms()
            if self._last_refresh_mono is not None and mono - self._last_refresh_mono < (
                STATUS_REFRESH_MS
            ):
                return {"checked": False, "problem": None}
            self._last_refresh_mono = mono
            ids = [r["server_draft_id"] for r in rows]
            reply = self.client.post(
                STATUS_PATH, _dumps(status_request(driver.operating_grant, ids)).encode()
            )
        if reply.kind != "ok":
            words = (
                PROBLEM_WORDS.get(reply.code or "")
                if reply.kind == "refused"
                else "The school server could not be reached."
            )
            return {"checked": False, "problem": words or "The school server refused the check."}
        try:
            reviews = reviews_from_wire(reply.data)
        except (KeyError, TypeError, ValueError):
            return {"checked": False, "problem": "The school server's answer was unreadable."}
        now = self.now_ms()
        with db.transaction() as tx:
            seq = tx.execute(
                "SELECT COALESCE(MAX(review_check_seq), 0) + 1 FROM route_draft_submissions"
            ).fetchone()[0]
            # Every draft asked about moves to the back of the rotation, even
            # one the server left out, so it can't hold a slot forever.
            tx.executemany(
                "UPDATE route_draft_submissions SET review_check_seq=? WHERE request_id=?",
                [(seq, r["request_id"]) for r in rows],
            )
            for r in rows:
                if r["server_draft_id"] not in reviews:
                    continue
                review = reviews[r["server_draft_id"]]
                tx.execute(
                    "UPDATE route_draft_submissions SET review_status=?, review_reason=?, "
                    "reviewed_at_ms=?, review_checked_at_ms=? WHERE request_id=?",
                    (
                        review.status if review else "not_found",
                        review.decision_reason if review else None,
                        review.reviewed_at_ms if review else None,
                        now,
                        r["request_id"],
                    ),
                )
        return {"checked": True, "problem": None}


# ── Sync ─────────────────────────────────────────────────────────────


def _backoff_ms(attempts: int) -> int:
    return min(BACKOFF_MAX_MS, 2_000 * 2 ** min(attempts, 16))


class DraftSyncThread(threading.Thread):
    """Sends queued submissions, oldest first, resending the same bytes until
    the server answers. Woken right after a Submit."""

    def __init__(
        self,
        database_path: Path | str,
        client: DeviceGrantClient,
        stop: threading.Event,
        wake: threading.Event | None = None,
        interval_s: float = 15.0,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(name="draft-sync", daemon=True)
        self.database_path, self.client, self.stop_event = database_path, client, stop
        self.wake = wake or threading.Event()
        self.interval_s = interval_s
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)

    def tick(self, db: Database) -> int:
        """One pass. Returns how many were sent; stops at the first unanswered one."""
        now = self.now_ms()
        rows = db.conn.execute(
            "SELECT request_id, payload, attempts, next_attempt_at_ms "
            "FROM route_draft_submissions WHERE sync='pending' "
            "ORDER BY captured_at_ms, rowid LIMIT 10"
        ).fetchall()
        sent = 0
        for row in rows:
            if row["next_attempt_at_ms"] > now:
                continue  # independent drafts: one waiting never holds back another
            reply = self.client.post(SUBMIT_PATH, row["payload"].encode())
            sent += 1
            if not self._resolve(db, row, reply, now):
                break
        return sent

    @staticmethod
    def _resolve(db: Database, row: sqlite3.Row, reply: GrantReply, now: int) -> bool:
        """Records the outcome. False when there was no final answer."""
        rid = row["request_id"]
        if reply.kind == "ok":
            try:
                result = RouteDraftSubmitResult.from_wire(reply.data)
                if result.request_id != rid:
                    raise ValueError("answer for another request")
            except (KeyError, TypeError, ValueError):
                reply = GrantReply("unknown", 200, {}, "BAD_RESPONSE")
            else:
                with db.transaction() as tx:
                    if result.draft is not None:
                        tx.execute(
                            "UPDATE route_draft_submissions SET sync='accepted', code=NULL, "
                            "message=NULL, server_draft_id=?, review_status=?, "
                            "review_reason=?, reviewed_at_ms=?, review_checked_at_ms=?, "
                            "attempts=attempts+1, last_error=NULL, resolved_at_ms=? "
                            "WHERE request_id=? AND sync='pending'",
                            (
                                result.draft.draft_id,
                                result.draft.status,
                                result.draft.decision_reason,
                                result.draft.reviewed_at_ms,
                                now,
                                now,
                                rid,
                            ),
                        )
                    else:
                        tx.execute(
                            "UPDATE route_draft_submissions SET sync='rejected', code=?, "
                            "message=?, attempts=attempts+1, resolved_at_ms=? "
                            "WHERE request_id=? AND sync='pending'",
                            (result.code, result.message, now, rid),
                        )
                log.info("route draft submit %s: requestId=%s", result.status, rid)
                return True
        if reply.kind == "refused" and reply.http_status != 401:
            # A request-level refusal (400/403/409/413) will not change on resend.
            err = reply.data.get("error") if reply.data else None
            message = err.get("message") if isinstance(err, dict) else None
            with db.transaction() as tx:
                tx.execute(
                    "UPDATE route_draft_submissions SET sync='rejected', code=?, message=?, "
                    "attempts=attempts+1, resolved_at_ms=? WHERE request_id=? AND sync='pending'",
                    (reply.code, message if isinstance(message, str) else None, now, rid),
                )
            log.warning("route draft submit refused: requestId=%s code=%s", rid, reply.code)
            return True
        # No answer, a 5xx/429, or a device-credential problem: keep it and resend later.
        attempts = row["attempts"] + 1
        with db.transaction() as tx:
            tx.execute(
                "UPDATE route_draft_submissions SET attempts=?, next_attempt_at_ms=?, "
                "last_error=? WHERE request_id=? AND sync='pending'",
                (attempts, now + _backoff_ms(attempts), reply.code, rid),
            )
        log.info("route draft submit not answered (%s); will resend requestId=%s", reply.code, rid)
        return False

    def run(self) -> None:
        db = Database(self.database_path)
        try:
            while not self.stop_event.is_set():
                try:
                    self.tick(db)
                except Exception:
                    log.exception("draft sync tick failed")
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
