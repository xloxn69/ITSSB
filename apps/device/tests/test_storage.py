"""D12 near-full disk and queue limit (docs/13 §4, docs/04 §8).

Disk space comes from a fake `disk_usage`; the queue is filled with real
outbox rows. Time is driven by fix capture times and the fake clock only.
"""

import sqlite3

import pytest

from itssb_device.api import render_page
from itssb_device.config import ConfigError, load_config
from itssb_device.database import Database
from itssb_device.gps_reader import LatestFixHolder
from itssb_device.models import Fix
from itssb_device.recorder import Recorder
from itssb_device.status import StatusBoard
from itssb_device.storage import MB, DiskUsage, StorageGuard, StorageLimits
from itssb_device.sync import apply_results

RUN = "demo_run_001"
T0 = 1_795_608_000_000
LIMITS = StorageLimits(
    warn_free_bytes=500 * MB,
    critical_free_bytes=100 * MB,
    warn_pending=20,
    critical_pending=40,
    reduced_interval_s=60.0,
)


class FakeDisk:
    def __init__(self, free: int) -> None:
        self.free = free
        self.error: OSError | None = None

    def __call__(self, _path):
        if self.error is not None:
            raise self.error
        return DiskUsage(total=8_000 * MB, used=8_000 * MB - self.free, free=self.free)


def fix(captured_at_ms: int) -> Fix:
    return Fix(captured_at_ms, 34.1, -83.98, 5.0, 0.0, 6.0, 3)


def make(tmp_path, clock, disk, limits=LIMITS):
    path = tmp_path / "d.db"
    board = StatusBoard("boot-a", upload_enabled=False, monotonic=clock, storage_limits=limits)
    latest = LatestFixHolder()
    guard = StorageGuard(path, limits, disk_usage=disk, monotonic=clock)
    now = {"ms": T0}
    rec = Recorder(
        Database(path),
        board,
        latest,
        "boot-a",
        monotonic=clock,
        now_ms=lambda: now["ms"],
        storage=guard,
    )
    rec.db.save_run(RUN, "active")
    return rec, latest, board, now


def drive(rec, latest, clock, now, seconds: int) -> int:
    """One fresh fix per second for `seconds`; returns how many were saved."""
    saved = 0
    for _ in range(seconds):
        now["ms"] += 1000
        clock.advance(1)
        latest.set(fix(now["ms"]), clock())
        saved += rec.tick()
    return saved


def outbox_rows(db: Database) -> dict[str, str]:
    return {r["eventId"]: r["status"] for r in db.list_outbox(limit=100_000)}


def test_plenty_of_space_is_ok_and_records_every_fix(tmp_path, clock):
    rec, latest, board, now = make(tmp_path, clock, FakeDisk(4_000 * MB))
    assert drive(rec, latest, clock, now, 5) == 5
    st = board.snapshot()["storage"]
    assert (st["level"], st["recording"]) == ("ok", "normal")
    assert st["disk"]["freeBytes"] == 4_000 * MB


def test_low_disk_warns_with_numbers_but_keeps_full_cadence(tmp_path, clock):
    rec, latest, board, now = make(tmp_path, clock, FakeDisk(400 * MB))
    assert drive(rec, latest, clock, now, 5) == 5
    st = board.snapshot()["storage"]
    assert (st["level"], st["recording"]) == ("warning", "normal")
    assert st["disk"] == {
        "level": "warning",
        "freeBytes": 400 * MB,
        "totalBytes": 8_000 * MB,
        "warnFreeBytes": 500 * MB,
        "criticalFreeBytes": 100 * MB,
        "error": None,
    }
    assert "warning (400 MB free;" in render_page(board.snapshot())


def test_long_queue_warns_then_goes_critical(tmp_path, clock):
    rec, latest, board, now = make(tmp_path, clock, FakeDisk(4_000 * MB))
    drive(rec, latest, clock, now, 21)  # 20 pending when the 21st tick measured
    q = board.snapshot()["storage"]["queue"]
    assert (q["level"], q["pending"], q["warnPending"]) == ("warning", 20, 20)
    drive(rec, latest, clock, now, 20)
    st = board.snapshot()["storage"]
    assert (st["queue"]["level"], st["level"], st["recording"]) == (
        "critical",
        "critical",
        "reduced",
    )


