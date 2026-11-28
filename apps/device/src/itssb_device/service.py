"""The single device process: GPS reader, recorder, uploader, local API (docs/04 §1).

Threads:
- gps-reader: GPSD socket -> latest fix + status (no SQLite)
- recorder:   its own SQLite connection; selects and saves observations
- uploader:   its own SQLite connection; sends the outbox (when configured)
- roster-sync: its own SQLite connection; sends queued driver actions (when configured)
- local-api:  serves the status snapshot (no SQLite)

The main thread installs SIGTERM/SIGINT handlers and waits on a stop event.
On stop it shuts the API down, lets workers finish their current bounded
step, closes their databases, and exits within systemd's TimeoutStopSec.
Every committed write is already durable (WAL, synchronous=FULL), so a hard
kill loses nothing that was acknowledged as saved.
"""

from __future__ import annotations

import logging
import logging.handlers
import signal
import sys
import threading
import uuid
from pathlib import Path

from .api import LocalApiServer
from .config import Config
from .database import Database
from .draft_submit import DraftDesk, DraftSyncThread
from .drafts import DraftSamplerThread
from .driver_api import DriverApi
from .gps_reader import GpsReader
from .local_auth import SessionManager, allowed_origins, load_drivers
from .motion import MotionJudge, ObservedFixHolder
from .recorder import Recorder, RecorderThread
from .status import StatusBoard
from .storage import StorageGuard
from .students import DeviceGrantClient, RosterSyncThread, StudentDesk
from .trips import EndRetryThread, HttpTripEvents
from .uploader import HttpTransport, UploaderThread

log = logging.getLogger("itssb_device")

JOIN_TIMEOUT_S = 15.0
STUDENTS_TIMEOUT_S = 3.0
LOG_FILE_MAX_BYTES = 1_000_000
LOG_FILE_BACKUPS = 3


def setup_logging(level: str, log_file: Path | None) -> None:
    """stderr goes to journald under systemd (bounded by journald retention).
    An optional file log is size-capped with rotation."""
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(name)s: %(message)s")
    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(fmt)
    root.addHandler(stream)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        rotating = logging.handlers.RotatingFileHandler(
            log_file, maxBytes=LOG_FILE_MAX_BYTES, backupCount=LOG_FILE_BACKUPS
        )
        rotating.setFormatter(fmt)
        root.addHandler(rotating)


