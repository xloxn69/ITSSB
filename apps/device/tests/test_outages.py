"""docs/13 §4 outage cases against the real device process.

The process runs with a fake GPSD (fictional positions) and a fake backend
reached through a switchable TCP proxy that stands in for the bus's
internet link. Each test drives one stimulus and checks the observable
result the case requires, and that across the whole run every eventId
reaches the backend exactly once with an unbroken runSequence.
"""

from __future__ import annotations

import contextlib
import os
import signal
import socket
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from conftest import wait_until
from test_service import _free_port, _health

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend

TOKEN = "fake-dev-token"  # noqa: S105 - obviously fake
RUN_ID = "demo_run_001"


def _hang_up(s: socket.socket) -> None:
    """Shut a socket down, then close it. On Linux `close()` alone does not
    end a connection while another thread is blocked in `recv()` on it: the
    peer gets no EOF and waits out its own timeout. `shutdown()` ends it now
    on every platform."""
    with contextlib.suppress(OSError):
        s.shutdown(socket.SHUT_RDWR)
    with contextlib.suppress(OSError):
        s.close()


class LinkProxy:
    """A TCP forwarder with a switch, standing in for the bus internet link.

    `cut()` hangs up every open connection and stops listening, so a new
    connect is refused at once, the way a dead route looks from the Pi
    (like devtools/link_proxy.py); `restore()` listens on the same port
    again. A connection accepted just before a cut never survives it."""

    def __init__(self, target_port: int) -> None:
        self.target_port = target_port
        self._lock = threading.Lock()
        self._conns: list[socket.socket] = []
        self._listener: socket.socket | None = None
        self.port = 0
        self.restore()

    def cut(self) -> None:
        with self._lock:
            listener, self._listener = self._listener, None
            conns, self._conns = self._conns, []
        if listener is not None:
            _hang_up(listener)  # wakes the accept thread; the port now refuses
        for c in conns:
            _hang_up(c)

    def restore(self) -> None:
        with self._lock:
            if self._listener is not None:
                return
            # Same port as before, so the device's configured origin still works.
            # A failure to rebind fails the test loudly; it is never retried.
            listener = socket.create_server(("127.0.0.1", self.port))
            self.port = listener.getsockname()[1]
            self._listener = listener
        threading.Thread(target=self._accept, args=(listener,), daemon=True).start()

    def close(self) -> None:
        self.cut()

    def _accept(self, listener: socket.socket) -> None:
        while True:
            try:
                client, _ = listener.accept()
            except OSError:
                return  # cut: this listener is gone
            try:
                upstream = socket.create_connection(("127.0.0.1", self.target_port))
            except OSError:
                _hang_up(client)
                continue
            with self._lock:
                live = self._listener is listener  # not cut since this accept
                if live:
                    self._conns += [client, upstream]
            if not live:
                _hang_up(client)
                _hang_up(upstream)
                continue
            for a, b in ((client, upstream), (upstream, client)):
                threading.Thread(target=self._pipe, args=(a, b), daemon=True).start()

    @staticmethod
    def _pipe(src: socket.socket, dst: socket.socket) -> None:
        try:
            while data := src.recv(65536):
                dst.sendall(data)
        except OSError:
            pass
        finally:
            _hang_up(src)
            _hang_up(dst)


