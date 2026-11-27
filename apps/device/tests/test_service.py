"""End-to-end: the real process against a fake GPSD, stopped by SIGTERM / SIGKILL."""

import http.client
import json
import os
import signal
import socket
import subprocess
import sys

from conftest import wait_until

from itssb_device.database import Database


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _health(port):
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/health")
        data = json.loads(conn.getresponse().read())
        conn.close()
        return data
    except OSError:
        return None


def _spawn(tmp_path, gpsd_port, api_port, extra=None):
    env = {
        "PATH": os.environ.get("PATH", ""),
        "ITSSB_ENV_FILE": str(tmp_path / "none.env"),
        "ITSSB_DATABASE_PATH": str(tmp_path / "state" / "device.sqlite3"),
        "ITSSB_GPSD_PORT": str(gpsd_port),
        "ITSSB_LOCAL_API_PORT": str(api_port),
        "ITSSB_PUBLISH_INTERVAL_SECONDS": "1",
        **(extra or {}),
    }
    return subprocess.Popen(
        [sys.executable, "-m", "itssb_device", "run"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def test_sigterm_stops_cleanly_and_restart_recovers(tmp_path, fake_gpsd):
    gpsd = fake_gpsd("fix")
    db_path = tmp_path / "state" / "device.sqlite3"
    db_path.parent.mkdir()
    db = Database(db_path)
    db.save_run("demo_run_001", "active")  # temporary run fixture
    db.close()

    api_port = _free_port()
    proc = _spawn(tmp_path, gpsd.port, api_port)
    try:
        assert wait_until(
            lambda: (_health(api_port) or {}).get("outbox", {}).get("pending", 0) >= 2, timeout=10
        )
        first = _health(api_port)
        assert first["gps"]["status"] == "valid"
        assert first["backend"]["status"] == "unconfigured"
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=20)
    finally:
        proc.kill()
    assert proc.returncode == 0, out
    assert "stopped bootId=" in out

    db = Database(db_path)
    before = [r["eventId"] for r in db.list_outbox() if r["status"] == "pending"]
    db.close()
    assert len(before) >= 2

    # Hard kill on the second run: committed rows must survive unchanged.
    proc = _spawn(tmp_path, gpsd.port, api_port)
    try:
        assert wait_until(lambda: _health(api_port) is not None, timeout=10)
        second = _health(api_port)
        assert second["process"]["bootId"] != first["process"]["bootId"]
        assert second["run"]["runId"] == "demo_run_001"  # recovered, not invented
        proc.send_signal(signal.SIGKILL)
        proc.communicate(timeout=10)
    finally:
        proc.kill()

    db = Database(db_path)
    after = [r["eventId"] for r in db.list_outbox() if r["status"] == "pending"]
    assert after[: len(before)] == before  # same eventIds, same order
    assert db.active_run()["runId"] == "demo_run_001"
    db.close()


def test_runs_without_gpsd_and_reports_it(tmp_path):
    api_port = _free_port()
    proc = _spawn(tmp_path, _free_port(), api_port)
    try:
        assert wait_until(
            lambda: (_health(api_port) or {}).get("gps", {}).get("gpsd") == "unreachable",
            timeout=10,
        )
        snap = _health(api_port)
        assert snap["gps"]["status"] == "unknown"
        assert snap["run"] is None
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=20)
    finally:
        proc.kill()
    assert proc.returncode == 0


def test_bad_config_exits_with_message_and_no_token(tmp_path):
    env_file = tmp_path / "bad.env"
    env_file.write_text("ITSSB_LOCAL_API_HOST=0.0.0.0\nITSSB_DEVICE_TOKEN=fake-secret-xyz\n")
    proc = subprocess.run(
        [sys.executable, "-m", "itssb_device", "--env-file", str(env_file), "run"],
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert proc.returncode == 2
    assert "loopback" in proc.stderr
    assert "fake-secret-xyz" not in proc.stderr + proc.stdout


def test_uploads_to_backend_and_reports_backend_down_separately(tmp_path, fake_gpsd):
    from itssb_device.devtools.fake_backend import FakeBackend

    gpsd = fake_gpsd("fix")
    backend = FakeBackend(0, "fake-dev-token").start()
    api_port = _free_port()
    env = {
        "ITSSB_DEVICE_API_ORIGIN": backend.origin,
        "ITSSB_DEVICE_TOKEN": "fake-dev-token",
        "ITSSB_UPLOAD_INTERVAL_SECONDS": "1",
    }
    fixture = subprocess.run(
        [sys.executable, "-m", "itssb_device", "fixture-run", "start"],
        env={
            "PATH": os.environ.get("PATH", ""),
            "ITSSB_ENV_FILE": str(tmp_path / "none.env"),
            "ITSSB_DATABASE_PATH": str(tmp_path / "state" / "device.sqlite3"),
        },
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    assert "NOT server-issued" in fixture.stderr
    proc = _spawn(tmp_path, gpsd.port, api_port, env)
    try:
        assert wait_until(
            lambda: (_health(api_port) or {}).get("outbox", {}).get("acknowledged", 0) >= 1,
            timeout=15,
        )
        snap = _health(api_port)
        assert snap["backend"]["status"] == "ok"
        assert snap["network"]["status"] == "online"

        backend.mode = "down"
        assert wait_until(lambda: _health(api_port)["backend"]["status"] == "error", timeout=15)
        snap = _health(api_port)
        assert snap["network"]["status"] == "online"  # network fine, backend failing
        assert snap["gps"]["status"] == "valid"  # GPS unaffected
        backend.mode = "ok"
        assert wait_until(lambda: _health(api_port)["backend"]["status"] == "ok", timeout=30)
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=20)
    finally:
        proc.kill()
        backend.stop()
    assert proc.returncode == 0
    db = Database(tmp_path / "state" / "device.sqlite3")
    acked = {r["eventId"] for r in db.list_outbox(1000) if r["status"] == "acknowledged"}
    db.close()
    assert acked and acked <= set(backend.events)  # acknowledged only what the server holds
