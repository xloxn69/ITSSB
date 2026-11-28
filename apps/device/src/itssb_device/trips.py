"""Online run start (docs/04 §10, docs/08 §6), behind an interface.

The flow is fixed here; only the network call is pluggable:

1. Save the start request with a stable `requestId` BEFORE sending.
2. Send it through a `RunStarter`.
3. Only an `accepted` answer with a server-issued `runId` and
   `state: "active"` makes the device record an active run, in the same
   transaction that resolves the request.
4. An unknown outcome (no answer) leaves the request pending; the next
   attempt resends the SAME requestId so the backend can return the same run.

The backend implements `POST /device/v1/trip-events` (start and end, with
a driver operating grant). `HttpTripEvents` sends both with the device
credential; `BackendNotReadyRunStarter` remains for devices with no backend
configured. Wire shapes are checked against
`packages/contracts/fixtures/tripEvent.*.json`.

Ending (docs/08 §6): the run is completed locally FIRST, in one transaction
with its frozen sequence boundary and the saved endRun command. Sending is
retried with the same requestId until the server answers, so an ended run is
never reactivated and the end is never lost or duplicated.

Offline start of a NEW run is out of scope (`allow_new_offline_run=false`).
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

from .database import Database
from .uploader import HttpTransport, TransportError

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
class EndRunRequest:
    """`endRun` (docs/08 §6). `last_run_sequence` is None if no telemetry was recorded."""

    request_id: str
    run_id: str
    captured_at_ms: int
    last_run_sequence: int | None
    driver_operating_grant: str

    def to_wire(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "requestId": self.request_id,
            "type": "endRun",
            "driverOperatingGrant": self.driver_operating_grant,
            "runId": self.run_id,
            "capturedAtMs": self.captured_at_ms,
            "lastRunSequence": self.last_run_sequence,
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


# ── HTTP trip events ─────────────────────────────────────────────────

TRIP_EVENTS_PATH = "/device/v1/trip-events"


@dataclass(frozen=True, slots=True)
class TripEventResult:
    """accepted / rejected (the server answered no) / unknown (no usable answer)."""

    status: Literal["accepted", "rejected", "unknown"]
    run_id: str | None = None
    state: str | None = None
    code: str | None = None
    http_status: int | None = None
    # A rejected end for a run staff cancelled (docs/08 §6): "cancelled".
    run_state: str | None = None
    cancelled_at_ms: int | None = None


class HttpTripEvents:
    """Sends startRun/endRun with the device credential. The driver's grant is
    inside the body (docs/08 §6); the device token never reaches the browser."""

    def __init__(self, transport: HttpTransport, token: str) -> None:
        self.transport = transport
        self._token = token
        self._lock = threading.Lock()  # one HTTP connection, several callers

    def send(self, payload: dict[str, Any]) -> TripEventResult:
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
        }
        try:
            with self._lock:
                resp = self.transport.post(TRIP_EVENTS_PATH, body, headers)
        except TransportError as exc:
            return TripEventResult("unknown", code=exc.reason)
        try:
            data = json.loads(resp.body)
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        if resp.status == 200:
            if data.get("status") == "accepted" and isinstance(data.get("runId"), str):
                return TripEventResult("accepted", data["runId"], data.get("state"), None, 200)
            return TripEventResult("unknown", code="BAD_RESPONSE", http_status=200)
        err = data.get("error")
        code = err.get("code") if isinstance(err, dict) else None
        if resp.status >= 500 or resp.status == 429:
            return TripEventResult(
                "unknown", code=code or f"HTTP_{resp.status}", http_status=resp.status
            )
        cancelled = isinstance(err, dict) and err.get("runState") == "cancelled"
        at = err.get("cancelledAtMs") if cancelled else None
        return TripEventResult(
            "rejected",
            code=code or f"HTTP_{resp.status}",
            http_status=resp.status,
            run_state="cancelled" if cancelled else None,
            cancelled_at_ms=at if isinstance(at, int) and not isinstance(at, bool) else None,
        )


class HttpRunStarter:
    def __init__(self, events: HttpTripEvents) -> None:
        self.events = events

    def start_run(self, request: StartRunRequest) -> StartRunResult:
        r = self.events.send(request.to_wire())
        if r.status == "accepted":
            return StartRunResult("accepted", r.run_id, r.state, None)
        return StartRunResult(r.status, code=r.code)


def end_run(
    db: Database,
    events: HttpTripEvents | None,
    run_id: str,
    request_id: str,
    grant: str,
    now_ms: int,
) -> tuple[dict[str, Any], TripEventResult | None]:
    """Completes the run locally (durably), then tries to send the end once.
    No answer leaves it pending for EndRetryThread."""
    payload = db.end_run_locally(run_id, request_id, grant, now_ms)
    if events is None:
        return payload, None
    return payload, send_end(db, events, payload, now_ms)


def send_end(
    db: Database, events: HttpTripEvents, payload: dict[str, Any], now_ms: int
) -> TripEventResult:
    r = events.send(payload)
    if r.status == "accepted":
        db.resolve_end_request(payload["requestId"], "accepted", None, now_ms)
        log.info("run end accepted: runId=%s", payload["runId"])
    elif r.status == "rejected":
        # Kept with its reason for review; the local completion stands.
        db.resolve_end_request(payload["requestId"], "rejected", r.code, now_ms)
        log.error("run end rejected: runId=%s code=%s", payload["runId"], r.code)
        if r.run_state == "cancelled":
            # Staff cancelled it before the driver's end arrived (docs/13 D14).
            db.cancel_run_locally(payload["runId"], r.cancelled_at_ms, now_ms, "end_answer")
    else:
        db.resolve_end_request(payload["requestId"], None, r.code, now_ms)
        log.warning("run end not answered (%s); will resend the same requestId", r.code)
    return r


class EndRetryThread(threading.Thread):
    """Resends saved endRun commands until the server answers."""

    def __init__(
        self,
        database_path: Path | str,
        events: HttpTripEvents,
        stop: threading.Event,
        interval_s: float = 15.0,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        super().__init__(name="end-retry", daemon=True)
        self.database_path, self.events, self.stop_event = database_path, events, stop
        self.interval_s = interval_s
        self.now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)

    def tick(self, db: Database) -> int:
        sent = 0
        for payload in db.pending_end_payloads():
            send_end(db, self.events, payload, self.now_ms())
            sent += 1
        return sent

    def run(self) -> None:
        db = Database(self.database_path)
        try:
            while not self.stop_event.wait(self.interval_s):
                try:
                    self.tick(db)
                except Exception:
                    log.exception("end retry tick failed")
        finally:
            db.close()
