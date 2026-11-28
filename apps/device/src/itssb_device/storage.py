"""Storage budget and degraded recording (docs/04 §8, docs/13 D12).

Every recorder tick measures two things before it tries to save:

- free space on the database volume (what a non-root process may still use)
- how many outbox rows are still waiting for the server (`pending`)

Each has a warning and a critical threshold. Warning only reports. Critical
reduces recording: an active run saves at most one position every
`reduced_interval_s` (by capture time) instead of every publish interval, so
the bus keeps a slower but honest trail while the queue drains or space
returns. Recording returns to normal on the first tick below critical.

Nothing here ever deletes, rewrites, or acknowledges a pending or rejected
row. The only cleanup removes rows the server already acknowledged, outside
the active run and the most recently ended run (the trip summary counts
those). SQLite reuses the freed pages, so the file stops growing; it does
not shrink, and VACUUM is never run (it needs free space the size of the
database, exactly when there is none).
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple

from .database import Database

log = logging.getLogger(__name__)

MB = 1_000_000
# Acknowledged rows removed per cleanup transaction, so a large cleanup never
# holds the write lock long enough to stall the uploader or the screen.
PRUNE_BATCH = 2000
PRUNE_EVERY_S = 3600.0  # while storage is ok
PRUNE_EVERY_LOW_S = 300.0  # while space is low


class DiskUsage(NamedTuple):
    total: int
    used: int
    free: int


@dataclass(frozen=True, slots=True)
class StorageLimits:
    warn_free_bytes: int = 512 * MB
    critical_free_bytes: int = 128 * MB
    warn_pending: int = 10_000
    critical_pending: int = 50_000
    reduced_interval_s: float = 60.0
    acknowledged_retention_ms: int = 7 * 24 * 3600 * 1000


_ORDER = {"unknown": 0, "ok": 1, "warning": 2, "critical": 3}


def _level(value: int | None, warn: int, critical: int, *, below: bool) -> str:
    if value is None:
        return "unknown"
    if below:
        return "critical" if value <= critical else "warning" if value <= warn else "ok"
    return "critical" if value >= critical else "warning" if value >= warn else "ok"


def assess(
    free_bytes: int | None,
    total_bytes: int | None,
    pending: int | None,
    limits: StorageLimits,
    disk_error: str | None = None,
) -> dict[str, Any]:
    """The health `storage` section. `level` is the worse of disk and queue;
    an unmeasured part never lowers it and never reduces recording."""
    disk = _level(free_bytes, limits.warn_free_bytes, limits.critical_free_bytes, below=True)
    queue = _level(pending, limits.warn_pending, limits.critical_pending, below=False)
    level = max(disk, queue, key=_ORDER.__getitem__)
    return {
        "level": level,
        "recording": "reduced" if level == "critical" else "normal",
        "reducedIntervalS": limits.reduced_interval_s,
        "disk": {
            "level": disk,
            "freeBytes": free_bytes,
            "totalBytes": total_bytes,
            "warnFreeBytes": limits.warn_free_bytes,
            "criticalFreeBytes": limits.critical_free_bytes,
            "error": disk_error,
        },
        "queue": {
            "level": queue,
            "pending": pending,
            "warnPending": limits.warn_pending,
            "criticalPending": limits.critical_pending,
        },
    }


def unmeasured(limits: StorageLimits) -> dict[str, Any]:
    """Before the first check: unknown, never a healthy default."""
    return assess(None, None, None, limits)


class StorageGuard:
    """Measures storage for the recorder and runs acknowledged-row cleanup."""

    def __init__(
        self,
        db_path: Path,
        limits: StorageLimits | None = None,
        disk_usage: Callable[[Path], DiskUsage] = shutil.disk_usage,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.db_path = Path(db_path)
        self.limits = limits or StorageLimits()
        self._disk_usage = disk_usage
        self._mono = monotonic
        self._next_prune_mono: float | None = None  # None: prune on the first check
        self._last_prune: dict[str, Any] = {"atMs": None, "removed": None}
        self._last_level = "unknown"

    def check(self, db: Database, now_ms: int) -> dict[str, Any]:
        """One measurement, plus cleanup when it is due. Never raises for a
        failed disk measurement: that part reads `unknown`."""
        try:
            # The directory always exists; the file may be mid-migration.
            usage = self._disk_usage(self.db_path.parent)
            free, total, err = int(usage.free), int(usage.total), None
        except OSError as exc:
            free, total, err = None, None, type(exc).__name__
        pending = db.outbox_counts()["pending"]
        result = assess(free, total, pending, self.limits, err)
        self._maybe_prune(db, now_ms, result["disk"]["level"])
        result["lastCleanup"] = dict(self._last_prune)
        if result["level"] != self._last_level:
            log.warning(
                "storage %s -> %s (free=%s pending=%s recording=%s)",
                self._last_level,
                result["level"],
                free,
                pending,
                result["recording"],
            )
            self._last_level = result["level"]
        return result

    def _maybe_prune(self, db: Database, now_ms: int, disk_level: str) -> None:
        low = disk_level in ("warning", "critical")
        mono = self._mono()
        if self._next_prune_mono is not None and mono < self._next_prune_mono:
            return
        # With space low, every acknowledged row outside the protected runs
        # goes, whatever its age: the server already holds it.
        cutoff = now_ms if low else now_ms - self.limits.acknowledged_retention_ms
        try:
            removed = db.prune_acknowledged(cutoff, PRUNE_BATCH)
        except sqlite3.Error as exc:
            # A failed cleanup must never stop recording; retry later.
            log.warning("storage cleanup failed: %s", type(exc).__name__)
            self._last_prune = {"atMs": now_ms, "removed": None, "error": type(exc).__name__}
            self._next_prune_mono = mono + PRUNE_EVERY_LOW_S
            return
        self._last_prune = {"atMs": now_ms, "removed": removed}
        if removed:
            log.info("storage cleanup removed %d acknowledged rows", removed)
        # A full batch means more is waiting: continue on the next tick.
        wait = 0.0 if removed >= PRUNE_BATCH else PRUNE_EVERY_LOW_S if low else PRUNE_EVERY_S
        self._next_prune_mono = mono + wait