@pytest.fixture
def bench(tmp_path, fake_gpsd):
    """Fake GPSD + fake backend behind the link proxy, and an active run."""
    gpsd = fake_gpsd("fix", interval_s=0.2)
    backend = FakeBackend(0, TOKEN).start()
    link = LinkProxy(backend.port)
    db_path = tmp_path / "state" / "device.sqlite3"
    db_path.parent.mkdir()
    db = Database(db_path)
    db.save_run(RUN_ID, "active")  # stands in for a server-issued run
    db.close()
    api_port = _free_port()
    procs: list[subprocess.Popen] = []
    logs: list = []

    def spawn() -> subprocess.Popen:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "ITSSB_ENV_FILE": str(tmp_path / "none.env"),
            "ITSSB_DATABASE_PATH": str(db_path),
            "ITSSB_GPSD_PORT": str(gpsd.port),
            "ITSSB_LOCAL_API_PORT": str(api_port),
            "ITSSB_PUBLISH_INTERVAL_SECONDS": "1",
            "ITSSB_UPLOAD_INTERVAL_SECONDS": "1",
            "ITSSB_DEVICE_API_ORIGIN": f"http://127.0.0.1:{link.port}",
            "ITSSB_DEVICE_TOKEN": TOKEN,
        }
        # Output goes to a file, never an unread pipe: a full pipe would block
        # the device's logging, and the log is printed when a test fails.
        log = open(tmp_path / f"device-{len(logs)}.log", "w")  # noqa: SIM115 - closed at teardown
        logs.append(log)
        p = subprocess.Popen(
            [sys.executable, "-m", "itssb_device", "run"],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        p.log_path = log.name
        procs.append(p)
        assert wait_until(lambda: _health(api_port) is not None, timeout=10)
        return p

    class Bench:
        pass

    b = Bench()
    b.gpsd, b.backend, b.link, b.db_path, b.spawn = gpsd, backend, link, db_path, spawn
    b.health = lambda: _health(api_port) or {}
    yield b
    for p in procs:
        p.kill()
        p.communicate(timeout=10)
    for log in logs:
        log.close()
        # Shown by pytest only when the test failed.
        print(
            f"--- {log.name} (tail) ---\n"
            + "".join(Path(log.name).read_text().splitlines(True)[-60:])
        )
    link.close()
    backend.stop()


def health_value(b, *path):
    v = b.health()
    for k in path:
        v = (v or {}).get(k)
    return v


def local_rows(b) -> list[dict]:
    db = Database(b.db_path)
    try:
        return db.list_outbox(100_000)
    finally:
        db.close()


def delivered_through(b, run_sequence: int) -> bool:
    """Every event up to this runSequence is acknowledged locally. (The health
    snapshot's pending count is refreshed right after each new save, so it
    reads 1 while GPS is live even when the queue is caught up.)"""
    rows = [r for r in local_rows(b) if r["runSequence"] <= run_sequence]
    return len(rows) == run_sequence + 1 and all(r["status"] == "acknowledged" for r in rows)


def newest_sequence(b) -> int:
    return max(r["runSequence"] for r in local_rows(b))


def terminate(proc: subprocess.Popen) -> None:
    proc.send_signal(signal.SIGTERM)
    proc.communicate(timeout=20)
    assert proc.returncode == 0, Path(proc.log_path).read_text()


def stop(proc: subprocess.Popen, b) -> None:
    """Stop recording, then drain whatever is still queued, deterministically.

    A no-fix report clears the device's current fix, but a recorder tick that
    read the fix just before can still save it a moment later, after the queue
    looked drained. So: stop new fixes, stop this process (its threads finish
    their step and exit), then start a drain boot. GPS reports no fix for its
    whole life, so it can never save an observation; it only uploads the rows
    already queued. Each test checks its own drain before calling this."""
    b.gpsd.mode = "nofix"
    assert wait_until(lambda: health_value(b, "gps", "lastRejectReason") is not None, timeout=10)
    terminate(proc)
    drain = b.spawn()
    assert wait_until(lambda: all(r["status"] == "acknowledged" for r in local_rows(b)), timeout=30)
    assert health_value(b, "recorder", "observationsThisBoot") == 0
    terminate(drain)


def assert_delivered_exactly_once(b) -> None:
    """Every local event is acknowledged, the backend holds each eventId once,
    and the run's runSequence is unbroken (no loss, no duplicate)."""
    rows = local_rows(b)
    assert rows
    assert {r["status"] for r in rows} == {"acknowledged"}
    local_ids = [r["eventId"] for r in rows]
    assert len(set(local_ids)) == len(local_ids)
    assert set(b.backend.events) == set(local_ids)
    seqs = sorted(e["runSequence"] for e in b.backend.events.values())
    assert seqs == list(range(len(seqs)))


@pytest.fixture
def upstream():
    server = socket.create_server(("127.0.0.1", 0))
    server.settimeout(5)
    yield server
    server.close()


def _through(link: LinkProxy, upstream: socket.socket) -> tuple[socket.socket, socket.socket]:
    client = socket.create_connection(("127.0.0.1", link.port), timeout=5)
    server, _ = upstream.accept()
    server.settimeout(5)
    return client, server


# The drills are only as true as this stand-in. Each check below times out
# (5 s) instead of passing if the proxy leaves a connection half open.


def test_link_proxy_passes_on_a_server_hang_up(upstream):
    link = LinkProxy(upstream.getsockname()[1])
    try:
        client, server = _through(link, upstream)
        _hang_up(server)  # the backend closes without answering (D02)
        assert client.recv(1) == b""  # the device sees it now, not at its timeout
        client.close()
    finally:
        link.close()


def test_link_proxy_cut_ends_connections_and_refuses_new_ones(upstream):
    link = LinkProxy(upstream.getsockname()[1])
    try:
        client, server = _through(link, upstream)
        link.cut()
        assert client.recv(1) == b""  # the open connection ends
        client.close()
        server.close()
        with pytest.raises(ConnectionRefusedError):  # like a dead route
            socket.create_connection(("127.0.0.1", link.port), timeout=5)

        link.restore()  # same port: the device's configured origin works again
        client, server = _through(link, upstream)
        client.sendall(b"ping")
        assert server.recv(4) == b"ping"
        client.close()
        server.close()
    finally:
        link.close()


def test_d07_d08_bus_internet_loss_queues_locally_then_fresh_first(bench):
    proc = bench.spawn()
    assert wait_until(lambda: (health_value(bench, "outbox", "acknowledged") or 0) >= 2, timeout=15)
    bench.link.cut()  # D07: bus internet gone, GPS still valid
    # Anything sent before the cut holds runSequence <= this, even a batch
    # that was in flight at the cut.
    sent_by_cut = newest_sequence(bench)
    assert wait_until(lambda: health_value(bench, "backend", "status") != "ok", timeout=15)
    ok_at_cut = health_value(bench, "backend", "lastOkAtMs")
    assert wait_until(
        lambda: sum(r["status"] == "pending" for r in local_rows(bench)) >= 4, timeout=15
    )
    snap = bench.health()
    rows = local_rows(bench)
    assert snap["gps"]["status"] == "valid"
    assert snap["backend"]["status"] != "ok"
    assert snap["backend"]["lastOkAtMs"] == ok_at_cut  # no fabricated sync
    # Recording went on locally, and nothing recorded after the cut reached
    # the backend while the link was down.
    assert max(r["runSequence"] for r in rows) > sent_by_cut
    assert max(e["runSequence"] for e in bench.backend.events.values()) <= sent_by_cut
    # Only what the backend really holds is acknowledged locally.
    acknowledged = {r["eventId"] for r in rows if r["status"] == "acknowledged"}
    assert acknowledged <= set(bench.backend.events)
    assert snap["outbox"]["oldestPendingCapturedAtMs"] is not None  # visibly behind

    backlog_end = newest_sequence(bench)  # newest pending at reconnect
    first_after = len(bench.backend.requests)
    bench.link.restore()  # D08: reconnect with a backlog
    assert wait_until(lambda: delivered_through(bench, backlog_end), timeout=45)
    batch = bench.backend.requests[first_after]["eventIds"]
    seqs = [bench.backend.events[e]["runSequence"] for e in batch]
    # Fresh tracking first: the first batch after reconnect leads with an
    # observation at least as new as everything pending at reconnect (a fix
    # saved after the restore may lead instead), and it is the newest one
    # that batch carried; history drains behind it.
    assert seqs[0] >= backlog_end
    assert seqs[0] == max(seqs)
    stop(proc, bench)
    assert_delivered_exactly_once(bench)


def test_d02_lost_responses_never_duplicate(bench):
    bench.backend.mode = "drop_response"  # server commits; answer never arrives
    proc = bench.spawn()
    # Wait for the requirement itself, not for a count of events that needs
    # several backoff rounds: some eventId went out in two failed uploads.
    assert wait_until(
        lambda: max((r["attempts"] for r in local_rows(bench)), default=0) >= 2, timeout=15
    )
    assert bench.backend.events  # the server did commit
    assert not [r for r in local_rows(bench) if r["status"] == "acknowledged"]  # nothing claimed
    bench.backend.mode = "ok"
    last = newest_sequence(bench)
    assert wait_until(lambda: delivered_through(bench, last), timeout=45)
    stop(proc, bench)
    resent = [e for r in bench.backend.requests for e in r["eventIds"]]
    assert len(resent) > len(set(resent))  # the same eventIds really were retried
    assert_delivered_exactly_once(bench)


def test_d05_kill_9_mid_run_during_an_outage_recovers_the_same_run(bench):
    proc = bench.spawn()
    first_boot = health_value(bench, "process", "bootId")
    bench.link.cut()
    assert wait_until(lambda: (health_value(bench, "outbox", "pending") or 0) >= 3, timeout=15)
    proc.send_signal(signal.SIGKILL)  # no chance to clean up
    proc.communicate(timeout=10)
    pending_before = [r["eventId"] for r in local_rows(bench) if r["status"] == "pending"]

    proc = bench.spawn()
    snap = bench.health()
    assert snap["process"]["bootId"] != first_boot
    assert snap["run"]["runId"] == RUN_ID  # same run, recovered not invented
    assert snap["outbox"]["pending"] >= len(pending_before)
    assert wait_until(
        lambda: (health_value(bench, "recorder", "observationsThisBoot") or 0) >= 2, timeout=15
    )
    last = newest_sequence(bench)
    bench.link.restore()
    assert wait_until(lambda: delivered_through(bench, last), timeout=45)
    stop(proc, bench)
    rows = local_rows(bench)
    survivors = [r["eventId"] for r in rows if r["eventId"] in set(pending_before)]
    assert survivors == pending_before  # every pending row survived, same order
    boots = {e["bootId"] for e in bench.backend.events.values()}
    assert first_boot in boots and len(boots) == 2  # both processes' events arrived
    assert_delivered_exactly_once(bench)  # runSequence continued across the kill


def test_d09_gps_loss_with_internet_keeps_last_fix_time_and_records_nothing(bench):
    proc = bench.spawn()
    assert wait_until(lambda: len(bench.backend.events) >= 2, timeout=15)
    bench.gpsd.mode = "nofix"  # receiver connected, no fix
    assert wait_until(lambda: health_value(bench, "gps", "status") == "no_fix", timeout=15)
    last_fix = health_value(bench, "gps", "lastValidFixCapturedAtMs")
    assert wait_until(lambda: delivered_through(bench, newest_sequence(bench)), timeout=15)
    stored = len(bench.backend.events)
    # Several publish intervals with no fix: nothing new is invented.
    assert not wait_until(lambda: len(bench.backend.events) > stored, timeout=3)
    snap = bench.health()
    assert snap["gps"]["lastValidFixCapturedAtMs"] == last_fix  # keeps its timestamp
    assert snap["network"]["status"] == "online"  # GPS loss is not network loss
    assert snap["backend"]["status"] == "ok"
    newest = max(e["capturedAtMs"] for e in bench.backend.events.values())
    assert newest <= last_fix

    bench.gpsd.mode = "fix"  # fix returns: recording resumes on the same run
    assert wait_until(lambda: len(bench.backend.events) > stored, timeout=15)
    stop(proc, bench)
    assert_delivered_exactly_once(bench)
