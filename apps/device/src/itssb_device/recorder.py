"""Selects cloud observations from the latest fix (docs/04 §6-7).

Every publish interval, and only while a server-issued run is active:
take the latest trusted fix if it is fresh (received recently, by monotonic
time) and newer than the last saved observation, then save it and its outbox
row in one transaction. A silent receiver therefore produces no new
observations: we never re-save an old fix as if it were new.

With no active run nothing is recorded (no off-duty tracking).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .database import Database, RunNotActive
from .gps_reader import LatestFixHolder
from .status import GPS_FRESH_S, StatusBoard

log = logging.getLogger(__name__)


class Recorder:
    def __init__(
        self,
        db: Database,
        board: StatusBoard,
        latest: LatestFixHolder,
        boot_id: str,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.db, self.board, self.latest, self.boot_id = db, board, latest, boot_id
        self._mono = monotonic
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

        saved = False
        if run:
            saved = self._maybe_record(run["runId"])
        self.refresh_status()
        return saved

    def _maybe_record(self, run_id: str) -> bool:
        latest = self.latest.get()
        if latest is None or self._mono() - latest.received_mono > GPS_FRESH_S:
            return False
        last = self.db.last_captured_at_ms(run_id)
        if last is not None and latest.fix.captured_at_ms <= last:
            return False  # same measurement epoch (or older) already saved
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
                except Exception:
                    log.exception("recorder tick failed")
                self.stop_event.wait(self.interval_s)
        finally:
            recorder.db.close()
