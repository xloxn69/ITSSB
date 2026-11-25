"""Turns GPSD JSON reports into trusted fixes (docs/04 §5).

Receiver reports are not trip data yet. A report becomes a `Fix` only if it
has a coordinate-bearing mode, valid coordinates, and a real GPS timestamp.
Anything else returns a rejection reason for diagnostics; we never invent a
timestamp or a position.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from typing import Any

from .models import Fix

WATCH_COMMAND = b'?WATCH={"enable":true,"json":true};\n'
MAX_LINE_BYTES = 16 * 1024


class Rejected(Exception):
    """A report that must not become an observation. `str(e)` is the reason."""


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _parse_time_ms(value: Any) -> int:
    if not isinstance(value, str):
        raise Rejected("missing time")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Rejected("unparseable time") from exc
    if dt.tzinfo is None:
        raise Rejected("time without timezone")
    return round(dt.timestamp() * 1000)


def parse_line(line: bytes | str) -> dict[str, Any] | None:
    """Parses one GPSD line. Returns None for oversized or malformed input."""
    if len(line) > MAX_LINE_BYTES:
        return None
    try:
        report = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None
    return report if isinstance(report, dict) else None


def fix_from_tpv(report: dict[str, Any]) -> Fix:
    """Converts a TPV report to a Fix, or raises `Rejected` with a reason."""
    if report.get("class") != "TPV":
        raise Rejected("not a TPV report")

    mode = report.get("mode")
    if mode not in (2, 3):
        raise Rejected("no fix")

    lat, lon = _finite(report.get("lat")), _finite(report.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise Rejected("invalid coordinates")

    speed = _finite(report.get("speed"))
    if speed is not None and speed < 0:
        speed = None
    heading = _finite(report.get("track"))
    if heading is not None and not (0 <= heading < 360):
        heading = None
    # eph is GPSD's estimated horizontal position error in meters (not HDOP).
    accuracy = _finite(report.get("eph"))
    if accuracy is not None and accuracy < 0:
        accuracy = None

    return Fix(
        captured_at_ms=_parse_time_ms(report.get("time")),
        latitude=lat,
        longitude=lon,
        speed_mps=speed,
        heading_degrees=heading,
        horizontal_accuracy_m=accuracy,
        fix_mode=mode,
    )
