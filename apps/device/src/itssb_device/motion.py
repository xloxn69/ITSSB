"""Motion and the driver-confirmed Parked state (docs/05 §3, docs/04 §13).

`parked` means: the driver confirmed a safe stop AND the current fix does
not contradict it. GPS speed alone never sets it (the equipment has no gear
or ignition input), and unknown motion never keeps it:

- moving:  a fresh fix faster than MOVING_MPS
- stopped: a fresh fix at or below MOVING_MPS
- unknown: no fresh fix, or the fix has no speed

Confirming parked needs `stopped`. Any `moving` or `unknown` observation
clears it, and it stays cleared until the driver confirms again. Every fix
is fed in as it arrives, so a short burst of movement between two API reads
still un-parks.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any, Literal

from .gps_reader import LatestFixHolder
from .models import Fix

MotionState = Literal["moving", "stopped", "unknown"]

# About 3.6 km/h: above GPS speed jitter at rest, below any real bus movement.
MOVING_MPS = 1.0
# Same freshness window as the health snapshot's `valid` GPS status.
FIX_FRESH_S = 5.0


class MotionJudge:
    def __init__(
        self, latest: LatestFixHolder, monotonic: Callable[[], float] = time.monotonic
    ) -> None:
        self._latest = latest
        self._mono = monotonic
        self._lock = threading.Lock()
        self._parked_since_mono: float | None = None
        self._parked_since_ms: int | None = None
        self._last_fed_mono: float | None = None

    def _classify(self, fix: Fix | None, received_mono: float | None) -> MotionState:
        if fix is None or received_mono is None:
            return "unknown"
        if self._mono() - received_mono > FIX_FRESH_S or fix.speed_mps is None:
            return "unknown"
        return "moving" if fix.speed_mps > MOVING_MPS else "stopped"

    def _current(self) -> MotionState:
        lf = self._latest.get()
        return self._classify(lf.fix if lf else None, lf.received_mono if lf else None)

    def feed(self, fix: Fix, received_mono: float) -> None:
        """Called for every new fix, so movement between reads is never missed.
        A gap longer than the freshness window was unknown motion, even if
        nobody looked during it."""
        with self._lock:
            gap = (
                self._last_fed_mono is not None
                and received_mono - self._last_fed_mono > FIX_FRESH_S
            )
            self._last_fed_mono = received_mono
        if gap or self._classify(fix, received_mono) != "stopped":
            self.clear()

    def observe(self) -> MotionState:
        """Re-evaluates against the clock (a fix can go stale with no new fix)."""
        state = self._current()
        if state != "stopped":
            self.clear()
        return state

    def state(self) -> MotionState:
        return self.observe()

    def confirm_parked(self, now_ms: int | None = None) -> bool:
        """The driver's explicit confirmation. Refused unless a fresh fix says stopped."""
        with self._lock:
            if self._current() != "stopped":
                self._parked_since_mono = self._parked_since_ms = None
                return False
            if self._parked_since_mono is None:
                self._parked_since_mono = self._mono()
                self._parked_since_ms = now_ms if now_ms is not None else time.time_ns() // 10**6
            return True

    def clear(self) -> None:
        with self._lock:
            self._parked_since_mono = self._parked_since_ms = None

    def parked(self) -> bool:
        self.observe()
        with self._lock:
            return self._parked_since_mono is not None

    def snapshot(self) -> dict[str, Any]:
        state = self.observe()
        with self._lock:
            return {
                "state": state,
                "parked": self._parked_since_mono is not None,
                "parkedSinceMs": self._parked_since_ms,
            }


class ObservedFixHolder(LatestFixHolder):
    """The latest-fix slot, also telling the motion judge about every fix."""

    def __init__(self) -> None:
        super().__init__()
        self.judge: MotionJudge | None = None

    def set(self, fix: Fix, received_mono: float) -> None:
        super().set(fix, received_mono)
        if self.judge is not None:
            self.judge.feed(fix, received_mono)
