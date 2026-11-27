"""The device roster models match the shared fixtures (docs/08 §9.2)."""

import json
from pathlib import Path

from itssb_device.roster_contracts import QrCode, Roster, RosterAction, RosterActionResult

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"
GRANT = "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def test_record_attendance_wire_matches_fixture() -> None:
    action = RosterAction(
        request_id="7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09",
        type="recordAttendance",
        captured_at_ms=1795608500000,
        assignment_id="demo_assignment_002",
        fields=(("runId", "demo_run_001"), ("status", "boarded")),
    )
    assert action.to_wire(GRANT) == load("rosterAction.recordAttendance.request")


def test_remove_assignment_wire_matches_fixture() -> None:
    action = RosterAction(
        request_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        type="removeAssignment",
        captured_at_ms=1795608500000,
        assignment_id="demo_assignment_002",
        fields=(("reason", "Moved to another school"),),
    )
    assert action.to_wire(GRANT) == load("rosterAction.removeAssignment.request")


def test_roster_decodes_with_sources_and_null_check_in() -> None:
    roster = Roster.from_wire(load("roster.response"))
    assert [s.student_display_name for s in roster.students] == ["Blake Example", "Sam Example"]
    assert roster.students[0].check_in is None
    assert roster.students[1].check_in is not None
    assert roster.students[1].check_in.source == "student_qr_claim"


def test_results_say_whether_the_pending_action_is_settled() -> None:
    accepted = RosterActionResult.from_wire(load("rosterAction.accepted"))
    rejected = RosterActionResult.from_wire(load("rosterAction.rejected"))
    assert accepted.is_final and accepted.check_in is not None
    assert rejected.is_final and rejected.code == "grant_not_authorized"


def test_qr_code_decodes() -> None:
    qr = QrCode.from_wire(load("qrCode.response"))
    assert qr.purpose == "trip_check_in" and qr.link_path == "/checkin"
