from itssb_device.database import Database
from itssb_device.gps_reader import LatestFixHolder
from itssb_device.models import Fix
from itssb_device.recorder import Recorder
from itssb_device.status import GPS_FRESH_S, StatusBoard


def fix(captured_at_ms: int) -> Fix:
    return Fix(captured_at_ms, 34.1, -83.98, 5.0, 0.0, 6.0, 3)


def make(path, clock, boot="boot-a"):
    board = StatusBoard(boot, upload_enabled=False, monotonic=clock)
    latest = LatestFixHolder()
    return Recorder(Database(path), board, latest, boot, monotonic=clock), latest, board


def test_no_active_run_records_nothing(tmp_path, clock):
    rec, latest, board = make(tmp_path / "d.db", clock)
    latest.set(fix(1_000), clock())
    assert rec.tick() is False
    assert board.snapshot()["run"] is None
    assert rec.db.outbox_counts()["pending"] == 0


def test_fresh_fix_is_saved_once_per_epoch(tmp_path, clock):
    rec, latest, board = make(tmp_path / "d.db", clock)
    rec.db.save_run("demo_run_001", "active")
    latest.set(fix(1_000), clock())
    assert rec.tick() is True
    assert rec.tick() is False  # same epoch again: not a new observation
    latest.set(fix(2_000), clock())
    assert rec.tick() is True
    snap = board.snapshot()
    assert snap["outbox"]["pending"] == 2
    assert snap["run"]["nextRunSequence"] == 2
    assert [p["sequence"] for p in rec.db.pending_payloads(0)] == [0, 1]


def test_stale_fix_is_not_saved(tmp_path, clock):
    rec, latest, _ = make(tmp_path / "d.db", clock)
    rec.db.save_run("demo_run_001", "active")
    latest.set(fix(1_000), clock())
    clock.advance(GPS_FRESH_S + 1)  # receiver went silent
    assert rec.tick() is False


def test_restart_keeps_run_and_pending_rows_and_does_not_duplicate(tmp_path, clock):
    path = tmp_path / "d.db"
    rec, latest, _ = make(path, clock, boot="boot-a")
    rec.db.save_run("demo_run_001", "active")
    latest.set(fix(1_000), clock())
    rec.tick()
    latest.set(fix(2_000), clock())
    rec.tick()
    before = [p["eventId"] for p in rec.db.pending_payloads(0)]
    rec.db.close()  # process dies

    rec2, latest2, board2 = make(path, clock, boot="boot-b")
    rec2.refresh_status()
    snap = board2.snapshot()
    assert snap["run"] == {"runId": "demo_run_001", "state": "active", "nextRunSequence": 2}
    assert snap["outbox"]["pending"] == 2
    assert [p["eventId"] for p in rec2.db.pending_payloads(0)] == before

    # The old fix is still the newest one known after restart: not re-saved.
    latest2.set(fix(2_000), clock())
    assert rec2.tick() is False
    latest2.set(fix(3_000), clock())
    assert rec2.tick() is True
    [*_, newest] = rec2.db.pending_payloads(0)
    assert (newest["bootId"], newest["sequence"], newest["runSequence"]) == ("boot-b", 0, 2)


def test_restart_without_run_does_not_invent_one(tmp_path, clock):
    path = tmp_path / "d.db"
    rec, _, _ = make(path, clock)
    rec.db.close()
    rec2, _, board = make(path, clock)
    rec2.tick()
    assert board.snapshot()["run"] is None
    assert rec2.db.active_run() is None
