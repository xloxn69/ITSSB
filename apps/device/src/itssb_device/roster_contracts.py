"""Wire models for the driver-screen student features (docs/08 §9.2).

`POST /device/v1/qr-codes`, `/roster` and `/roster-actions` all carry the
driver operating grant. A roster action is persisted on the Pi with its
`request_id` and `captured_at_ms` before it is sent, shown as "pending sync"
until a result arrives, and retried with the same identity. The backend
rechecks authority at acceptance; a queued action is never assumed accepted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

AttendanceStatus = Literal["boarded", "not_boarded"]
CheckInSource = Literal["student_qr_claim", "staff_recorded", "staff_correction"]
ActionType = Literal["recordAttendance", "correctAttendance", "setSeatNote", "removeAssignment"]
ResultStatus = Literal["accepted", "already_recorded", "superseded", "rejected"]

# Final outcomes. Anything else (no response, 5xx) leaves the action pending.
FINAL_SUCCESS: frozenset[str] = frozenset({"accepted", "already_recorded", "superseded"})


@dataclass(frozen=True, slots=True)
class CheckInRecord:
    check_in_id: str
    status: AttendanceStatus
    source: CheckInSource
    recorded_at_ms: int
    received_at_ms: int

    @staticmethod
    def from_wire(d: dict[str, Any]) -> CheckInRecord:
        return CheckInRecord(
            check_in_id=str(d["checkInId"]),
            status=d["status"],
            source=d["source"],
            recorded_at_ms=int(d["recordedAtMs"]),
            received_at_ms=int(d["receivedAtMs"]),
        )


@dataclass(frozen=True, slots=True)
class RosterStudent:
    assignment_id: str
    student_display_name: str
    stop_id: str
    stop_label: str
    stop_sequence: int
    seat_label: str | None
    driver_note: str | None
    check_in: CheckInRecord | None

    @staticmethod
    def from_wire(d: dict[str, Any]) -> RosterStudent:
        c = d["checkIn"]
        return RosterStudent(
            assignment_id=str(d["assignmentId"]),
            student_display_name=str(d["studentDisplayName"]),
            stop_id=str(d["stopId"]),
            stop_label=str(d["stopLabel"]),
            stop_sequence=int(d["stopSequence"]),
            seat_label=d["seatLabel"],
            driver_note=d["driverNote"],
            check_in=CheckInRecord.from_wire(c) if c is not None else None,
        )


@dataclass(frozen=True, slots=True)
class Roster:
    run_id: str
    route_version_id: str
    students: tuple[RosterStudent, ...]
    server_now_ms: int

    @staticmethod
    def from_wire(d: dict[str, Any]) -> Roster:
        return Roster(
            run_id=str(d["runId"]),
            route_version_id=str(d["routeVersionId"]),
            students=tuple(RosterStudent.from_wire(s) for s in d["students"]),
            server_now_ms=int(d["serverNowMs"]),
        )


@dataclass(frozen=True, slots=True)
class QrCode:
    purpose: Literal["trip_check_in", "route_enrollment"]
    token: str
    link_path: str
    expires_at_ms: int
    server_now_ms: int

    @staticmethod
    def from_wire(d: dict[str, Any]) -> QrCode:
        return QrCode(
            purpose=d["purpose"],
            token=str(d["token"]),
            link_path=str(d["linkPath"]),
            expires_at_ms=int(d["expiresAtMs"]),
            server_now_ms=int(d["serverNowMs"]),
        )


@dataclass(frozen=True, slots=True)
class RosterAction:
    """One driver action. `fields` holds the type-specific wire fields."""

    request_id: str
    type: ActionType
    captured_at_ms: int
    assignment_id: str
    fields: tuple[tuple[str, Any], ...] = ()

    def to_wire(self, driver_operating_grant: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "schemaVersion": 1,
            "requestId": self.request_id,
            "driverOperatingGrant": driver_operating_grant,
            "capturedAtMs": self.captured_at_ms,
            "type": self.type,
            "assignmentId": self.assignment_id,
        }
        body.update(dict(self.fields))
        return body


@dataclass(frozen=True, slots=True)
class RosterActionResult:
    request_id: str
    status: ResultStatus
    check_in: CheckInRecord | None
    code: str | None
    message: str | None

    @property
    def is_final(self) -> bool:
        return self.status in FINAL_SUCCESS or self.status == "rejected"

    @staticmethod
    def from_wire(d: dict[str, Any]) -> RosterActionResult:
        c = d.get("checkIn")
        return RosterActionResult(
            request_id=str(d["requestId"]),
            status=d["status"],
            check_in=CheckInRecord.from_wire(c) if c else None,
            code=d.get("code"),
            message=d.get("message"),
        )
