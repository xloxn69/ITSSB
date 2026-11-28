"""Selects cloud observations from the latest fix (docs/04 §6-7).

Every publish interval, and only while a server-issued run is active:
take the latest trusted fix if it is fresh (received recently, by monotonic
time) and newer than the last saved observation, then save it and its outbox
row in one transaction. A silent receiver therefore produces no new
observations: we never re-save an old fix as if it were new.

With no active run nothing is recorded (no off-duty tracking).

Storage is measured first on every tick (storage.py). While it is critical,
a fix is saved only if it was captured at least `reduced_interval_s` after the
run's newest saved one; already-queued rows are never touched.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .database import Database, RunNotActive
from .gps_reader import LatestFixHolder
from .status import GPS_FRESH_S, MAX_FUTURE_SKEW_MS, StatusBoard, wall_ms
from .storage import StorageGuard

log = logging.getLogger(__name__)


class Recorder:
    def __init__(
        self,
        db: Database,
        board: StatusBoard,
        latest: LatestFixHolder,
        boot_id: str,
        monotonic: Callable[[], float] = time.monotonic,
        now_ms: Callable[[], int] = wall_ms,
        storage: StorageGuard | None = None,
    ) -> None:
        self.db, self.board, self.latest, self.boot_id = db, board, latest, boot_id
        self.storage = storage
        self._mono = monotonic
        self._now_ms = now_ms
        self.sequence = 0  # per bootId; resets only with a new bootId
        self._last_run: str | None = None

    def tick(self) -> bool:
        """Runs one selection step. Returns True if an observation was saved."""
        run = self.db.active_run()
        if run and run["runId"] != self._last_run:
            log.info("run %s active (nextRunSequence=%s)", run["runId"], run["nextRunSequence"])
        elif not run and self._last_run:
            log.info("no active run; recording paused")
        self._last_run = run["runId"] if run else None

        # Measured before saving, so health shows the cause even when the
        # save itself then fails on a full disk.
        reduced_ms: int | None = None
        if self.storage is not None:
            state = self.storage.check(self.db, self._now_ms())
            self.board.storage(state)
            if state["recording"] == "reduced":
                reduced_ms = int(state["reducedIntervalS"] * 1000)

        saved = False
        if run:
            saved = self._maybe_record(run["runId"], reduced_ms)
        self.refresh_status()
        return saved

    def _maybe_record(self, run_id: str, reduced_ms: int | None = None) -> bool:
        latest = self.latest.get()
        if latest is None or self._mono() - latest.received_mono > GPS_FRESH_S:
            return False
        now = self._now_ms()
        if latest.fix.captured_at_ms > now + MAX_FUTURE_SKEW_MS:
            return False  # never persist a future capture (it would block later ones)
        last = self.db.last_captured_at_ms(run_id, at_most=now + MAX_FUTURE_SKEW_MS)
        if last is not None and latest.fix.captured_at_ms <= last:
            return False  # same measurement epoch (or older) already saved
        if (
            reduced_ms is not None
            and last is not None
            and latest.fix.captured_at_ms - last < reduced_ms
        ):
            return False  # storage critical: slower cadence, nothing queued is dropped
        try:
            event = self.db.record_observation(run_id, latest.fix, self.boot_id, self.sequence)
        except RunNotActive:
            return False  # the run ended between our check and the transaction
        self.sequence += 1
        self.board.recorded(event.fix.captured_at_ms)
        log.debug("saved observation eventId=%s runSequence=%s", event.event_id, event.run_sequence)
        return True

    def refresh_status(self) -> None:
        self.board.run(self.db.active_run())
        self.board.outbox(self.db.outbox_counts())


class RecorderThread(threading.Thread):
    def __init__(
        self, recorder_factory: Callable[[], Recorder], interval_s: float, stop: threading.Event
    ) -> None:
        super().__init__(name="recorder", daemon=True)
        self._factory, self.interval_s, self.stop_event = recorder_factory, interval_s, stop

    def run(self) -> None:
        # The Database is created inside this thread: sqlite3 connections are
        # bound to the thread that opened them.
        recorder = self._factory()
        try:
            while not self.stop_event.is_set():
                try:
                    recorder.tick()
                    recorder.board.recorder_fault(None)
                except Exception as exc:
                    # e.g. disk full: observations are being lost; say so in health.
                    recorder.board.recorder_fault(f"save failed: {type(exc).__name__}")
                    log.exception("recorder tick failed")
                self.stop_event.wait(self.interval_s)
        finally:
            recorder.db.close()
