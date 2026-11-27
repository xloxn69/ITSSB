import pytest

from itssb_device.database import Database
from itssb_device.trips import (
    BackendNotReadyRunStarter,
    StartRunRequest,
    StartRunResult,
    start_run_online,
)

REQ = StartRunRequest(
    request_id="64869872-aaf9-4e4f-99df-621722bbac06",
    route_version_id="demo_route_version_003",
    service_date="2026-11-25",
    service_timezone="America/New_York",
    captured_at_ms=1795608000000,
    driver_operating_grant="EXAMPLE_ONLY_NOT_A_REAL_GRANT",
)


class Scripted:
    def __init__(self, *results):
        self.results = list(results)
        self.seen = []

    def start_run(self, request):
        self.seen.append(request.request_id)
        return self.results.pop(0)


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "d.db")
    yield d
    d.close()


def test_stub_reports_unavailable_and_records_no_run(db):
    result = start_run_online(db, BackendNotReadyRunStarter(), REQ, 0)
    assert result.status == "unavailable"
    assert db.active_run() is None
    assert db.pending_start_request() is None


def test_unknown_outcome_keeps_request_and_retry_reuses_request_id(db):
    starter = Scripted(
        StartRunResult("unknown"),
        StartRunResult("accepted", run_id="demo_run_001", state="active"),
    )
    start_run_online(db, starter, REQ, 0)
    assert db.active_run() is None  # no answer: not an authorized run
    pending = db.pending_start_request()
    assert pending["requestId"] == REQ.request_id
    assert "driverOperatingGrant" in pending

    start_run_online(db, starter, REQ, 1)
    assert starter.seen == [REQ.request_id, REQ.request_id]
    assert db.active_run()["runId"] == "demo_run_001"
    assert db.pending_start_request() is None


def test_rejected_start_records_no_run(db):
    start_run_online(db, Scripted(StartRunResult("rejected", code="RUN_NOT_AUTHORIZED")), REQ, 0)
    assert db.active_run() is None


def test_late_accept_never_reactivates_a_completed_run(db):
    db.save_run("demo_run_001", "completed")
    start_run_online(db, Scripted(StartRunResult("accepted", "demo_run_001", "active")), REQ, 0)
    assert db.active_run() is None
