"""Wire models for route-draft submission (docs/08 §7.1).

`POST /device/v1/route-drafts` carries one finished recording with the
driver operating grant; `POST /device/v1/route-drafts/status` reads back the
staff review state. Shapes are checked against
`packages/contracts/fixtures/routeDraft.*.json`. Limits mirror
`packages/contracts/src/routeDrafts.ts`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

# Mirrors packages/contracts/src/routeDrafts.ts and tracking.ts.
MAX_ROUTE_PATH_POINTS = 2000
MAX_ROUTE_DRAFT_STOPS = 100
MAX_ROUTE_DRAFT_BODY_BYTES = 384 * 1024
MAX_ROUTE_DRAFT_STATUS_IDS = 20

ReviewStatus = Literal["submitted", "approved", "rejected"]
REVIEW_STATUSES: frozenset[str] = frozenset({"submitted", "approved", "rejected"})


@dataclass(frozen=True, slots=True)
class DraftPoint:
    latitude: float
    longitude: float
    captured_at_ms: int
    gap_before: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "capturedAtMs": self.captured_at_ms,
            "gapBefore": self.gap_before,
        }


@dataclass(frozen=True, slots=True)
class DraftStop:
    label: str
    latitude: float
    longitude: float
    captured_at_ms: int

    def to_wire(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "capturedAtMs": self.captured_at_ms,
        }


@dataclass(frozen=True, slots=True)
class RouteDraftSubmission:
    request_id: str
    device_draft_id: str
    captured_at_ms: int
    label: str
    direction: str
    started_at_ms: int
    finished_at_ms: int
    path: tuple[DraftPoint, ...]
    stops: tuple[DraftStop, ...]

    def to_wire(self, grant: str) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "requestId": self.request_id,
            "driverOperatingGrant": grant,
            "deviceDraftId": self.device_draft_id,
            "capturedAtMs": self.captured_at_ms,
            "label": self.label,
            "direction": self.direction,
            "startedAtMs": self.started_at_ms,
            "finishedAtMs": self.finished_at_ms,
            "path": [p.to_wire() for p in self.path],
            "stops": [s.to_wire() for s in self.stops],
        }


@dataclass(frozen=True, slots=True)
class RouteDraftReview:
    draft_id: str
    device_draft_id: str
    status: ReviewStatus
    submitted_at_ms: int
    reviewed_at_ms: int | None
    decision_reason: str | None
    route_version_id: str | None

    @staticmethod
    def from_wire(d: dict[str, Any]) -> RouteDraftReview:
        if d["status"] not in REVIEW_STATUSES:
            raise ValueError("unknown review status")
        reviewed, reason, version = d["reviewedAtMs"], d["decisionReason"], d["routeVersionId"]
        return RouteDraftReview(
            draft_id=str(d["draftId"]),
            device_draft_id=str(d["deviceDraftId"]),
            status=d["status"],
            submitted_at_ms=int(d["submittedAtMs"]),
            reviewed_at_ms=None if reviewed is None else int(reviewed),
            decision_reason=None if reason is None else str(reason),
            route_version_id=None if version is None else str(version),
        )


@dataclass(frozen=True, slots=True)
class RouteDraftSubmitResult:
    """`accepted` / `already_submitted` carry the stored draft; `rejected` is
    final for this requestId."""

    request_id: str
    status: Literal["accepted", "already_submitted", "rejected"]
    draft: RouteDraftReview | None
    code: str | None
    message: str | None

    @staticmethod
    def from_wire(d: dict[str, Any]) -> RouteDraftSubmitResult:
        status = d["status"]
        if status in ("accepted", "already_submitted"):
            return RouteDraftSubmitResult(
                str(d["requestId"]), status, RouteDraftReview.from_wire(d["draft"]), None, None
            )
        if status == "rejected":
            return RouteDraftSubmitResult(
                str(d["requestId"]), status, None, str(d["code"]), str(d["message"])
            )
        raise ValueError("unknown submit status")


def status_request(grant: str, draft_ids: list[str]) -> dict[str, Any]:
    return {"schemaVersion": 1, "driverOperatingGrant": grant, "draftIds": draft_ids}


def reviews_from_wire(d: dict[str, Any]) -> dict[str, RouteDraftReview | None]:
    """Status response by server draft id; None for `not_found`."""
    out: dict[str, RouteDraftReview | None] = {}
    for entry in d["drafts"]:
        if entry.get("status") == "not_found":
            out[str(entry["draftId"])] = None
        else:
            review = RouteDraftReview.from_wire(entry)
            out[review.draft_id] = review
    return out
