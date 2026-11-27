"""Online run start (docs/04 §10, docs/08 §6), behind an interface.

The flow is fixed here; only the network call is pluggable:

1. Save the start request with a stable `requestId` BEFORE sending.
2. Send it through a `RunStarter`.
3. Only an `accepted` answer with a server-issued `runId` and
   `state: "active"` makes the device record an active run, in the same
   transaction that resolves the request.
4. An unknown outcome (no answer) leaves the request pending; the next
   attempt resends the SAME requestId so the backend can return the same run.

The backend does not implement `POST /device/v1/trip-events` yet, so the
only starter shipped is `BackendNotReadyRunStarter`, which honestly reports
that online start is unavailable and changes nothing. Swap in an HTTP
implementation once the endpoint exists; the flow above stays the same.

Offline start of a NEW run is out of scope (`allow_new_offline_run=false`).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import asdict, dataclass
from typing import Literal, Protocol

from .database import Database

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class StartRunRequest:
    request_id: str
    route_version_id: str
    service_date: str
    service_timezone: str
    captured_at_ms: int
    driver_operating_grant: str

    def to_wire(self) -> dict[str, object]:
        d = asdict(self)
        return {
            "schemaVersion": 1,
            "requestId": d["request_id"],
            "type": "startRun",
            "driverOperatingGrant": d["driver_operating_grant"],
            "routeVersionId": d["route_version_id"],
            "serviceDate": d["service_date"],
            "serviceTimezone": d["service_timezone"],
            "capturedAtMs": d["captured_at_ms"],
        }


@dataclass(frozen=True, slots=True)
class StartRunResult:
    status: Literal["accepted", "rejected", "unknown", "unavailable"]
    run_id: str | None = None
    state: str | None = None
    code: str | None = None


class RunStarter(Protocol):
    def start_run(self, request: StartRunRequest) -> StartRunResult: ...


class BackendNotReadyRunStarter:
    """Stub until the backend implements POST /device/v1/trip-events."""

    def start_run(self, request: StartRunRequest) -> StartRunResult:
        return StartRunResult("unavailable", code="TRIP_EVENTS_NOT_IMPLEMENTED")


def new_request_id() -> str:
    return str(uuid.uuid4())


def start_run_online(
    db: Database, starter: RunStarter, request: StartRunRequest, now_ms: int
) -> StartRunResult:
    db.save_start_request(request.request_id, request.to_wire(), now_ms)
    result = starter.start_run(request)
    if result.status == "accepted" and result.run_id and result.state == "active":
        db.resolve_start_request(request.request_id, result.run_id)
        log.info("run start accepted: runId=%s requestId=%s", result.run_id, request.request_id)
    elif result.status in ("rejected", "unavailable"):
        # Unavailable = never sent; close it so it isn't mistaken for in flight.
        db.resolve_start_request(request.request_id, None, result.code or "REJECTED")
        log.warning(
            "run start %s (%s) requestId=%s; no run recorded",
            result.status,
            result.code,
            request.request_id,
        )
    else:
        # Unknown outcome: keep the request pending and resend the same requestId.
        log.warning("run start outcome unknown requestId=%s; will reuse it", request.request_id)
    return result
