"""Local SQLite state and outbox (docs/04 §7-8).

A selected observation and its outbox row are written in ONE transaction, so
an observation is either fully saved and queued, or not saved at all.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from .drafts_schema import DRAFTS_MIGRATION, REVIEW_ROTATION_MIGRATION, SUBMISSIONS_MIGRATION
from .models import Fix, TelemetryEvent

MIGRATIONS: list[str] = [
    # 1: runs, telemetry, outbox
    """
    CREATE TABLE local_runs (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('scheduled','active','completed','cancelled')),
        next_run_sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE telemetry_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES local_runs(run_id),
        run_sequence INTEGER NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        UNIQUE (run_id, run_sequence)
    );
    CREATE TABLE outbox (
        event_id TEXT PRIMARY KEY REFERENCES telemetry_events(event_id),
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','acknowledged','rejected')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    );
    CREATE INDEX outbox_pending ON outbox(status, next_attempt_at_ms);
    """,
    # 2: online run-start requests; requestId is saved before sending (docs/04 §10)
    """
    CREATE TABLE run_start_requests (
        request_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','accepted','rejected')),
        run_id TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL
    );
    """,
    # 3: route recording drafts with ordered stops (docs/05 §6)
    DRAFTS_MIGRATION,
    # 4: end-of-run commands, saved with the local completion (docs/08 §6)
    """
    CREATE TABLE run_end_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES local_runs(run_id),
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','accepted','rejected')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER
    );
    """,
    # 5: route points remember their heading and whether they mark a turn,
    # so thinning never removes a corner
    """
    ALTER TABLE route_draft_points ADD COLUMN heading_degrees REAL;
    ALTER TABLE route_draft_points ADD COLUMN corner INTEGER NOT NULL DEFAULT 0;
    """,
    # 6: route drafts submitted for staff review, queued until the server answers
    SUBMISSIONS_MIGRATION,
    # 7: review-status reads rotate by a counter, not the wall clock
    REVIEW_ROTATION_MIGRATION,
    # 8: runs the school cancelled, learned from the server (docs/13 D14).
    # Separate from run_end_requests: nothing is sent for them.
    """
    CREATE TABLE run_cancellations (
        run_id TEXT PRIMARY KEY REFERENCES local_runs(run_id),
        cancelled_at_ms INTEGER,
        noted_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('health','telemetry'))
    );
    """,
]

# The most recently ended run, by driver end or school cancellation. Runs are
# inserted at start and only one is active at a time, so start order is end
# order. The trip summary and pruning share this so they agree.
LAST_ENDED_RUN_SQL = (
    "SELECT run_id FROM local_runs WHERE run_id IN (SELECT run_id FROM run_end_requests) "
    "OR run_id IN (SELECT run_id FROM run_cancellations) ORDER BY rowid DESC LIMIT 1"
)


class RunNotActive(Exception):
    pass


class GuardRefused(Exception):
    """A write's precondition (for example Parked) no longer holds once the
    write lock is held; the transaction is rolled back."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.conn = sqlite3.connect(path, isolation_level=None, timeout=5.0)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA synchronous=FULL")
        # Optional check run right after BEGIN IMMEDIATE, i.e. after any wait
        # for another writer. Raise GuardRefused to roll the write back.
        self.write_guard: Callable[[], None] | None = None
        self._migrate()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            if self.write_guard is not None:
                self.write_guard()
            yield self.conn
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        self.conn.execute("COMMIT")

    def _migrate(self) -> None:
        current = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for version, sql in enumerate(MIGRATIONS[current:], start=current + 1):
            with self.transaction() as tx:
                for statement in filter(str.strip, sql.split(";")):
                    tx.execute(statement)
                tx.execute(f"PRAGMA user_version={version}")

    # ── Runs ──────────────────────────────────────────────────────────

    def save_run(self, run_id: str, state: str) -> None:
        """Commits a server-issued run identity before normal operation continues."""
        with self.transaction() as tx:
            tx.execute(
                "INSERT INTO local_runs(run_id, state) VALUES(?, ?) "
                "ON CONFLICT(run_id) DO UPDATE SET state=excluded.state",
                (run_id, state),
            )

    def active_run_id(self) -> str | None:
        row = self.conn.execute("SELECT run_id FROM local_runs WHERE state='active'").fetchone()
        return row["run_id"] if row else None

    def active_run(self) -> dict | None:
        """The persisted active run, if any. Restart recovery reads this; it is
        never created implicitly."""
        row = self.conn.execute(
            "SELECT run_id, state, next_run_sequence FROM local_runs WHERE state='active'"
        ).fetchone()
        if row is None:
            return None
        return {
            "runId": row["run_id"],
            "state": row["state"],
            "nextRunSequence": row["next_run_sequence"],
        }

    def last_captured_at_ms(self, run_id: str, at_most: int | None = None) -> int | None:
        """Newest saved capture time for the run. `at_most` ignores implausible
        future rows (saved before plausibility checks existed or under a wrong
        clock) so they can't block every later observation."""
        if at_most is None:
            row = self.conn.execute(
                "SELECT MAX(captured_at_ms) AS m FROM telemetry_events WHERE run_id=?", (run_id,)
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT MAX(captured_at_ms) AS m FROM telemetry_events "
                "WHERE run_id=? AND captured_at_ms<=?",
                (run_id, at_most),
            ).fetchone()
        return row["m"]

    def save_start_request(self, request_id: str, payload: dict, created_at_ms: int) -> None:
        """Persists a start request once; a retry with the same requestId is a no-op."""
        with self.transaction() as tx:
            tx.execute(
                "INSERT OR IGNORE INTO run_start_requests(request_id, payload, created_at_ms) "
                "VALUES(?, ?, ?)",
                (request_id, json.dumps(payload, separators=(",", ":")), created_at_ms),
            )

    def pending_start_request(self) -> dict | None:
        row = self.conn.execute(
            "SELECT payload FROM run_start_requests WHERE status='pending' ORDER BY rowid LIMIT 1"
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def resolve_start_request(
        self, request_id: str, accepted_run_id: str | None, error: str | None = None
    ) -> None:
        """Accepted: record the server-issued run as active in the same transaction.
        Rejected: keep the request with its reason. Never creates a run otherwise."""
        with self.transaction() as tx:
            if accepted_run_id:
                tx.execute(
                    "UPDATE run_start_requests SET status='accepted', run_id=?, last_error=NULL "
                    "WHERE request_id=?",
                    (accepted_run_id, request_id),
                )
                tx.execute(
                    # A known scheduled run becomes active; a completed or
                    # cancelled one is never reactivated by a late answer.
                    "INSERT INTO local_runs(run_id, state) VALUES(?, 'active') "
                    "ON CONFLICT(run_id) DO UPDATE SET state='active' "
                    "WHERE local_runs.state='scheduled'",
                    (accepted_run_id,),
                )
            else:
                tx.execute(
                    "UPDATE run_start_requests SET status='rejected', last_error=? "
                    "WHERE request_id=?",
                    (error, request_id),
                )

    def pending_start(self) -> dict | None:
        """The start request still waiting for an answer, with its requestId."""
        row = self.conn.execute(
            "SELECT request_id, payload, created_at_ms FROM run_start_requests "
            "WHERE status='pending' ORDER BY rowid LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return {
            "requestId": row["request_id"],
            "payload": json.loads(row["payload"]),
            "createdAtMs": row["created_at_ms"],
        }

    def start_request(self, request_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT status, run_id, last_error, payload FROM run_start_requests WHERE request_id=?",
            (request_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "status": row["status"],
            "runId": row["run_id"],
            "code": row["last_error"],
            "payload": json.loads(row["payload"]),
        }

    def last_start_result(self) -> dict | None:
        row = self.conn.execute(
            "SELECT request_id, status, run_id, last_error FROM run_start_requests "
            "ORDER BY rowid DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return {
            "requestId": row["request_id"],
            "status": row["status"],
            "runId": row["run_id"],
            "code": row["last_error"],
        }

    def end_run_locally(
        self, run_id: str, request_id: str, grant: str, captured_at_ms: int
    ) -> dict:
        """In ONE transaction: mark the active run completed, freeze its final
        sequence boundary, and save the endRun command for upload. Telemetry
        insertion re-checks `active`, so nothing is recorded after this.

        Idempotent per run: ending an already-ended run returns its saved
        command instead of building a second one."""
        with self.transaction() as tx:
            existing = tx.execute(
                "SELECT payload FROM run_end_requests WHERE run_id=?", (run_id,)
            ).fetchone()
            if existing is not None:
                return json.loads(existing["payload"])
            row = tx.execute(
                "SELECT next_run_sequence FROM local_runs WHERE run_id=? AND state='active'",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RunNotActive(run_id)
            last = row["next_run_sequence"] - 1
            # The end's capture time must cover every saved observation: GPS
            # time can run slightly ahead of this clock, and the server rejects
            # telemetry captured after the end as late history.
            newest = tx.execute(
                "SELECT MAX(captured_at_ms) AS m FROM telemetry_events WHERE run_id=?", (run_id,)
            ).fetchone()["m"]
            captured_at_ms = max(captured_at_ms, newest or 0)
            payload = {
                "schemaVersion": 1,
                "requestId": request_id,
                "type": "endRun",
                "driverOperatingGrant": grant,
                "runId": run_id,
                "capturedAtMs": captured_at_ms,
                "lastRunSequence": last if last >= 0 else None,
            }
            tx.execute("UPDATE local_runs SET state='completed' WHERE run_id=?", (run_id,))
            tx.execute(
                "INSERT INTO run_end_requests(request_id, run_id, payload, created_at_ms) "
                "VALUES(?, ?, ?, ?)",
                (request_id, run_id, json.dumps(payload, separators=(",", ":")), captured_at_ms),
            )
        return payload

    def pending_end_payloads(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT payload FROM run_end_requests WHERE status='pending' ORDER BY rowid"
        ).fetchall()
        return [json.loads(r["payload"]) for r in rows]

    def resolve_end_request(
        self, request_id: str, status: str | None, error: str | None, now_ms: int
    ) -> None:
        """`status` None = no answer: count the attempt and keep it pending."""
        with self.transaction() as tx:
            if status is None:
                tx.execute(
                    "UPDATE run_end_requests SET attempts=attempts+1, last_error=? "
                    "WHERE request_id=? AND status='pending'",
                    (error, request_id),
                )
            else:
                tx.execute(
                    "UPDATE run_end_requests SET status=?, last_error=?, resolved_at_ms=?, "
                    "attempts=attempts+1 WHERE request_id=? AND status='pending'",
                    (status, error, now_ms, request_id),
                )

    def cancel_run_locally(
        self, run_id: str, cancelled_at_ms: int | None, noted_at_ms: int, source: str
    ) -> bool:
        """The server says the school cancelled this run (docs/13 D14). In ONE
        transaction: end it locally as `cancelled` and record when. Only the
        named run, and only while it is active here; nothing is sent to the
        server and no queued row changes (the server decides each one).
        Returns True if this call ended it."""
        with self.transaction() as tx:
            ended = tx.execute(
                "UPDATE local_runs SET state='cancelled' WHERE run_id=? AND state='active'",
                (run_id,),
            ).rowcount
            if ended:
                tx.execute(
                    "INSERT INTO run_cancellations(run_id, cancelled_at_ms, noted_at_ms, source) "
                    "VALUES(?, ?, ?, ?)",
                    (run_id, cancelled_at_ms, noted_at_ms, source),
                )
        return bool(ended)

    def run_of_event(self, event_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT run_id FROM telemetry_events WHERE event_id=?", (event_id,)
        ).fetchone()
        return row["run_id"] if row else None

    def last_ended_run(self) -> dict | None:
        """The most recently ended run and its sync state, for the trip summary.
        `endedBy` is `driver` (ended here, end sent to the server) or `school`
        (cancelled by staff; nothing to send, `endSync` is `not_needed`)."""
        last = self.conn.execute(LAST_ENDED_RUN_SQL).fetchone()
        if last is None:
            return None
        run_id = last["run_id"]
        counts = self.conn.execute(
            "SELECT COUNT(*) AS events, "
            "COALESCE(SUM(o.status='pending'), 0) AS pending, "
            "COALESCE(SUM(o.status='acknowledged'), 0) AS acknowledged, "
            "COALESCE(SUM(o.status='rejected'), 0) AS rejected "
            "FROM telemetry_events t LEFT JOIN outbox o ON o.event_id=t.event_id "
            "WHERE t.run_id=?",
            (run_id,),
        ).fetchone()
        positions = {
            "positionsRecorded": counts["events"],
            "positionsWaiting": counts["pending"],
            "positionsAccepted": counts["acknowledged"],
            "positionsRejected": counts["rejected"],
        }
        end = self.conn.execute(
            "SELECT status, last_error, attempts, payload FROM run_end_requests WHERE run_id=?",
            (run_id,),
        ).fetchone()
        if end is not None:
            return {
                "runId": run_id,
                "endedBy": "driver",
                "endedAtMs": json.loads(end["payload"])["capturedAtMs"],
                "endSync": end["status"],
                "endError": end["last_error"],
                "endAttempts": end["attempts"],
                **positions,
            }
        c = self.conn.execute(
            "SELECT cancelled_at_ms, noted_at_ms FROM run_cancellations WHERE run_id=?", (run_id,)
        ).fetchone()
        return {
            "runId": run_id,
            "endedBy": "school",
            "endedAtMs": c["noted_at_ms"] if c["cancelled_at_ms"] is None else c["cancelled_at_ms"],
            "cancelledAtMs": c["cancelled_at_ms"],
            "cancelNotedAtMs": c["noted_at_ms"],
            "endSync": "not_needed",
            "endError": None,
            "endAttempts": 0,
            **positions,
        }

    # ── Observations ──────────────────────────────────────────────────

    def record_observation(
        self, run_id: str, fix: Fix, boot_id: str, sequence: int
    ) -> TelemetryEvent:
        """Atomically: check the run is active, reserve runSequence, create the
        eventId once, store the event, and queue its exact payload."""
        with self.transaction() as tx:
            row = tx.execute(
                "SELECT next_run_sequence FROM local_runs WHERE run_id=? AND state='active'",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RunNotActive(run_id)
            run_sequence = row["next_run_sequence"]
            event = TelemetryEvent(
                event_id=str(uuid.uuid4()),
                boot_id=boot_id,
                sequence=sequence,
                run_sequence=run_sequence,
                run_id=run_id,
                fix=fix,
            )
            tx.execute(
                "INSERT INTO telemetry_events(event_id, run_id, run_sequence, captured_at_ms) "
                "VALUES(?, ?, ?, ?)",
                (event.event_id, run_id, run_sequence, fix.captured_at_ms),
            )
            tx.execute(
                "INSERT INTO outbox(event_id, payload) VALUES(?, ?)",
                (event.event_id, json.dumps(event.to_wire(), separators=(",", ":"))),
            )
            tx.execute(
                "UPDATE local_runs SET next_run_sequence=? WHERE run_id=?",
                (run_sequence + 1, run_id),
            )
        return event

    # ── Outbox ────────────────────────────────────────────────────────

    def pending_payloads(
        self, now_ms: int, limit: int = 50, newest_first: bool = False
    ) -> list[dict]:
        """Due pending payloads, oldest first. With `newest_first`, the newest due
        payload leads the list so current tracking resumes immediately after an
        outage while history drains (docs/04 §9). Payloads are byte-for-byte
        what was saved, so retries reuse the same eventId."""
        rows = self.conn.execute(
            "SELECT rowid, payload FROM outbox WHERE status='pending' AND next_attempt_at_ms<=? "
            "ORDER BY rowid LIMIT ?",
            (now_ms, limit),
        ).fetchall()
        if newest_first and rows:
            newest = self.conn.execute(
                "SELECT rowid, payload FROM outbox WHERE status='pending' "
                "AND next_attempt_at_ms<=? ORDER BY rowid DESC LIMIT 1",
                (now_ms,),
            ).fetchone()
            rest = [r for r in rows if r["rowid"] != newest["rowid"]]
            rows = [newest, *rest[: limit - 1]]
        return [json.loads(r["payload"]) for r in rows]

    def prune_acknowledged(self, captured_before_ms: int, limit: int) -> int:
        """Removes up to `limit` acknowledged events captured before the cutoff,
        with their outbox rows. Never touches a pending or rejected row, the
        active (or scheduled) run, or the most recently ended (or cancelled)
        run, whose trip summary counts its rows. Returns how many events were removed."""
        with self.transaction() as tx:
            ids = [
                (r["event_id"],)
                for r in tx.execute(
                    "SELECT o.event_id FROM outbox o JOIN telemetry_events t "  # noqa: S608 - constant SQL
                    "ON t.event_id = o.event_id WHERE o.status='acknowledged' "
                    "AND t.captured_at_ms < ? "
                    "AND t.run_id NOT IN (SELECT run_id FROM local_runs "
                    "  WHERE state IN ('active','scheduled')) "
                    f"AND t.run_id NOT IN ({LAST_ENDED_RUN_SQL}) "
                    "ORDER BY o.rowid LIMIT ?",
                    (captured_before_ms, limit),
                )
            ]
            # Outbox first: it references the event (foreign keys are on).
            tx.executemany("DELETE FROM outbox WHERE event_id=? AND status='acknowledged'", ids)
            tx.executemany("DELETE FROM telemetry_events WHERE event_id=?", ids)
        return len(ids)

    def outbox_counts(self) -> dict:
        counts = {"pending": 0, "acknowledged": 0, "rejected": 0}
        for row in self.conn.execute("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"):
            counts[row["status"]] = row["n"]
        row = self.conn.execute(
            "SELECT MIN(t.captured_at_ms) AS m FROM outbox o "
            "JOIN telemetry_events t ON t.event_id = o.event_id WHERE o.status='pending'"
        ).fetchone()
        return {**counts, "oldestPendingCapturedAtMs": row["m"]}

    def list_outbox(self, limit: int = 100) -> list[dict]:
        """Oldest-first outbox rows for diagnostics (no coordinates)."""
        rows = self.conn.execute(
            "SELECT o.event_id, o.status, o.attempts, o.next_attempt_at_ms, o.last_error, "
            "t.run_id, t.run_sequence, t.captured_at_ms FROM outbox o "
            "JOIN telemetry_events t ON t.event_id = o.event_id ORDER BY o.rowid LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {
                "eventId": r["event_id"],
                "status": r["status"],
                "attempts": r["attempts"],
                "nextAttemptAtMs": r["next_attempt_at_ms"],
                "lastError": r["last_error"],
                "runId": r["run_id"],
                "runSequence": r["run_sequence"],
                "capturedAtMs": r["captured_at_ms"],
            }
            for r in rows
        ]

    def outbox_status(self, event_id: str) -> str | None:
        row = self.conn.execute(
            "SELECT status FROM outbox WHERE event_id=?", (event_id,)
        ).fetchone()
        return row["status"] if row else None
