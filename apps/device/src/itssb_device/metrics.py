"""Process and system measurements for health (docs/04 §12, docs/13 §10).

Each value is read from what the operating system reports right now and is
`None` when it cannot be measured here: the Linux files are absent (macOS
development), unreadable, or hold something that does not parse as a sane
value. Nothing is estimated, clamped, or carried over from an earlier read.

- `processRssBytes`: resident memory of this process (`/proc/self/status`
  VmRSS). Not `ru_maxrss`, which is a peak and in different units per OS.
- `memAvailableBytes`: memory the kernel says is available for new work
  (`/proc/meminfo` MemAvailable).
- `cpuTemperatureC`: SoC temperature (`/sys/class/thermal/thermal_zone0/temp`,
  millidegrees Celsius), rounded to 0.1 °C.
- `databaseBytes`: the SQLite file plus its write-ahead log, to watch growth.
"""

from __future__ import annotations

import math
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

# Outside this range a thermal reading is a broken sensor, not a temperature.
MIN_PLAUSIBLE_C = -40.0
MAX_PLAUSIBLE_C = 150.0

SYSTEM_KEYS = ("processRssBytes", "memAvailableBytes", "cpuTemperatureC", "databaseBytes")


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="ascii", errors="strict")
    except (OSError, UnicodeDecodeError):
        return None


def _kib_field(text: str | None, name: str) -> int | None:
    """`Name:   1234 kB` -> bytes, from /proc/self/status or /proc/meminfo."""
    if text is None:
        return None
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key != name:
            continue
        parts = rest.split()
        if len(parts) != 2 or parts[1] != "kB" or not parts[0].isdigit():
            return None
        return int(parts[0]) * 1024
    return None


def process_rss_bytes(proc: Path = Path("/proc")) -> int | None:
    return _kib_field(_read(proc / "self" / "status"), "VmRSS")


def mem_available_bytes(proc: Path = Path("/proc")) -> int | None:
    return _kib_field(_read(proc / "meminfo"), "MemAvailable")


def cpu_temperature_c(sys_root: Path = Path("/sys")) -> float | None:
    raw = _read(sys_root / "class" / "thermal" / "thermal_zone0" / "temp")
    if raw is None:
        return None
    text = raw.strip()
    if not text.removeprefix("-").isdigit():
        return None  # empty, fractional, or garbage: not a reading
    celsius = int(text) / 1000
    if not math.isfinite(celsius) or not MIN_PLAUSIBLE_C <= celsius <= MAX_PLAUSIBLE_C:
        return None
    return round(celsius, 1)


def database_bytes(db_path: Path | None) -> int | None:
    """Main file plus WAL. `None` when the main file cannot be measured."""
    if db_path is None:
        return None
    try:
        total = os.stat(db_path).st_size
    except OSError:
        return None
    try:
        total += os.stat(f"{db_path}-wal").st_size
    except FileNotFoundError:
        pass  # checkpointed and removed: no WAL to count
    except OSError:
        return None
    return total


def unmeasured() -> dict[str, Any]:
    """The `system` section when no probe is wired (tests, tools)."""
    return dict.fromkeys(SYSTEM_KEYS)


class SystemProbe:
    """Reads the `system` section on demand. Paths are injectable for tests."""

    def __init__(
        self,
        db_path: Path | None,
        proc: Path = Path("/proc"),
        sys_root: Path = Path("/sys"),
    ) -> None:
        self.db_path = db_path
        self.proc = proc
        self.sys_root = sys_root

    def read(self) -> dict[str, Any]:
        return {
            "processRssBytes": process_rss_bytes(self.proc),
            "memAvailableBytes": mem_available_bytes(self.proc),
            "cpuTemperatureC": cpu_temperature_c(self.sys_root),
            "databaseBytes": database_bytes(self.db_path),
        }


SystemReader = Callable[[], dict[str, Any]]
