"""The device route-draft models match the shared fixtures (docs/08 §7.1)."""

import json
from pathlib import Path

from itssb_device.route_draft_contracts import (
    DraftPoint,
    DraftStop,
    RouteDraftSubmission,
    RouteDraftSubmitResult,
    reviews_from_wire,
    status_request,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"
GRANT = "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def test_submission_wire_matches_fixture() -> None:
    fx = load("routeDraft.submit.request")
    submission = RouteDraftSubmission(
        request_id=fx["requestId"],
        device_draft_id=fx["deviceDraftId"],
        captured_at_ms=fx["capturedAtMs"],
        label=fx["label"],
        direction=fx["direction"],
        started_at_ms=fx["startedAtMs"],
        finished_at_ms=fx["finishedAtMs"],
        path=tuple(
            DraftPoint(p["latitude"], p["longitude"], p["capturedAtMs"], p["gapBefore"])
            for p in fx["path"]
        ),
        stops=tuple(
            DraftStop(s["label"], s["latitude"], s["longitude"], s["capturedAtMs"])
            for s in fx["stops"]
        ),
    )
    assert submission.to_wire(GRANT) == fx


def test_submit_results_parse() -> None:
    ok = RouteDraftSubmitResult.from_wire(load("routeDraft.submit.accepted"))
    assert ok.status == "accepted" and ok.draft is not None
    assert ok.draft.status == "submitted" and ok.draft.route_version_id is None
    no = RouteDraftSubmitResult.from_wire(load("routeDraft.submit.rejected"))
    assert (no.status, no.code, no.draft) == ("rejected", "grant_not_authorized", None)


def test_status_request_and_response_match_fixtures() -> None:
    fx = load("routeDraft.status.request")
    assert status_request(GRANT, fx["draftIds"]) == fx
    reviews = reviews_from_wire(load("routeDraft.status.response"))
    approved, rejected = reviews["demo_draft_001"], reviews["demo_draft_002"]
    assert approved is not None and approved.status == "approved"
    assert approved.route_version_id == "demo_route_version_002"
    assert rejected is not None and rejected.decision_reason
    assert reviews["demo_draft_404"] is None