def test_critical_disk_reduces_recording_and_keeps_every_pending_row(tmp_path, clock):
    disk = FakeDisk(4_000 * MB)
    rec, latest, board, now = make(tmp_path, clock, disk)
    drive(rec, latest, clock, now, 10)
    before = outbox_rows(rec.db)
    assert set(before.values()) == {"pending"} and len(before) == 10

    disk.free = 80 * MB  # nearly full
    saved = drive(rec, latest, clock, now, 180)
    st = board.snapshot()["storage"]
    assert (st["level"], st["disk"]["level"], st["recording"]) == (
        "critical",
        "critical",
        "reduced",
    )
    # One position per 60 s of capture time instead of 180.
    assert saved == 3
    after = outbox_rows(rec.db)
    # Nothing that was waiting was deleted or marked acknowledged.
    assert {k: after[k] for k in before} == before
    assert len(after) == 13 and set(after.values()) == {"pending"}
    assert "recording reduced to one position every 60 s" in render_page(board.snapshot())


def test_recording_returns_to_normal_when_space_comes_back(tmp_path, clock):
    disk = FakeDisk(50 * MB)
    rec, latest, board, now = make(tmp_path, clock, disk)
    drive(rec, latest, clock, now, 30)
    assert board.snapshot()["storage"]["recording"] == "reduced"

    disk.free = 4_000 * MB
    assert drive(rec, latest, clock, now, 5) == 5
    st = board.snapshot()["storage"]
    assert (st["level"], st["recording"]) == ("ok", "normal")


def test_failed_disk_measurement_is_unknown_and_never_reduces(tmp_path, clock):
    disk = FakeDisk(4_000 * MB)
    disk.error = PermissionError("denied")
    rec, latest, board, now = make(tmp_path, clock, disk)
    assert drive(rec, latest, clock, now, 3) == 3
    st = board.snapshot()["storage"]
    assert st["disk"]["level"] == "unknown"
    assert st["disk"]["error"] == "PermissionError"
    assert st["recording"] == "normal"


def test_health_is_unknown_before_the_first_measurement(clock):
    board = StatusBoard("boot-a", upload_enabled=False, monotonic=clock)
    st = board.snapshot()["storage"]
    assert (st["level"], st["disk"]["freeBytes"], st["queue"]["pending"]) == (
        "unknown",
        None,
        None,
    )
    assert "unknown (free space unknown; ? waiting)" in render_page(board.snapshot())


# ── Cleanup of acknowledged rows ─────────────────────────────────────


def _run_with(db: Database, run_id: str, n: int, captured_at_ms: int) -> list[str]:
    db.save_run(run_id, "active")
    return [
        db.record_observation(run_id, fix(captured_at_ms + i), "boot-a", i).event_id
        for i in range(n)
    ]


def _end(db: Database, run_id: str, at_ms: int) -> None:
    db.end_run_locally(run_id, f"req-{run_id}", "grant", at_ms)


@pytest.fixture
def history(tmp_path):
    """Three old ended runs and an active one, each with acknowledged,
    rejected, and pending rows."""
    db = Database(tmp_path / "d.db")
    old = T0 - 30 * 24 * 3600 * 1000
    ids = {}
    for run_id in ("demo_run_old_1", "demo_run_old_2", "demo_run_last"):
        ids[run_id] = _run_with(db, run_id, 4, old)
        _end(db, run_id, old + 10)
    ids[RUN] = _run_with(db, RUN, 4, old)
    every = [i for run in ids.values() for i in run]
    results = []
    for run in ids.values():
        a, b, r, _p = run
        results += [
            {"eventId": a, "status": "accepted"},
            {"eventId": b, "status": "duplicate"},
            {"eventId": r, "status": "rejected", "code": "INVALID_COORDINATES"},
        ]
    apply_results(db, every, results, now_ms=0)
    yield db, ids
    db.close()


