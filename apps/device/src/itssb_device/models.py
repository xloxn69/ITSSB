"""Internal models. Wire field names follow docs/08_DATA_CONTRACTS_AND_API.md."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal

FixMode = Literal[2, 3]


@dataclass(frozen=True, slots=True)
class Fix:
    """A usable GPS fix, not yet tied to a run."""

    captured_at_ms: int
    latitude: float
    longitude: float
    speed_mps: float | None
    heading_degrees: float | None
    horizontal_accuracy_m: float | None
    fix_mode: FixMode


@dataclass(frozen=True, slots=True)
class TelemetryEvent:
    """One selected observation, persisted before upload. Immutable once created."""

    event_id: str
    boot_id: str
    sequence: int
    run_sequence: int
    run_id: str
    fix: Fix

    def to_wire(self) -> dict[str, Any]:
        f = asdict(self.fix)
        return {
            "eventId": self.event_id,
            "bootId": self.boot_id,
            "sequence": self.sequence,
            "runSequence": self.run_sequence,
            "runId": self.run_id,
            "capturedAtMs": f["captured_at_ms"],
            "latitude": f["latitude"],
            "longitude": f["longitude"],
            # Nullable fields are sent explicitly as null, never omitted.
            "speedMps": f["speed_mps"],
            "headingDegrees": f["heading_degrees"],
            "horizontalAccuracyM": f["horizontal_accuracy_m"],
            "fixMode": f["fix_mode"],
        }
