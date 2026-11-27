import errno
import logging
import socket
import ssl

import pytest

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.models import Fix
from itssb_device.status import StatusBoard
from itssb_device.sync import MAX_BACKOFF_MS, backoff_ms
from itssb_device.uploader import AUTH_PAUSE_MS, HttpTransport, TransportError, Uploader, classify

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
    backend.mode = "partial"  # answers for every other event in the request
    assert up.upload_once() == "ok"
    [sent] = [r["eventIds"] for r in backend.requests]
    answered, unanswered = set(sent[::2]), set(sent[1::2])
    for eid in ids:
        assert db.outbox_status(eid) == ("acknowledged" if eid in answered else "pending")
    assert len(answered) == len(unanswered) == 2
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


def test_refused_connection_means_network_up_backend_unreachable(db):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{s.getsockname()[1]}"
    ids = add(db, 1)
    up, board, _ = make(db, dead)
    assert up.upload_once() == "transport_error"
    snap = board.snapshot()
    assert snap["network"]["status"] == "online"  # the host answered (refused)
    assert snap["backend"]["status"] == "unreachable"
    assert statuses(db, ids) == ["pending"]
    up.probe_network()
    assert board.snapshot()["network"]["status"] == "online"


@pytest.mark.parametrize(
    ("exc", "connected", "expected"),
    [
        (socket.gaierror(socket.EAI_NONAME, "no name"), False, ("offline", "unreachable")),
        (TimeoutError(), False, ("offline", "unreachable")),
        (OSError(errno.ENETUNREACH, "unreachable"), False, ("offline", "unreachable")),
        (OSError(errno.EHOSTUNREACH, "no route"), False, ("offline", "unreachable")),
        (ConnectionRefusedError(errno.ECONNREFUSED, "refused"), False, ("online", "unreachable")),
        (ssl.SSLCertVerificationError("bad cert"), False, ("online", "tls_error")),
        (TimeoutError(), True, ("online", "no_response")),
        (ConnectionResetError(), True, ("online", "no_response")),
    ],
)
def test_failure_classification_keeps_network_and_backend_apart(exc, connected, expected):
    assert classify(exc, connected) == expected


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
    assert statuses(db, ids).count("acknowledged") == 1


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


def test_after_an_outage_the_newest_observation_goes_first(db, backend):
    ids = add(db, 120)  # backlog from an outage
    up, _, _ = make(db, backend.origin)
    assert up.upload_once() == "ok"
    first = backend.requests[0]["eventIds"]
    assert first[0] == ids[-1]  # current position reaches families immediately
    assert first[1:] == ids[: len(first) - 1]  # history still drains oldest-first
    while up.upload_once() == "ok":
        pass
    sent = [e for r in backend.requests for e in r["eventIds"]]
    assert sorted(sent) == sorted(ids)  # each event sent exactly once


class SwitchableTransport(HttpTransport):
    """The real transport with a "bus internet" switch: while `offline`, every
    connection fails the way a dead cellular link does (no route to host)."""

    def __init__(self, origin):
        super().__init__(origin, 2.0)
        self.offline = False

    def _connect(self):
        if self.offline:
            raise TransportError(OSError(errno.ENETUNREACH, "unreachable"), connected=False)
        return super()._connect()

    def probe(self):
        if self.offline:
            return "offline", "OSError"
        return super().probe()


def test_d08_reconnect_resumes_fresh_tracking_promptly_after_a_long_outage(db, backend):
    """D07/D08: a long outage must not leave the uploader in a minutes-long
    backoff once the internet is back. The probe that sees the network
    return ends an offline pause, and the newest observation leads."""
    transport = SwitchableTransport(backend.origin)
    board = StatusBoard(BOOT, upload_enabled=True)
    clock = Clock()
    up = Uploader(db, board, transport, TOKEN, now_ms=clock)
    transport.offline = True
    history = add(db, 30)
    for _ in range(12):  # about ten minutes of failed attempts
        clock.t = max(clock.t, up.pause_until_ms) + 1
        assert up.upload_once() == "transport_error"
    assert board.snapshot()["network"]["status"] == "offline"
    assert board.snapshot()["backend"]["lastOkAtMs"] is None  # no claimed sync
    assert up.pause_until_ms - clock.t >= 60_000  # deep in backoff
    assert backend.requests == []

    transport.offline = False
    [fresh] = [
        db.record_observation(
            "demo_run_001", Fix(1_795_609_090_000, 34.2, -83.9, None, None, None, 3), BOOT, 30
        ).event_id
    ]
    clock.t += 1_000
    up.probe_network()  # the uploader thread probes while paused
    assert up.upload_once() == "ok"
    assert backend.requests[0]["eventIds"][0] == fresh  # current position first

    clock.t += MAX_BACKOFF_MS * 2  # bounded: history drains within the backoff cap
    while up.upload_once() == "ok":
        pass
    sent = [e for r in backend.requests for e in r["eventIds"]]
    assert sorted(sent) == sorted([*history, fresh])  # nothing lost, nothing twice
    assert statuses(db, [*history, fresh]) == ["acknowledged"] * 31


def test_a_probe_does_not_end_a_pause_the_server_asked_for(db, backend):
    add(db, 1)
    up, _, _ = make(db, backend.origin, token="wrong-fake-token")  # noqa: S106
    assert up.upload_once() == "credential_rejected"
    up.probe_network()  # network is fine; the credential is still wrong
    assert up.upload_once() == "paused"


def test_d08_backend_unreachable_then_back_resumes_on_first_successful_connect(db, backend):
    """A link that refuses connections (no route through the bus router,
    a proxy down) is "could not connect" too: once a probe connects again,
    uploads resume instead of waiting out a backoff of up to 5 minutes."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{s.getsockname()[1]}"
    add(db, 3)
    up, board, clock = make(db, dead)
    for _ in range(10):
        clock.t = max(clock.t, up.pause_until_ms) + 1
        assert up.upload_once() == "transport_error"
    assert board.snapshot()["backend"]["status"] == "unreachable"
    up.probe_network()  # still refused: the pause stays
    assert up.upload_once() == "paused"

    live = HttpTransport(backend.origin, 2.0)
    up.transport = live  # the link is back
    up.probe_network()
    assert up.upload_once() == "ok"


def test_a_backend_that_answers_badly_keeps_its_backoff(db, backend):
    add(db, 1)
    up, _, _ = make(db, backend.origin)
    backend.mode = "drop_response"  # connects, then no answer
    assert up.upload_once() == "transport_error"
    up.probe_network()  # TCP connects fine, but the server is the problem
    assert up.upload_once() == "paused"
