import pytest

from itssb_device.database import Database, RunNotActive
from itssb_device.models import Fix
from itssb_device.sync import apply_results, backoff_ms

BOOT = "3cd44c56-c96b-4b83-a970-5414990bc25a"
FIX = Fix(1795609085000, 34.1, -83.98, 7.2, 95.0, None, 3)


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "device.db")
    d.save_run("demo_run_001", "active")
    yield d
    d.close()


def test_observation_and_outbox_are_saved_together(db):
    event = db.record_observation("demo_run_001", FIX, BOOT, sequence=0)
    [payload] = db.pending_payloads(now_ms=0)
    assert payload["eventId"] == event.event_id
    assert payload["runSequence"] == 0
    assert payload["horizontalAccuracyM"] is None  # explicit null, not omitted


def test_run_sequence_survives_reopen(tmp_path):
    path = tmp_path / "device.db"
    d = Database(path)
    d.save_run("demo_run_001", "active")
    d.record_observation("demo_run_001", FIX, BOOT, 0)
    d.close()

    d = Database(path)  # simulated process restart, new boot id
    e = d.record_observation("demo_run_001", FIX, "new-boot", 0)
    assert e.run_sequence == 1
    assert d.active_run_id() == "demo_run_001"
    d.close()


def test_inactive_run_saves_nothing(db):
    db.save_run("demo_run_001", "completed")
    with pytest.raises(RunNotActive):
        db.record_observation("demo_run_001", FIX, BOOT, 0)
    assert db.pending_payloads(now_ms=0) == []


def test_retries_reuse_the_same_event_id(db):
    event = db.record_observation("demo_run_001", FIX, BOOT, 0)
    apply_results(db, [event.event_id], [], now_ms=1000)  # lost response
    [payload] = db.pending_payloads(now_ms=1000 + backoff_ms(1))
    assert payload["eventId"] == event.event_id


def test_per_event_results(db):
    a = db.record_observation("demo_run_001", FIX, BOOT, 0)
    b = db.record_observation("demo_run_001", FIX, BOOT, 1)
    c = db.record_observation("demo_run_001", FIX, BOOT, 2)
    d = db.record_observation("demo_run_001", FIX, BOOT, 3)
    apply_results(
        db,
        [a.event_id, b.event_id, c.event_id, d.event_id],
        [
            {"eventId": a.event_id, "status": "accepted"},
            {"eventId": b.event_id, "status": "duplicate"},
            {"eventId": c.event_id, "status": "rejected", "code": "INVALID_COORDINATES"},
            # d: no result returned -> stays pending
        ],
        now_ms=0,
    )
    assert db.outbox_status(a.event_id) == "acknowledged"
    assert db.outbox_status(b.event_id) == "acknowledged"
    assert db.outbox_status(c.event_id) == "rejected"
    assert db.outbox_status(d.event_id) == "pending"


def test_backoff_is_capped():
    assert backoff_ms(1) == 2_000
    assert backoff_ms(100) == 5 * 60_000
