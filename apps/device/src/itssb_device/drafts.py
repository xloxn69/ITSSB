"""Route recording into a local draft (docs/05 §6, docs/04 §2 `recording.py`).

A recording is real observations plus explicitly marked stops:

- Points are sampled from the device's own GPS fixes, each with its actual
  capture time. A gap longer than GAP_MS between two points is flagged on
  the later point; the review may draw a connector there but must not call
  it measured travel.
- Stops have stable ids and a position the SERVICE assigns. Their
  coordinates come from the device's latest fresh fix, never from the
  request, so the browser cannot place a stop anywhere it likes.
- Every create action carries a `requestId`; a double tap or retry returns
  the same draft or stop instead of making a second one.

A finished draft is "Saved on this device". Submitting it for review needs the
backend's route-drafts operation (docs/08 §7), which does not exist yet; this
module never claims a draft was submitted or approved.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .database import Database
from .gps_reader import LatestFixHolder
from .models import Fix

log = logging.getLogger(__name__)

# A sampled fix must be at most this old (same window as motion and health).
FRESH_S = 5.0

DIRECTIONS = ("to_school", "from_school")
GAP_MS = 5_000
MAX_NAME = 60
MAX_REVIEW_POINTS = 400


class DraftError(Exception):
    """A refused draft action; `code` is stable for the UI."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def clean_name(name: object, fallback: str | None = None) -> str:
    if name is None and fallback is not None:
        return fallback
    if not isinstance(name, str):
        raise DraftError("BAD_NAME", "Name must be text.")
    name = " ".join(name.split())
    if not name and fallback is not None:
        return fallback
    if not name or len(name) > MAX_NAME:
        raise DraftError("BAD_NAME", f"Name must be 1-{MAX_NAME} characters.")
    return name


def valid_request_id(request_id: object) -> str:
    try:
        return str(uuid.UUID(str(request_id)))
    except ValueError:
        raise DraftError("BAD_REQUEST_ID", "requestId must be a UUID.") from None


