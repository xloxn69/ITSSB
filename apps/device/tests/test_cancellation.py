"""Staff cancel the bus's run in the console; the Pi ends it locally as
cancelled (docs/13 D14). Real HTTP against the fake backend, FICTIONAL data."""

import json
from pathlib import Path

import pytest
from test_runs_api import GRANT, ROUTE, T0, Env, events_for, rid

from itssb_device.cancellation import note_health_answer, note_telemetry_results
from itssb_device.database import Database, RunNotActive
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.local_auth import hash_pin
from itssb_device.models import Fix
from itssb_device.recorder import Recorder
from itssb_device.status import StatusBoard
from itssb_device.uploader import HttpTransport, Uploader

TOKEN = "fake-dev-token"  # noqa: S105 - obviously fake
BOOT = "3cd44c56-c96b-4b83-a970-5414990bc25a"
FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


@pytest.fixture(scope="module")
def pin_hash():
    return hash_pin("482916")


@pytest.fixture
def backend():
    b = FakeBackend(0, token=TOKEN).start()
    b.grants[GRANT] = {ROUTE}
    yield b
    b.stop()


def started(tmp_path, pin_hash, backend):
    env = Env(tmp_path, pin_hash, events_for(backend))
    code, body = env.post("/api/runs/start", {"requestId": rid(), "routeVersionId": ROUTE})
    assert (code, body["status"]) == (200, "accepted")
    return env, body["runId"]


def uploader(db, backend):
    board = StatusBoard(BOOT, upload_enabled=True)
    return Uploader(db, board, HttpTransport(backend.origin, 3.0), TOKEN, now_ms=lambda: T0)


def recorder(env, db):
    board = StatusBoard(BOOT, upload_enabled=True)
    return Recorder(db, board, env.latest, BOOT, monotonic=lambda: env.mono, now_ms=lambda: T0)


def fix_at(env, ms):
    env.latest.set(Fix(ms, 34.1, -83.98, 7.0, 90.0, 6.0, 3), env.mono)


def outbox(db):
    return [(r["status"], r["lastError"]) for r in db.list_outbox()]


def test_gps_lost_then_staff_cancel_ends_the_run_on_the_pi(tmp_path, pin_hash, backend):
    env, run_id = started(tmp_path, pin_hash, backend)
    db = env.db()
    rec, up = recorder(env, db), uploader(db, backend)
    fix_at(env, T0 + 1_000)
    assert rec.tick()
    assert up.upload_once() == "ok"  # one position accepted
    fix_at(env, T0 + 2_000)
    assert rec.tick()  # one waiting (the link dropped, say)
    # GPS lost from here: nothing new is recorded and no telemetry is sent.
    cancelled_at = backend.cancel_run(run_id)

    assert up.send_health() == "ok"  # the heartbeat carries the cancellation

    assert db.active_run() is None
    assert db.conn.execute("SELECT state FROM local_runs").fetchone()["state"] == "cancelled"
    # Nothing was sent to end it: the only trip event is the start.
    assert [json.loads(c)["type"] for c, _ in backend.trip_requests.values()] == ["startRun"]
    # Recording stops, even with a fresh fix.
    fix_at(env, T0 + 3_000)
    assert not rec.tick()
    with pytest.raises(RunNotActive):
        db.record_observation(run_id, Fix(T0 + 4_000, 34.1, -83.98, 0, 0, 6.0, 3), BOOT, 9)
    # Rows keep their own outcomes: accepted stays accepted, the waiting one
    # is decided by the server, never relabelled here.
    assert outbox(db) == [("acknowledged", None), ("pending", None)]
    assert up.upload_once() == "ok"
    assert outbox(db) == [("acknowledged", None), ("rejected", "RUN_CANCELLED")]

    summary = env.status()["lastEndedRun"]
    assert summary == {
        "runId": run_id,
        "endedBy": "school",
        "endedAtMs": cancelled_at,
        "cancelledAtMs": cancelled_at,
        "cancelNotedAtMs": T0,
        "endSync": "not_needed",
        "endError": None,
        "endAttempts": 0,
        "positionsRecorded": 2,
        "positionsWaiting": 0,
        "positionsAccepted": 1,
        "positionsRejected": 1,
    }
    assert env.status()["run"] is None
    db.close()

    # Restart: a new process reads the same database.
    again = Database(env.db_path)
    assert again.active_run() is None
    assert again.last_ended_run()["endedBy"] == "school"
    assert uploader(again, backend).health_report()["runId"] is None
    again.close()
    # The driver can't end it again, and no end is invented.
    env.park()
    env.post("/api/motion/parked")
    code, body = env.post(f"/api/runs/{run_id}/end", {"requestId": rid()})
    assert (code, body["error"]) == (409, "RUN_NOT_ACTIVE")
    assert len(backend.trip_requests) == 1