def prepare_database(path: Path) -> None:
    """Creates the state directory (0700) and runs migrations once, before
    worker threads open their own connections."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    Database(path).close()


class Service:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.boot_id = str(uuid.uuid4())
        self.stop_event = threading.Event()
        self.board = StatusBoard(
            self.boot_id,
            upload_enabled=config.upload_enabled,
            environment=config.environment,
            storage_limits=config.storage_limits,
        )
        self.latest = ObservedFixHolder()
        self.judge = MotionJudge(self.latest)
        self.latest.judge = self.judge
        self._threads: list[threading.Thread] = []
        self.api: LocalApiServer | None = None

    def start(self) -> None:
        cfg = self.config
        prepare_database(cfg.database_path)
        log.info("starting itssb-device bootId=%s config=%s", self.boot_id, cfg.redacted())

        # Restart recovery: report whatever run and queue SQLite already holds.
        # Nothing here creates, completes, or alters a run.
        db = Database(cfg.database_path)
        try:
            run = db.active_run()
            counts = db.outbox_counts()
        finally:
            db.close()
        self.board.run(run)
        self.board.outbox(counts)
        log.info("recovered run=%s outbox=%s", run, counts)

        trip_events = None
        students = None
        draft_desk = None
        roster_wake = threading.Event()
        draft_wake = threading.Event()
        if cfg.upload_enabled:
            assert cfg.device_api_origin and cfg.device_token  # noqa: S101 - upload_enabled
            trip_events = HttpTripEvents(
                HttpTransport(cfg.device_api_origin, cfg.http_timeout_s), cfg.device_token
            )
            # Answered inside the screen's 4 s request timeout, so a slow server
            # still lets the cached roster or code reach the driver.
            students = StudentDesk(
                cfg.database_path,
                DeviceGrantClient(
                    HttpTransport(
                        cfg.device_api_origin, min(cfg.http_timeout_s, STUDENTS_TIMEOUT_S)
                    ),
                    cfg.device_token,
                ),
                wake=roster_wake,
            )
            # Same short timeout: the review-status check answers the screen.
            draft_desk = DraftDesk(
                DeviceGrantClient(
                    HttpTransport(
                        cfg.device_api_origin, min(cfg.http_timeout_s, STUDENTS_TIMEOUT_S)
                    ),
                    cfg.device_token,
                ),
                wake=draft_wake,
            )
        drivers = load_drivers(cfg.drivers_file)
        log.info("driver unlock: %d driver(s) provisioned", len(drivers))
        driver_api = DriverApi(
            self.board,
            SessionManager(drivers),
            self.judge,
            self.latest,
            cfg.database_path,
            cfg.driver_ui_dir,
            allowed_origins(cfg.local_api_port),
            trip_events=trip_events,
            service_timezone=cfg.service_timezone,
            students=students,
            draft_desk=draft_desk,
        )
        if not driver_api.serves_ui:
            log.warning("driver UI not found at %s; serving the status page", cfg.driver_ui_dir)
        self.api = LocalApiServer(
            cfg.local_api_host, cfg.local_api_port, self.board, driver_api=driver_api
        )
        log.info("local api on http://%s:%s", cfg.local_api_host, cfg.local_api_port)

        self._threads.append(
            GpsReader(cfg.gpsd_host, cfg.gpsd_port, self.board, self.latest, self.stop_event)
        )
        self._threads.append(
            RecorderThread(
                lambda: Recorder(
                    Database(cfg.database_path),
                    self.board,
                    self.latest,
                    self.boot_id,
                    storage=StorageGuard(cfg.database_path, cfg.storage_limits),
                ),
                cfg.publish_interval_s,
                self.stop_event,
            )
        )
        self._threads.append(DraftSamplerThread(cfg.database_path, self.latest, self.stop_event))
        if trip_events is not None:
            self._threads.append(EndRetryThread(cfg.database_path, trip_events, self.stop_event))
            assert cfg.device_api_origin and cfg.device_token  # noqa: S101 - upload_enabled
            self._threads.append(
                RosterSyncThread(
                    cfg.database_path,
                    DeviceGrantClient(
                        HttpTransport(cfg.device_api_origin, cfg.http_timeout_s), cfg.device_token
                    ),
                    self.stop_event,
                    wake=roster_wake,
                )
            )
            # Full timeout: a whole recording can be a few hundred KB.
            self._threads.append(
                DraftSyncThread(
                    cfg.database_path,
                    DeviceGrantClient(
                        HttpTransport(cfg.device_api_origin, cfg.http_timeout_s), cfg.device_token
                    ),
                    self.stop_event,
                    wake=draft_wake,
                )
            )
        if cfg.upload_enabled:
            self._threads.append(UploaderThread(cfg, self.board, self.stop_event))
        else:
            log.warning("uploads disabled: ITSSB_DEVICE_API_ORIGIN or ITSSB_DEVICE_TOKEN missing")
        for t in self._threads:
            t.start()
        self._threads.append(self.api.start())

    def request_stop(self, signum: int | None = None) -> None:
        if not self.stop_event.is_set():
            log.info("stopping (signal %s)", signum)
        self.stop_event.set()

    def shutdown(self) -> None:
        self.stop_event.set()
        if self.api is not None:
            self.api.shutdown()  # called from main, not the serve_forever thread
            self.api.server_close()
        for t in self._threads:
            t.join(JOIN_TIMEOUT_S)
            if t.is_alive():
                log.warning("thread %s did not stop within %ss", t.name, JOIN_TIMEOUT_S)
        log.info("stopped bootId=%s", self.boot_id)

    def run_forever(self) -> int:
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda signum, _frame: self.request_stop(signum))
        try:
            self.start()
        except OSError as exc:
            log.error("cannot start: %s", exc)
            self.shutdown()
            return 1
        try:
            while not self.stop_event.wait(1.0):
                pass
        finally:
            self.shutdown()
        return 0