class Drafts:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.conn = db.conn

    # ── Reads ────────────────────────────────────────────────────────

    def _row(self, draft_id: str) -> sqlite3.Row:
        row = self.conn.execute(
            "SELECT * FROM route_drafts WHERE draft_id=?", (draft_id,)
        ).fetchone()
        if row is None:
            raise DraftError("NOT_FOUND", "No such draft on this device.")
        return row

    def recording(self) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT draft_id FROM route_drafts WHERE status='recording'"
        ).fetchone()
        return self.summary(row["draft_id"]) if row else None

    def summary(self, draft_id: str) -> dict[str, Any]:
        d = self._row(draft_id)
        pts = self.conn.execute(
            "SELECT COUNT(*) AS n, SUM(gap_before) AS gaps, MAX(captured_at_ms) AS last "
            "FROM route_draft_points WHERE draft_id=?",
            (draft_id,),
        ).fetchone()
        stops = self.conn.execute(
            "SELECT COUNT(*) AS n FROM route_draft_stops WHERE draft_id=?", (draft_id,)
        ).fetchone()
        return {
            "draftId": d["draft_id"],
            "name": d["name"],
            "direction": d["direction"],
            "status": d["status"],
            # Honest sync state: nothing leaves this device until the backend
            # supports route drafts.
            "submission": "not_submitted",
            "startedAtMs": d["started_at_ms"],
            "finishedAtMs": d["finished_at_ms"],
            "pointCount": pts["n"],
            "gapCount": pts["gaps"] or 0,
            "lastPointCapturedAtMs": pts["last"],
            "stopCount": stops["n"],
        }

    def list(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT draft_id FROM route_drafts ORDER BY started_at_ms DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self.summary(r["draft_id"]) for r in rows]

    def stops(self, draft_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM route_draft_stops WHERE draft_id=? ORDER BY position", (draft_id,)
        ).fetchall()
        return [
            {
                "stopId": r["stop_id"],
                "position": r["position"],
                "name": r["name"],
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "capturedAtMs": r["captured_at_ms"],
            }
            for r in rows
        ]

    def detail(self, draft_id: str) -> dict[str, Any]:
        """Summary, ordered stops, and a bounded path for the review screen.
        Gap points are always kept so a review never hides missing sections."""
        rows = self.conn.execute(
            "SELECT seq, captured_at_ms, latitude, longitude, gap_before "
            "FROM route_draft_points WHERE draft_id=? ORDER BY seq",
            (draft_id,),
        ).fetchall()
        step = max(1, -(-len(rows) // MAX_REVIEW_POINTS))
        path = [
            {
                "capturedAtMs": r["captured_at_ms"],
                "latitude": r["latitude"],
                "longitude": r["longitude"],
                "gapBefore": bool(r["gap_before"]),
            }
            for i, r in enumerate(rows)
            if i % step == 0 or r["gap_before"] or i == len(rows) - 1
        ]
        return {**self.summary(draft_id), "stops": self.stops(draft_id), "path": path}

    # ── Writes ───────────────────────────────────────────────────────

    def start(
        self, request_id: object, name: object, direction: object, driver_id: str, now_ms: int
    ) -> dict[str, Any]:
        rid = valid_request_id(request_id)
        name = clean_name(name)
        if direction not in DIRECTIONS:
            raise DraftError("BAD_DIRECTION", "Direction must be to_school or from_school.")
        with self.db.transaction() as tx:
            same = tx.execute(
                "SELECT draft_id FROM route_drafts WHERE request_id=?", (rid,)
            ).fetchone()
            if same is None:
                if tx.execute("SELECT 1 FROM route_drafts WHERE status='recording'").fetchone():
                    raise DraftError("ALREADY_RECORDING", "Another route is being recorded.")
                draft_id = str(uuid.uuid4())
                tx.execute(
                    "INSERT INTO route_drafts(draft_id, request_id, name, direction, status, "
                    "driver_id, started_at_ms) VALUES(?, ?, ?, ?, 'recording', ?, ?)",
                    (draft_id, rid, name, direction, driver_id, now_ms),
                )
            else:
                draft_id = same["draft_id"]
        return self.summary(draft_id)

    def add_point(self, draft_id: str, fix: Fix) -> bool:
        """Appends one sampled fix if it is newer than the last point. Returns
        whether a point was saved."""
        with self.db.transaction() as tx:
            d = tx.execute(
                "SELECT status FROM route_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            if d is None or d["status"] != "recording":
                return False
            last = tx.execute(
                "SELECT seq, captured_at_ms FROM route_draft_points WHERE draft_id=? "
                "ORDER BY seq DESC LIMIT 1",
                (draft_id,),
            ).fetchone()
            if last is not None and fix.captured_at_ms <= last["captured_at_ms"]:
                return False
            gap = last is not None and fix.captured_at_ms - last["captured_at_ms"] > GAP_MS
            tx.execute(
                "INSERT INTO route_draft_points(draft_id, seq, captured_at_ms, latitude, "
                "longitude, horizontal_accuracy_m, gap_before) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    draft_id,
                    0 if last is None else last["seq"] + 1,
                    fix.captured_at_ms,
                    fix.latitude,
                    fix.longitude,
                    fix.horizontal_accuracy_m,
                    int(gap),
                ),
            )
        return True

    def _editable(self, tx: sqlite3.Connection, draft_id: str) -> None:
        d = tx.execute("SELECT status FROM route_drafts WHERE draft_id=?", (draft_id,)).fetchone()
        if d is None:
            raise DraftError("NOT_FOUND", "No such draft on this device.")

    def mark_stop(
        self, draft_id: str, request_id: object, name: object, fix: Fix, driver_id: str
    ) -> dict[str, Any]:
        """Adds a stop at the end of the order, at the device's own current fix."""
        rid = valid_request_id(request_id)
        with self.db.transaction() as tx:
            same = tx.execute(
                "SELECT stop_id, draft_id FROM route_draft_stops WHERE request_id=?", (rid,)
            ).fetchone()
            if same is not None:
                if same["draft_id"] != draft_id:
                    raise DraftError("BAD_REQUEST_ID", "requestId already used.")
                stop_id = same["stop_id"]
            else:
                d = tx.execute(
                    "SELECT status FROM route_drafts WHERE draft_id=?", (draft_id,)
                ).fetchone()
                if d is None:
                    raise DraftError("NOT_FOUND", "No such draft on this device.")
                if d["status"] != "recording":
                    raise DraftError("NOT_RECORDING", "Stops are marked while recording.")
                n = tx.execute(
                    "SELECT COUNT(*) AS n FROM route_draft_stops WHERE draft_id=?", (draft_id,)
                ).fetchone()["n"]
                stop_id = str(uuid.uuid4())
                tx.execute(
                    "INSERT INTO route_draft_stops(stop_id, draft_id, request_id, position, name, "
                    "latitude, longitude, captured_at_ms, marked_by_driver_id) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        stop_id,
                        draft_id,
                        rid,
                        n + 1,
                        clean_name(name, fallback=f"Stop {n + 1}"),
                        fix.latitude,
                        fix.longitude,
                        fix.captured_at_ms,
                        driver_id,
                    ),
                )
        return next(s for s in self.stops(draft_id) if s["stopId"] == stop_id)

    def rename_stop(self, draft_id: str, stop_id: str, name: object) -> None:
        name = clean_name(name)
        with self.db.transaction() as tx:
            self._editable(tx, draft_id)
            cur = tx.execute(
                "UPDATE route_draft_stops SET name=? WHERE stop_id=? AND draft_id=?",
                (name, stop_id, draft_id),
            )
            if cur.rowcount != 1:
                raise DraftError("NOT_FOUND", "No such stop in this draft.")

    def move_stop(self, draft_id: str, stop_id: str, position: object) -> None:
        """Moves a stop to 1-based `position`; the others keep their relative order."""
        with self.db.transaction() as tx:
            self._editable(tx, draft_id)
            ids = [
                r["stop_id"]
                for r in tx.execute(
                    "SELECT stop_id FROM route_draft_stops WHERE draft_id=? ORDER BY position",
                    (draft_id,),
                )
            ]
            if stop_id not in ids:
                raise DraftError("NOT_FOUND", "No such stop in this draft.")
            if not isinstance(position, int) or isinstance(position, bool):
                raise DraftError("BAD_POSITION", "Position must be a whole number.")
            if not 1 <= position <= len(ids):
                raise DraftError("BAD_POSITION", f"Position must be 1-{len(ids)}.")
            ids.remove(stop_id)
            ids.insert(position - 1, stop_id)
            self._renumber(tx, ids)

    def remove_stop(self, draft_id: str, stop_id: str) -> None:
        with self.db.transaction() as tx:
            self._editable(tx, draft_id)
            cur = tx.execute(
                "DELETE FROM route_draft_stops WHERE stop_id=? AND draft_id=?", (stop_id, draft_id)
            )
            if cur.rowcount != 1:
                raise DraftError("NOT_FOUND", "No such stop in this draft.")
            ids = [
                r["stop_id"]
                for r in tx.execute(
                    "SELECT stop_id FROM route_draft_stops WHERE draft_id=? ORDER BY position",
                    (draft_id,),
                )
            ]
            self._renumber(tx, ids)

    @staticmethod
    def _renumber(tx: sqlite3.Connection, ordered_ids: list[str]) -> None:
        for pos, sid in enumerate(ordered_ids, start=1):
            tx.execute("UPDATE route_draft_stops SET position=? WHERE stop_id=?", (pos, sid))

    def finish(self, draft_id: str, now_ms: int) -> dict[str, Any]:
        """Stops sampling. Idempotent: finishing a finished draft changes nothing."""
        with self.db.transaction() as tx:
            self._row(draft_id)
            tx.execute(
                "UPDATE route_drafts SET status='finished', finished_at_ms=? "
                "WHERE draft_id=? AND status='recording'",
                (now_ms, draft_id),
            )
        return self.summary(draft_id)


class DraftSamplerThread(threading.Thread):
    """Adds the latest fresh fix to the recording draft about once a second.
    Sampling continues while driving; only editing needs a stop."""

    def __init__(
        self,
        database_path: Path | str,
        latest: LatestFixHolder,
        stop: threading.Event,
        interval_s: float = 1.0,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(name="draft-sampler", daemon=True)
        self.database_path = database_path
        self.latest = latest
        self.stop_event = stop
        self.interval_s = interval_s
        self.mono = monotonic

    def tick(self, drafts: Drafts) -> bool:
        lf = self.latest.get()
        if lf is None or self.mono() - lf.received_mono > FRESH_S:
            return False
        rec = drafts.recording()
        return rec is not None and drafts.add_point(rec["draftId"], lf.fix)

    def run(self) -> None:
        db = Database(self.database_path)  # opened in this thread
        try:
            drafts = Drafts(db)
            while not self.stop_event.is_set():
                try:
                    self.tick(drafts)
                except Exception:
                    log.exception("draft sampler tick failed")
                self.stop_event.wait(self.interval_s)
        finally:
            db.close()
