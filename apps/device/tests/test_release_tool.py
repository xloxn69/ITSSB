"""The Pi release tool (deploy/itssb_release.py), run as the owner runs it.

Every test drives the real command line against a temporary install root,
a temporary SQLite database, and a stand-in local health API.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

DEVICE = Path(__file__).parent.parent
TOOL = DEVICE / "deploy" / "itssb_release.py"
sys.path.insert(0, str(DEVICE / "src"))
from itssb_device.database import MIGRATIONS, Database  # noqa: E402

CLOSED_PORT_URL = "http://127.0.0.1:1/health"  # nothing listens: service stopped


def tool(root: Path, *args: str, health: str = CLOSED_PORT_URL) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(TOOL), "--root", str(root), "--health-url", health, *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def fake_source(tmp: Path, name: str, *, migrations: int | None = None) -> Path:
    """A copy of apps/device, optionally claiming fewer migrations."""
    src = tmp / name
    shutil.copytree(DEVICE / "src", src / "src", ignore=shutil.ignore_patterns("__pycache__"))
    for f in ("pyproject.toml", "uv.lock", "README.md"):
        (src / f).write_bytes((DEVICE / f).read_bytes())
    if migrations is not None:
        db_py = src / "src" / "itssb_device" / "database.py"
        db_py.write_text(db_py.read_text() + f"\nMIGRATIONS = MIGRATIONS[:{migrations}]\n")
    return src


@pytest.fixture
def health_server() -> Iterator[tuple[str, dict]]:
    """Serves {"run": state["run"], "outbox": ...} on /health."""
    state: dict = {"run": None, "version": "0.1.0", "release": None}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(
                {
                    "process": {"version": state["version"], "release": state["release"]},
                    "run": state["run"],
                    "outbox": {"pending": 3, "oldestPendingCapturedAtMs": 1},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/health", state
    server.shutdown()


def make_db(path: Path, pending: int = 2) -> None:
    db = Database(path)
    db.save_run("run_fictional_1", "active")
    with db.transaction() as tx:
        for i in range(pending):
            tx.execute(
                "INSERT INTO telemetry_events VALUES (?,?,?,?)",
                (f"evt_{i}", "run_fictional_1", i, 1_700_000_000_000 + i),
            )
            tx.execute("INSERT INTO outbox (event_id, payload) VALUES (?, '{}')", (f"evt_{i}",))
    db.close()


def counts(path: Path) -> dict[str, int]:
    conn = sqlite3.connect(path)
    try:
        return {
            t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]  # noqa: S608
            for t in ("local_runs", "telemetry_events", "outbox")
        }
    finally:
        conn.close()


# ── Stage, activate, roll back ─────────────────────────────────────────


def test_stage_writes_identifiable_release_without_touching_current(tmp_path):
    root = tmp_path / "opt"
    src = fake_source(tmp_path, "a")
    r = tool(root, "stage", str(src), "--version", "2026.11.26-aaaaaaa", "--revision", "a" * 40)
    assert r.returncode == 0, r.stderr
    rel = json.loads((root / "releases" / "2026.11.26-aaaaaaa" / "RELEASE.json").read_text())
    assert rel["version"] == "2026.11.26-aaaaaaa"
    assert rel["sourceRevision"] == "a" * 40
    assert rel["dbSchemaVersion"] == len(MIGRATIONS)
    assert rel["filesSha256"]
    assert not (root / "current").exists()  # staging never activates


def test_stage_refuses_an_existing_version(tmp_path):
    root = tmp_path / "opt"
    src = fake_source(tmp_path, "a")
    assert tool(root, "stage", str(src), "--version", "v1").returncode == 0
    r = tool(root, "stage", str(src), "--version", "v1")
    assert r.returncode != 0
    assert "already staged" in r.stderr


def test_activate_switches_current_and_keeps_previous(tmp_path):
    root = tmp_path / "opt"
    for v in ("v1", "v2"):
        assert tool(root, "stage", str(fake_source(tmp_path, v)), "--version", v).returncode == 0
    assert tool(root, "activate", "v1").returncode == 0
    assert (root / "current").resolve() == (root / "releases" / "v1").resolve()
    r = tool(root, "activate", "v2")
    assert r.returncode == 0, r.stderr
    assert (root / "current").resolve() == (root / "releases" / "v2").resolve()
    assert (root / "previous").resolve() == (root / "releases" / "v1").resolve()

    r = tool(root, "rollback")
    assert r.returncode == 0, r.stderr
    assert (root / "current").resolve() == (root / "releases" / "v1").resolve()
    assert (root / "previous").resolve() == (root / "releases" / "v2").resolve()


def test_activate_refuses_while_the_service_answers(tmp_path, health_server):
    url, _ = health_server
    root = tmp_path / "opt"
    assert tool(root, "stage", str(fake_source(tmp_path, "a")), "--version", "v1").returncode == 0
    r = tool(root, "activate", "v1", health=url)
    assert r.returncode != 0
    assert "stop the service" in r.stderr
    assert not (root / "current").exists()


def test_activate_refuses_a_tampered_release(tmp_path):
    root = tmp_path / "opt"
    assert tool(root, "stage", str(fake_source(tmp_path, "a")), "--version", "v1").returncode == 0
    target = root / "releases" / "v1" / "src" / "itssb_device" / "gps.py"
    target.chmod(0o644)
    target.write_text(target.read_text() + "\n# changed\n")
    r = tool(root, "activate", "v1")
    assert r.returncode != 0
    assert "integrity" in r.stderr
    assert not (root / "current").exists()


def test_activate_refuses_code_older_than_the_database(tmp_path):
    root = tmp_path / "opt"
    db = tmp_path / "state" / "device.sqlite3"
    db.parent.mkdir()
    make_db(db)  # migrated to len(MIGRATIONS)
    old = fake_source(tmp_path, "old", migrations=len(MIGRATIONS) - 1)
    assert tool(root, "stage", str(old), "--version", "old").returncode == 0
    r = tool(root, "activate", "old", "--db", str(db))
    assert r.returncode != 0
    assert "database" in r.stderr
    assert not (root / "current").exists()
    # The owner can accept it only explicitly (release notes say the newer
    # migrations are additive).
    r = tool(root, "activate", "old", "--db", str(db), "--accept-newer-db")
    assert r.returncode == 0, r.stderr


def test_rollback_without_previous_fails_cleanly(tmp_path):
    root = tmp_path / "opt"
    assert tool(root, "stage", str(fake_source(tmp_path, "a")), "--version", "v1").returncode == 0
    assert tool(root, "activate", "v1").returncode == 0
    r = tool(root, "rollback")
    assert r.returncode != 0
    assert "no previous release" in r.stderr
    assert (root / "current").resolve() == (root / "releases" / "v1").resolve()


# ── Preflight ──────────────────────────────────────────────────────────


def test_preflight_refuses_during_an_active_run(tmp_path, health_server):
    url, state = health_server
    state["run"] = {"runId": "run_fictional_1", "state": "active"}
    r = tool(tmp_path / "opt", "preflight", health=url)
    assert r.returncode != 0
    assert "active run" in r.stderr


def test_preflight_passes_with_no_run_and_reports_pending(tmp_path, health_server):
    url, _ = health_server
    r = tool(tmp_path / "opt", "preflight", health=url)
    assert r.returncode == 0, r.stderr
    assert "pending: 3" in r.stdout


def test_preflight_refuses_when_health_is_unreachable(tmp_path):
    r = tool(tmp_path / "opt", "preflight")
    assert r.returncode != 0
    assert "cannot read" in r.stderr


# ── SQLite backup and restore ─────────────────────────────────────────


def test_backup_is_consistent_with_uncheckpointed_wal(tmp_path):
    db = tmp_path / "device.sqlite3"
    make_db(db, pending=5)
    # Hold a second connection open with WAL content not yet checkpointed,
    # exactly the case where copying the main file alone loses rows.
    live = sqlite3.connect(db)
    live.execute("PRAGMA wal_autocheckpoint=0")
    live.execute("INSERT INTO local_runs VALUES ('run_fictional_2', 'completed', 0)")
    live.commit()
    try:
        out = tmp_path / "backups"
        r = tool(tmp_path / "opt", "backup", "--db", str(db), "--out", str(out))
        assert r.returncode == 0, r.stderr
        [copy] = out.glob("device-*.sqlite3")
        assert counts(copy) == {"local_runs": 2, "telemetry_events": 5, "outbox": 5}
        assert oct(copy.stat().st_mode & 0o777) == "0o600"
        assert "outbox: 5" in r.stdout
    finally:
        live.close()


def test_restore_replaces_state_and_keeps_a_copy_of_what_it_replaced(tmp_path):
    db = tmp_path / "device.sqlite3"
    make_db(db, pending=4)
    out = tmp_path / "backups"
    assert tool(tmp_path / "opt", "backup", "--db", str(db), "--out", str(out)).returncode == 0
    [snapshot] = out.glob("device-*.sqlite3")

    # State moves on after the backup.
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM outbox")
    conn.commit()
    conn.close()

    r = tool(tmp_path / "opt", "restore", "--db", str(db), "--from", str(snapshot))
    assert r.returncode == 0, r.stderr
    assert counts(db)["outbox"] == 4
    [before] = tmp_path.glob("device.sqlite3.before-restore-*")
    assert counts(before)["outbox"] == 0


def test_restore_refuses_while_the_service_answers(tmp_path, health_server):
    url, _ = health_server
    db = tmp_path / "device.sqlite3"
    make_db(db)
    out = tmp_path / "b"
    assert tool(tmp_path / "opt", "backup", "--db", str(db), "--out", str(out)).returncode == 0
    [snapshot] = out.glob("device-*.sqlite3")
    r = tool(tmp_path / "opt", "restore", "--db", str(db), "--from", str(snapshot), health=url)
    assert r.returncode != 0
    assert "stop the service" in r.stderr


def test_restore_refuses_a_file_that_is_not_a_device_database(tmp_path):
    db = tmp_path / "device.sqlite3"
    make_db(db)
    junk = tmp_path / "junk.sqlite3"
    junk.write_bytes(b"not sqlite")
    r = tool(tmp_path / "opt", "restore", "--db", str(db), "--from", str(junk))
    assert r.returncode != 0
    assert counts(db)["outbox"] == 2
