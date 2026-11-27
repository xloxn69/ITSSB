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

import pytest
from conftest import wait_until
from test_service import _free_port, _health

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend

TOKEN = "fake-dev-token"  # noqa: S105 - obviously fake
RUN_ID = "demo_run_001"


class LinkProxy:
    """A TCP forwarder with a switch. `cut()` drops every open connection and
    refuses to carry new ones, the way a dead cellular link behaves from the
    Pi's side; `restore()` carries traffic again."""

    def __init__(self, target_port: int) -> None:
        self.target_port = target_port
        self.up = threading.Event()
        self.up.set()
        self._conns: list[socket.socket] = []
        self._lock = threading.Lock()
        self._listener = socket.create_server(("127.0.0.1", 0))
        self.port = self._listener.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def cut(self) -> None:
        self.up.clear()
        with self._lock:
            for c in self._conns:
                with contextlib.suppress(OSError):
                    c.close()
            self._conns.clear()

    def restore(self) -> None:
        self.up.set()

    def close(self) -> None:
        self.cut()
        self._listener.close()

    def _accept(self) -> None:
        while True:
            try:
                client, _ = self._listener.accept()
            except OSError:
                return
            if not self.up.is_set():
                client.close()
                continue
            try:
                upstream = socket.create_connection(("127.0.0.1", self.target_port))
            except OSError:
                client.close()
                continue
            with self._lock:
                self._conns += [client, upstream]
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
            for s in (src, dst):
                with contextlib.suppress(OSError):
                    s.close()


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
        p = subprocess.Popen(
            [sys.executable, "-m", "itssb_device", "run"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
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


def stop(proc: subprocess.Popen, b) -> None:
    """Stop new fixes, let the queue drain completely, then SIGTERM.

    Wait until the device has processed a no-fix report first: from then on
    it holds no current fix and cannot save another observation. Without
    that, a fix received just before the switch could be saved after the
    queue looked drained, leaving one pending row at the end."""
    b.gpsd.mode = "nofix"
    assert wait_until(lambda: health_value(b, "gps", "lastRejectReason") is not None, timeout=10)
    assert wait_until(lambda: all(r["status"] == "acknowledged" for r in local_rows(b)), timeout=30)
    proc.send_signal(signal.SIGTERM)
    out, _ = proc.communicate(timeout=20)
    assert proc.returncode == 0, out


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


def test_d07_d08_bus_internet_loss_queues_locally_then_fresh_first(bench):
    proc = bench.spawn()
    assert wait_until(lambda: (health_value(bench, "outbox", "acknowledged") or 0) >= 2, timeout=15)
    bench.link.cut()  # D07: bus internet gone, GPS still valid
    acked = health_value(bench, "outbox", "acknowledged")
    assert wait_until(lambda: health_value(bench, "backend", "status") != "ok", timeout=15)
    ok_at_cut = health_value(bench, "backend", "lastOkAtMs")
    assert wait_until(lambda: (health_value(bench, "outbox", "pending") or 0) >= 4, timeout=15)
    snap = bench.health()
    assert snap["gps"]["status"] == "valid"
    assert snap["backend"]["status"] != "ok"
    assert snap["backend"]["lastOkAtMs"] == ok_at_cut  # no fabricated sync
    assert snap["outbox"]["acknowledged"] <= acked + 1  # an in-flight batch at most
    assert snap["outbox"]["oldestPendingCapturedAtMs"] is not None  # visibly behind
    requests_during_outage = len(bench.backend.requests)

    backlog_end = newest_sequence(bench)
    bench.link.restore()  # D08: reconnect with a backlog
    assert wait_until(lambda: delivered_through(bench, backlog_end), timeout=45)
    first_after = bench.backend.requests[requests_during_outage]["eventIds"]
    newest_then = max(
        (e for e in bench.backend.events.values() if e["eventId"] in first_after),
        key=lambda e: e["runSequence"],
    )
    # Fresh tracking first: the first batch after reconnect leads with the
    # newest observation it carried, not the oldest backlog row.
    assert first_after[0] == newest_then["eventId"]
    stop(proc, bench)
    assert_delivered_exactly_once(bench)


def test_d02_lost_responses_never_duplicate(bench):
    proc = bench.spawn()
    bench.backend.mode = "drop_response"  # server commits; answer never arrives
    assert wait_until(lambda: len(bench.backend.events) >= 3, timeout=15)
    assert health_value(bench, "outbox", "acknowledged") == 0  # nothing claimed
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
    assert [r["eventId"] for r in rows][: len(pending_before)] == pending_before
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
