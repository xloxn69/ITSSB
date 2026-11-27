"""Thread-safe operating snapshot behind the local health API (docs/04 §12, docs/15 §4).

GPS, network, and backend are separate attributes. Each one says what was
actually measured and when; `unknown` is the honest value before anything
has been tried. Nothing here holds coordinates, tokens, or student data,
so the snapshot is safe to show on the kiosk or paste into a bug report.

Ages use `time.monotonic()` (a wall clock can jump); persisted/shared
timestamps use UTC epoch milliseconds.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import __version__

# A valid fix older than this (by local receipt time) no longer counts as `valid`.
GPS_FRESH_S = 5.0
# Capture-time plausibility against this device's clock. The future bound
# matches the backend's MAX_FUTURE_SKEW_MS (packages/contracts validate.ts).
MAX_FUTURE_SKEW_MS = 2 * 60 * 1000
MAX_CAPTURE_AGE_MS = 30 * 1000


def wall_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass
class _Gps:
    gpsd: str = "connecting"  # connecting | connected | unreachable
    gpsd_error: str | None = None
    receivers: int | None = None  # from GPSD's DEVICES report; None = not reported yet
    last_report_mono: float | None = None
    last_report_ms: int | None = None
    last_fix_mono: float | None = None
    last_fix_captured_ms: int | None = None
    last_fix_mode: int | None = None
    last_reject_reason: str | None = None


@dataclass
class _Link:
    status: str = "unknown"
    detail: str | None = None
    last_checked_ms: int | None = None
    last_success_ms: int | None = None
    http_status: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class StatusBoard:
    def __init__(
        self,
        boot_id: str,
        upload_enabled: bool,
        monotonic: Callable[[], float] = time.monotonic,
        now_ms: Callable[[], int] = wall_ms,
    ) -> None:
        self._lock = threading.Lock()
        self._mono = monotonic
        self._now_ms = now_ms
        self.boot_id = boot_id
        self._started_mono = monotonic()
        self._started_ms = now_ms()
        self._gps = _Gps()
        self._network = _Link()
        self._backend = _Link(status="unknown" if upload_enabled else "unconfigured")
        self._outbox: dict[str, Any] = {
            "pending": None,
            "acknowledged": None,
            "rejected": None,
            "oldestPendingCapturedAtMs": None,
        }
        self._run: dict[str, Any] | None = None
        self._recorder: dict[str, Any] = {
            "lastRecordedAtMs": None,
            "observationsThisBoot": 0,
            "fault": None,
            "faultSinceMs": None,
        }

    # ── Writers (called from worker threads) ─────────────────────────

    def gpsd_state(self, state: str, error: str | None = None) -> None:
        with self._lock:
            self._gps.gpsd = state
            self._gps.gpsd_error = error
            if state != "connected":
                self._gps.receivers = None

    def gps_receivers(self, count: int) -> None:
        with self._lock:
            self._gps.receivers = count

    def gps_report(self) -> None:
        with self._lock:
            self._gps.last_report_mono = self._mono()
            self._gps.last_report_ms = self._now_ms()

    def gps_fix(self, captured_at_ms: int, fix_mode: int) -> None:
        with self._lock:
            self._gps.last_fix_mono = self._mono()
            self._gps.last_fix_captured_ms = captured_at_ms
            self._gps.last_fix_mode = fix_mode
            self._gps.last_reject_reason = None

    def gps_rejected(self, reason: str) -> None:
        with self._lock:
            self._gps.last_reject_reason = reason

    def network(self, status: str, detail: str | None = None) -> None:
        with self._lock:
            n = self._network
            n.status, n.detail, n.last_checked_ms = status, detail, self._now_ms()
            if status == "online":
                n.last_success_ms = n.last_checked_ms

    def backend(
        self, status: str, detail: str | None = None, http_status: int | None = None, **extra: Any
    ) -> None:
        with self._lock:
            b = self._backend
            b.status, b.detail, b.http_status = status, detail, http_status
            b.last_checked_ms = self._now_ms()
            if status == "ok":
                b.last_success_ms = b.last_checked_ms
            b.extra = dict(extra)

    def outbox(self, counts: dict[str, Any]) -> None:
        with self._lock:
            self._outbox = dict(counts)

    def run(self, run: dict[str, Any] | None) -> None:
        with self._lock:
            self._run = dict(run) if run else None

    def recorded(self, captured_at_ms: int) -> None:
        with self._lock:
            self._recorder["lastRecordedAtMs"] = captured_at_ms
            self._recorder["observationsThisBoot"] += 1

    def recorder_fault(self, fault: str | None) -> None:
        """A failed save is an operational fault, shown until a save succeeds."""
        with self._lock:
            r = self._recorder
            if fault is None:
                r["fault"], r["faultSinceMs"] = None, None
            elif r["fault"] is None:
                r["fault"], r["faultSinceMs"] = fault, self._now_ms()
            else:
                r["fault"] = fault

    # ── Reader ───────────────────────────────────────────────────────

    def _gps_status(self) -> str:
        g = self._gps
        if g.gpsd != "connected":
            return "unknown"  # can't know anything about the receiver without GPSD
        if g.receivers == 0:
            return "receiver_missing"
        if g.last_fix_mono is not None and self._mono() - g.last_fix_mono <= GPS_FRESH_S:
            return "valid"
        return "no_fix"

    def _age_ms(self, mono: float | None) -> int | None:
        return None if mono is None else int((self._mono() - mono) * 1000)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            g = self._gps
            return {
                "schemaVersion": 1,
                "generatedAtMs": self._now_ms(),
                "process": {
                    "version": __version__,
                    "bootId": self.boot_id,
                    "startedAtMs": self._started_ms,
                    "uptimeS": int(self._mono() - self._started_mono),
                },
                "gps": {
                    "status": self._gps_status(),
                    "gpsd": g.gpsd,
                    "gpsdError": g.gpsd_error,
                    "receivers": g.receivers,
                    "lastReportAtMs": g.last_report_ms,
                    "lastReportAgeMs": self._age_ms(g.last_report_mono),
                    "lastValidFixCapturedAtMs": g.last_fix_captured_ms,
                    "lastValidFixAgeMs": self._age_ms(g.last_fix_mono),
                    "lastValidFixMode": g.last_fix_mode,
                    "lastRejectReason": g.last_reject_reason,
                },
                "network": {
                    "status": self._network.status,
                    "detail": self._network.detail,
                    "lastCheckedAtMs": self._network.last_checked_ms,
                    "lastOnlineAtMs": self._network.last_success_ms,
                },
                "backend": {
                    "status": self._backend.status,
                    "detail": self._backend.detail,
                    "httpStatus": self._backend.http_status,
                    "lastCheckedAtMs": self._backend.last_checked_ms,
                    "lastOkAtMs": self._backend.last_success_ms,
                    **self._backend.extra,
                },
                "outbox": dict(self._outbox),
                "run": dict(self._run) if self._run else None,
                "recorder": dict(self._recorder),
            }
