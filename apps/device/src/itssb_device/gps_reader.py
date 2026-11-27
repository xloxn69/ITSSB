"""GPSD connection, WATCH subscription, bounded reading, and reconnect (docs/04 §5).

Runs in its own thread. It never touches SQLite: it publishes the latest
trusted fix (with its local monotonic receipt time) and updates the status
board. The recorder decides whether a fix becomes an observation.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from .gps import MAX_LINE_BYTES, WATCH_COMMAND, Rejected, fix_from_tpv, parse_line
from .models import Fix
from .status import StatusBoard

log = logging.getLogger(__name__)

DEVICES_COMMAND = b"?DEVICES;\n"
READ_TIMEOUT_S = 1.0
CONNECT_TIMEOUT_S = 5.0
MAX_RECONNECT_S = 30.0


@dataclass(frozen=True, slots=True)
class LatestFix:
    fix: Fix
    received_mono: float


class LatestFixHolder:
    """Single-slot, lock-protected latest fix shared with the recorder."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: LatestFix | None = None

    def set(self, fix: Fix, received_mono: float) -> None:
        with self._lock:
            self._value = LatestFix(fix, received_mono)

    def get(self) -> LatestFix | None:
        with self._lock:
            return self._value


class LineBuffer:
    """Splits a byte stream into lines, discarding any line over the limit
    instead of growing without bound."""

    def __init__(self, limit: int = MAX_LINE_BYTES) -> None:
        self._buf = bytearray()
        self._limit = limit
        self._discarding = False
        self.dropped = 0

    def feed(self, data: bytes) -> list[bytes]:
        lines: list[bytes] = []
        self._buf.extend(data)
        while True:
            nl = self._buf.find(b"\n")
            if nl < 0:
                if len(self._buf) > self._limit:
                    self._buf.clear()
                    if not self._discarding:
                        self.dropped += 1
                    self._discarding = True
                return lines
            line = bytes(self._buf[:nl])
            del self._buf[: nl + 1]
            if self._discarding or len(line) > self._limit:
                if not self._discarding:
                    self.dropped += 1
                self._discarding = False
                continue
            lines.append(line)


class GpsReader(threading.Thread):
    def __init__(
        self,
        host: str,
        port: int,
        board: StatusBoard,
        latest: LatestFixHolder,
        stop: threading.Event,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(name="gps-reader", daemon=True)
        self.host, self.port = host, port
        self.board, self.latest, self.stop_event = board, latest, stop
        self._mono = monotonic
        self._last_reason: str | None = None

    def run(self) -> None:
        delay = 1.0
        while not self.stop_event.is_set():
            try:
                self._session()
                delay = 1.0  # clean EOF after a working session: retry promptly
            except OSError as exc:
                self.board.gpsd_state("unreachable", type(exc).__name__)
                log.warning(
                    "gpsd %s:%s unreachable (%s); retry in %.0fs",
                    self.host,
                    self.port,
                    type(exc).__name__,
                    delay,
                )
            else:
                self.board.gpsd_state("unreachable", "connection closed")
                log.warning("gpsd closed the connection; reconnecting")
            if self.stop_event.wait(delay):
                break
            delay = min(MAX_RECONNECT_S, delay * 2)

    def _session(self) -> None:
        self.board.gpsd_state("connecting")
        with socket.create_connection((self.host, self.port), timeout=CONNECT_TIMEOUT_S) as sock:
            sock.settimeout(READ_TIMEOUT_S)
            sock.sendall(WATCH_COMMAND)
            self.board.gpsd_state("connected")
            log.info("gpsd connected at %s:%s", self.host, self.port)
            buffer = LineBuffer()
            while not self.stop_event.is_set():
                try:
                    data = sock.recv(4096)
                except TimeoutError:
                    continue  # silence is fine; freshness is judged by age
                if not data:
                    return
                for line in buffer.feed(data):
                    self.handle_line(line, sock)

    def handle_line(self, line: bytes, sock: socket.socket | None = None) -> None:
        report = parse_line(line)
        if report is None:
            return
        cls = report.get("class")
        self.board.gps_report()
        if cls == "DEVICES":
            devices = report.get("devices")
            count = len(devices) if isinstance(devices, list) else 0
            self.board.gps_receivers(count)
            if count == 0:
                self._note("receiver missing")
        elif cls == "DEVICE" and sock is not None:
            # A receiver was added or removed; ask for the full list again.
            sock.sendall(DEVICES_COMMAND)
        elif cls == "TPV":
            try:
                fix = fix_from_tpv(report)
            except Rejected as reason:
                self.board.gps_rejected(str(reason))
                self._note(str(reason))
                return
            self.latest.set(fix, self._mono())
            self.board.gps_fix(fix.captured_at_ms, fix.fix_mode)
            self._note(None)

    def _note(self, reason: str | None) -> None:
        """Logs GPS state transitions only, so a long no-fix period writes one
        line instead of one per second (bounded logs)."""
        if reason == self._last_reason:
            return
        self._last_reason = reason
        if reason is None:
            log.info("gps: usable fix")
        else:
            log.info("gps: no usable fix (%s)", reason)