def test_cleanup_removes_only_old_acknowledged_rows_outside_protected_runs(history, clock):
    db, ids = history
    before = outbox_rows(db)
    guard = StorageGuard(db.path, LIMITS, disk_usage=FakeDisk(4_000 * MB), monotonic=clock)
    st = guard.check(db, T0)
    assert st["lastCleanup"]["removed"] == 4  # two acknowledged in each of the two old runs
    after = outbox_rows(db)
    gone = set(before) - set(after)
    assert gone == {i for run in ("demo_run_old_1", "demo_run_old_2") for i in ids[run][:2]}
    # Every pending and rejected row survives; the active and last-ended runs are intact.
    assert {i: s for i, s in before.items() if s != "acknowledged"} == {
        i: s for i, s in after.items() if s != "acknowledged"
    }
    assert all(i in after for i in ids[RUN] + ids["demo_run_last"])
    assert db.last_ended_run()["positionsAccepted"] == 2
    # The events themselves are gone too, so their space is reusable.
    n = db.conn.execute(
        "SELECT COUNT(*) FROM telemetry_events WHERE event_id IN (?,?)", ids["demo_run_old_1"][:2]
    ).fetchone()[0]
    assert n == 0


def test_cleanup_keeps_recent_acknowledged_rows_unless_space_is_low(tmp_path, clock):
    db = Database(tmp_path / "d.db")
    recent = _run_with(db, "demo_run_recent", 2, T0 - 3600 * 1000)
    _end(db, "demo_run_recent", T0)
    _run_with(db, "demo_run_after", 1, T0)
    _end(db, "demo_run_after", T0 + 1)  # now the most recently ended run
    apply_results(db, recent, [{"eventId": i, "status": "accepted"} for i in recent], 0)

    ok = StorageGuard(db.path, LIMITS, disk_usage=FakeDisk(4_000 * MB), monotonic=clock)
    assert ok.check(db, T0)["lastCleanup"]["removed"] == 0  # inside the 7-day retention

    low = StorageGuard(db.path, LIMITS, disk_usage=FakeDisk(400 * MB), monotonic=clock)
    assert low.check(db, T0)["lastCleanup"]["removed"] == 2  # low space: age no longer matters
    db.close()


def test_failed_cleanup_never_stops_recording(tmp_path, clock):
    class BrokenPrune(Database):
        def prune_acknowledged(self, captured_before_ms, limit):
            raise sqlite3.OperationalError("database or disk is full")

    path = tmp_path / "d.db"
    board = StatusBoard("boot-a", upload_enabled=False, monotonic=clock, storage_limits=LIMITS)
    latest = LatestFixHolder()
    guard = StorageGuard(path, LIMITS, disk_usage=FakeDisk(50 * MB), monotonic=clock)
    now = {"ms": T0}
    rec = Recorder(
        BrokenPrune(path), board, latest, "boot-a", clock, lambda: now["ms"], storage=guard
    )
    rec.db.save_run(RUN, "active")
    assert drive(rec, latest, clock, now, 1) == 1
    assert board.snapshot()["storage"]["lastCleanup"]["error"] == "OperationalError"


# ── Configuration ────────────────────────────────────────────────────


def test_storage_defaults_and_redacted_view(tmp_path):
    cfg = load_config({}, env_file=tmp_path / "missing.env")
    assert cfg.storage_limits == StorageLimits()
    assert cfg.redacted()["storage"]["criticalFreeMb"] == 128


@pytest.mark.parametrize(
    "env",
    [
        {"ITSSB_STORAGE_WARN_FREE_MB": "100", "ITSSB_STORAGE_CRITICAL_FREE_MB": "100"},
        {"ITSSB_OUTBOX_WARN_PENDING": "500", "ITSSB_OUTBOX_CRITICAL_PENDING": "400"},
        {"ITSSB_REDUCED_PUBLISH_INTERVAL_SECONDS": "5"},
        {"ITSSB_ACKNOWLEDGED_RETENTION_HOURS": "0"},
    ],
)
def test_critical_must_be_stricter_than_warning(env, tmp_path):
    with pytest.raises(ConfigError):
        load_config(env, env_file=tmp_path / "missing.env")
