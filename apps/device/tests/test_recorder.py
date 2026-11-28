import pytest

from itssb_device.database import Database, RunNotActive
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


NOW_MS = 1_795_609_085_000


def make_at(path, clock, now_ms=NOW_MS, boot="boot-a"):
    board = StatusBoard(boot, upload_enabled=False, monotonic=clock)
    latest = LatestFixHolder()
    rec = Recorder(Database(path), board, latest, boot, monotonic=clock, now_ms=lambda: now_ms)
    return rec, latest, board


def test_future_capture_is_not_saved_and_does_not_block_later_fixes(tmp_path, clock):
    rec, latest, _ = make_at(tmp_path / "d.db", clock)
    rec.db.save_run("demo_run_001", "active")
    latest.set(fix(NOW_MS + 24 * 3600 * 1000), clock())  # a receiver dated tomorrow
    assert rec.tick() is False
    latest.set(fix(NOW_MS), clock())
    assert rec.tick() is True


def test_a_future_row_already_in_the_database_does_not_block_after_restart(tmp_path, clock):
    path = tmp_path / "d.db"
    old = Database(path)
    old.save_run("demo_run_001", "active")
    old.record_observation("demo_run_001", fix(NOW_MS + 24 * 3600 * 1000), "boot-old", 0)
    old.close()
    rec, latest, _ = make_at(path, clock)
    latest.set(fix(NOW_MS), clock())
    assert rec.tick() is True


def test_failed_saves_become_a_visible_fault_until_recovery(tmp_path, clock, stop_event):
    import threading

    from itssb_device.recorder import RecorderThread

    board = StatusBoard("boot-a", upload_enabled=False, monotonic=clock)
    faults: list[str | None] = []
    real_fault = board.recorder_fault

    def spy(fault):
        real_fault(fault)
        faults.append(board.snapshot()["recorder"]["fault"])

    board.recorder_fault = spy
    recovered = threading.Event()

    def factory():  # runs inside the recorder thread, like the service
        rec = Recorder(
            Database(tmp_path / "d.db"), board, LatestFixHolder(), "boot-a", monotonic=clock
        )
        real_tick, calls = rec.tick, {"n": 0}

        def flaky_tick():
            calls["n"] += 1
            if calls["n"] <= 2:
                raise OSError("disk full")  # e.g. SD card full
            recovered.set()
            return real_tick()

        rec.tick = flaky_tick
        return rec

    t = RecorderThread(factory, 0.01, stop_event)
    t.start()
    assert recovered.wait(5)
    stop_event.set()
    t.join(5)
    assert faults[:2] == ["save failed: OSError", "save failed: OSError"]
    assert board.snapshot()["recorder"]["fault"] is None  # cleared after a good cycle
    assert None in faults[2:]


# ── D15: the run ends while a GPS write is in flight ─────────────────


def _rows(db, run_id):
    return db.conn.execute(
        "SELECT t.event_id, t.run_sequence, o.payload FROM telemetry_events t "
        "JOIN outbox o ON o.event_id=t.event_id WHERE t.run_id=? ORDER BY t.run_sequence",
        (run_id,),
    ).fetchall()


def _end_lands_between_check_and_write(rec, path):
    """Ends the run from another connection (the driver API's) right after the
    recorder saw it active and before its write transaction begins."""
    real = rec.db.last_captured_at_ms
    ended = {}

    def hooked(run_id, at_most=None):
        other = Database(path)
        try:
            ended["payload"] = other.end_run_locally(run_id, "end-req-1", "grant-demo", 5_000)
        finally:
            other.close()
        rec.db.last_captured_at_ms = real  # once
        return real(run_id, at_most=at_most)

    rec.db.last_captured_at_ms = hooked
    return ended


def test_d15_run_ended_between_check_and_write_commits_nothing(tmp_path, clock):
    path = tmp_path / "d.db"
    rec, latest, board = make(path, clock)
    rec.db.save_run("demo_run_001", "active")
    for t in (1_000, 2_000):
        latest.set(fix(t), clock())
        assert rec.tick() is True
    before = [tuple(r) for r in _rows(rec.db, "demo_run_001")]

    ended = _end_lands_between_check_and_write(rec, path)
    latest.set(fix(3_000), clock())
    assert rec.tick() is False  # the in-flight write lost the race and committed nothing

    assert ended["payload"]["lastRunSequence"] == 1
    assert [tuple(r) for r in _rows(rec.db, "demo_run_001")] == before
    assert rec.db.outbox_counts()["pending"] == 2
    assert rec.sequence == 2  # the lost write did not consume a sequence
    assert rec.db.active_run() is None
    assert board.snapshot()["run"] is None
    state = rec.db.conn.execute(
        "SELECT state, next_run_sequence FROM local_runs WHERE run_id='demo_run_001'"
    ).fetchone()
    assert (state["state"], state["next_run_sequence"]) == ("completed", 2)
    assert rec.db.pending_end_payloads() == [ended["payload"]]


def test_d15_restart_after_the_race_records_nothing_past_the_final_sequence(tmp_path, clock):
    path = tmp_path / "d.db"
    rec, latest, _ = make(path, clock, boot="boot-a")
    rec.db.save_run("demo_run_001", "active")
    for t in (1_000, 2_000):
        latest.set(fix(t), clock())
        rec.tick()
    ended = _end_lands_between_check_and_write(rec, path)
    latest.set(fix(3_000), clock())
    rec.tick()
    before = [tuple(r) for r in _rows(rec.db, "demo_run_001")]
    rec.db.close()  # process dies with the end still pending upload

    rec2, latest2, board2 = make(path, clock, boot="boot-b")
    for t in (4_000, 5_000):  # fresh, newer fixes keep arriving after restart
        latest2.set(fix(t), clock())
        assert rec2.tick() is False
    with pytest.raises(RunNotActive):
        rec2.db.record_observation("demo_run_001", fix(6_000), "boot-b", 0)

    rows = _rows(rec2.db, "demo_run_001")
    assert [tuple(r) for r in rows] == before
    assert max(r["run_sequence"] for r in rows) == ended["payload"]["lastRunSequence"] == 1
    assert rec2.db.active_run() is None
    assert board2.snapshot()["run"] is None
    assert rec2.db.pending_end_payloads() == [ended["payload"]]
