import logging
import socket

import pytest

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.models import Fix
from itssb_device.status import StatusBoard
from itssb_device.sync import backoff_ms
from itssb_device.uploader import AUTH_PAUSE_MS, HttpTransport, Uploader

TOKEN = "fake-dev-token"  # noqa: S105 - obviously fake
BOOT = "3cd44c56-c96b-4b83-a970-5414990bc25a"


class Clock:
    def __init__(self, t=1_795_609_085_000):
        self.t = t

    def __call__(self):
        return self.t


@pytest.fixture
def backend():
    b = FakeBackend(0, TOKEN).start()
    yield b
    b.stop()


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "d.db")
    d.save_run("demo_run_001", "active")
    yield d
    d.close()


def add(db, n):
    return [
        db.record_observation(
            "demo_run_001", Fix(1_795_609_000_000 + i, 34.1, -83.98, None, None, None, 3), BOOT, i
        ).event_id
        for i in range(n)
    ]


def make(db, origin, **kw):
    board = StatusBoard(BOOT, upload_enabled=True)
    clock = Clock()
    up = Uploader(db, board, HttpTransport(origin, 2.0), kw.pop("token", TOKEN), now_ms=clock, **kw)
    return up, board, clock


def statuses(db, ids):
    return [db.outbox_status(i) for i in ids]


def test_accepted_events_are_acknowledged(db, backend):
    ids = add(db, 3)
    up, board, _ = make(db, backend.origin)
    assert up.upload_once() == "ok"
    assert statuses(db, ids) == ["acknowledged"] * 3
    snap = board.snapshot()
    assert snap["backend"]["status"] == "ok"
    assert snap["network"]["status"] == "online"
    assert snap["backend"]["lastBatch"]["accepted"] == 3
    assert up.upload_once() == "idle"


def test_lost_response_retries_same_event_id_and_gets_duplicate(db, backend):
    [eid] = add(db, 1)
    up, board, clock = make(db, backend.origin)
    backend.mode = "drop_response"  # server commits, answer never arrives
    assert up.upload_once() == "transport_error"
    assert db.outbox_status(eid) == "pending"
    assert board.snapshot()["network"]["status"] == "online"  # we did connect
    assert board.snapshot()["backend"]["status"] == "no_response"

    backend.mode = "ok"
    clock.t += backoff_ms(1) + 1
    assert up.upload_once() == "ok"
    assert db.outbox_status(eid) == "acknowledged"
    assert board.snapshot()["backend"]["lastBatch"]["duplicate"] == 1
    assert [r["eventIds"] for r in backend.requests] == [[eid], [eid]]  # same identity
    assert len(backend.events) == 1  # stored once


def test_results_are_applied_per_event(db, backend):
    ids = add(db, 4)
    up, board, _ = make(db, backend.origin)
    backend.mode = "partial"  # answers for events 0 and 2 only
    assert up.upload_once() == "ok"
    assert statuses(db, ids) == ["acknowledged", "pending", "acknowledged", "pending"]
    assert board.snapshot()["backend"]["lastBatch"]["missing"] == 2


def test_server_error_keeps_rows_pending_and_backs_off(db, backend):
    ids = add(db, 2)
    up, board, clock = make(db, backend.origin)
    backend.mode = "down"
    assert up.upload_once() == "server_error"
    assert statuses(db, ids) == ["pending", "pending"]
    assert board.snapshot()["backend"]["status"] == "error"
    assert board.snapshot()["network"]["status"] == "online"
    assert up.upload_once() == "paused"  # not hammering the server
    backend.mode = "ok"
    clock.t += backoff_ms(1) + 1
    assert up.upload_once() == "ok"
    assert statuses(db, ids) == ["acknowledged", "acknowledged"]


def test_backend_unreachable_is_network_offline(db):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{s.getsockname()[1]}"
    ids = add(db, 1)
    up, board, _ = make(db, dead)
    assert up.upload_once() == "transport_error"
    snap = board.snapshot()
    assert snap["network"]["status"] == "offline"
    assert snap["backend"]["status"] == "unreachable"
    assert statuses(db, ids) == ["pending"]
    up.probe_network()
    assert board.snapshot()["network"]["status"] == "offline"


def test_bad_credential_pauses_and_keeps_queue(db, backend, caplog):
    ids = add(db, 2)
    up, board, clock = make(db, backend.origin, token="wrong-fake-token")  # noqa: S106
    with caplog.at_level(logging.DEBUG):
        assert up.upload_once() == "credential_rejected"
    assert "wrong-fake-token" not in caplog.text
    assert statuses(db, ids) == ["pending", "pending"]
    assert board.snapshot()["backend"]["status"] == "credential_rejected"
    clock.t += AUTH_PAUSE_MS - 1
    assert up.upload_once() == "paused"


def test_413_halves_the_batch(db, backend):
    ids = add(db, 4)
    up, _, _ = make(db, backend.origin)
    backend.mode = "too_large"  # rejects any batch with more than one event
    assert up.upload_once() == "split"
    assert up.upload_once() == "split"
    assert up.upload_once() == "ok"
    assert statuses(db, ids)[0] == "acknowledged"


def test_429_respects_retry_after(db, backend):
    add(db, 1)
    up, board, clock = make(db, backend.origin)
    backend.mode = "rate_limited"
    assert up.upload_once() == "rate_limited"
    assert board.snapshot()["backend"]["retryAfterMs"] == 1000
    clock.t += 999
    assert up.upload_once() == "paused"
    backend.mode = "ok"
    clock.t += 2
    assert up.upload_once() == "ok"


def test_batches_respect_event_and_byte_bounds(db, backend):
    add(db, 7)
    up, _, _ = make(db, backend.origin, max_events=3, max_bytes=1024)
    while up.upload_once() == "ok":
        pass
    sizes = [len(r["eventIds"]) for r in backend.requests]
    assert sum(sizes) == 7
    assert max(sizes) <= 3


def test_byte_bound_splits_even_with_room_for_more_events(db, backend):
    add(db, 6)
    up, _, _ = make(db, backend.origin, max_events=50, max_bytes=1024)
    while up.upload_once() == "ok":
        pass
    sizes = [len(r["eventIds"]) for r in backend.requests]
    assert sum(sizes) == 6 and max(sizes) < 6