def test_a_rejected_position_tells_the_pi_its_run_was_cancelled(tmp_path, pin_hash, backend):
    env, run_id = started(tmp_path, pin_hash, backend)
    db = env.db()
    rec, up = recorder(env, db), uploader(db, backend)
    fix_at(env, T0 + 1_000)
    assert rec.tick()
    backend.cancel_run(run_id)

    assert up.upload_once() == "ok"

    assert db.active_run() is None
    assert db.last_ended_run()["endedBy"] == "school"
    assert outbox(db) == [("rejected", "RUN_CANCELLED")]
    db.close()


def test_only_a_cancellation_of_the_reported_active_run_ends_it(tmp_path):
    db = Database(tmp_path / "d.db")
    db.save_run("demo_run_002", "active")

    def answer(run):
        return json.dumps({"schemaVersion": 1, "status": "accepted", "run": run}).encode()

    other = {"runId": "demo_run_009", "state": "cancelled", "cancelledAtMs": T0}
    active = {"runId": "demo_run_002", "state": "active", "cancelledAtMs": None}
    assert not note_health_answer(db, "demo_run_002", answer(other), T0)
    assert not note_health_answer(db, "demo_run_002", answer(active), T0)
    assert not note_health_answer(db, "demo_run_002", b"not json", T0)
    assert not note_health_answer(db, "demo_run_002", b"[]", T0)
    # An older backend's answer has no `run`.
    assert not note_health_answer(db, "demo_run_002", answer(None), T0)
    assert not note_health_answer(db, None, answer({**other, "runId": "demo_run_002"}), T0)
    # A rejection for some other reason is not a cancellation.
    ev = db.record_observation("demo_run_002", Fix(T0, 34.1, -83.98, 0, 0, 6.0, 3), BOOT, 0)
    rejected = {"eventId": ev.event_id, "status": "rejected", "code": "RUN_NOT_AUTHORIZED"}
    assert note_telemetry_results(db, [rejected], T0) == []
    assert db.active_run()["runId"] == "demo_run_002"
    db.close()


def test_the_shared_fixtures_decode_on_the_device(tmp_path):
    db = Database(tmp_path / "d.db")
    db.save_run("demo_run_001", "active")
    body = (FIXTURES / "health.accepted.runCancelled.json").read_bytes()
    assert note_health_answer(db, "demo_run_001", body, T0)
    assert db.last_ended_run()["cancelledAtMs"] == json.loads(body)["run"]["cancelledAtMs"]

    db.save_run("demo_run_002", "active")
    response = json.loads((FIXTURES / "telemetry.response.runCancelled.json").read_text())
    with db.transaction() as tx:
        tx.execute(
            "INSERT INTO telemetry_events(event_id, run_id, run_sequence, captured_at_ms) "
            "VALUES(?, 'demo_run_002', 0, ?)",
            (response["results"][0]["eventId"], T0),
        )
    assert note_telemetry_results(db, response["results"], T0) == ["demo_run_002"]
    db.close()


def test_pruning_keeps_the_cancelled_runs_rows_for_its_summary(tmp_path):
    db = Database(tmp_path / "d.db")
    db.save_run("demo_run_001", "active")
    ev = db.record_observation("demo_run_001", Fix(T0, 34.1, -83.98, 0, 0, 6.0, 3), BOOT, 0)
    with db.transaction() as tx:
        tx.execute("UPDATE outbox SET status='acknowledged' WHERE event_id=?", (ev.event_id,))
    assert db.cancel_run_locally("demo_run_001", T0, T0, "health")
    assert db.prune_acknowledged(T0 + 10**9, 100) == 0
    assert db.last_ended_run()["positionsAccepted"] == 1
    db.close()
