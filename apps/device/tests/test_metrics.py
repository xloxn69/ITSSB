"""Process/system measurements and upload retry counters (docs/13 §10)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from test_uploader import BOOT, TOKEN, Clock, SwitchableTransport, add

from itssb_device.database import Database
from itssb_device.devtools.fake_backend import FakeBackend
from itssb_device.metrics import SystemProbe, cpu_temperature_c, database_bytes
from itssb_device.status import StatusBoard
from itssb_device.uploader import (
    BASE_HEALTH_KEYS,
    HEALTH_BASE_ONLY_MS,
    HttpResponse,
    HttpTransport,
    Uploader,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"

STATUS = """Name:\tpython3
VmPeak:\t  90000 kB
VmRSS:\t   41236 kB
Threads:\t9
"""
MEMINFO = """MemTotal:        1919088 kB
MemFree:          201388 kB
MemAvailable:    1203572 kB
"""


def fake_roots(tmp_path, status=STATUS, meminfo=MEMINFO, temp="48312\n"):
    proc, sys_root = tmp_path / "proc", tmp_path / "sys"
    (proc / "self").mkdir(parents=True)
    zone = sys_root / "class" / "thermal" / "thermal_zone0"
    zone.mkdir(parents=True)
    if status is not None:
        (proc / "self" / "status").write_text(status)
    if meminfo is not None:
        (proc / "meminfo").write_text(meminfo)
    if temp is not None:
        (zone / "temp").write_text(temp)
    return proc, sys_root


def test_reads_present_files(tmp_path):
    proc, sys_root = fake_roots(tmp_path)
    db = tmp_path / "d.db"
    db.write_bytes(b"x" * 4096)
    Path(f"{db}-wal").write_bytes(b"y" * 100)
    assert SystemProbe(db, proc, sys_root).read() == {
        "processRssBytes": 41236 * 1024,
        "memAvailableBytes": 1203572 * 1024,
        "cpuTemperatureC": 48.3,
        "databaseBytes": 4196,
    }


def test_absent_files_are_null_not_guessed(tmp_path):
    proc, sys_root = fake_roots(tmp_path, status=None, meminfo=None, temp=None)
    assert SystemProbe(tmp_path / "missing.db", proc, sys_root).read() == {
        "processRssBytes": None,
        "memAvailableBytes": None,
        "cpuTemperatureC": None,
        "databaseBytes": None,
    }
    assert SystemProbe(None, proc, sys_root).read()["databaseBytes"] is None


@pytest.mark.parametrize(
    ("status", "meminfo"),
    [
        ("VmRSS:\tlots kB\n", "MemAvailable: 12.5 kB\n"),
        ("VmRSS:\t41236 MB\n", "MemAvailable:\n"),
        ("VmPeak:\t1 kB\n", "MemTotal: 1 kB\n"),  # field missing entirely
        ("\xff\xfe binary", "\x00"),
    ],
)
def test_malformed_memory_is_null(tmp_path, status, meminfo):
    proc, sys_root = fake_roots(tmp_path, status=status, meminfo=meminfo)
    out = SystemProbe(None, proc, sys_root).read()
    assert out["processRssBytes"] is None
    assert out["memAvailableBytes"] is None


@pytest.mark.parametrize("temp", ["", "hot\n", "48.3\n", "999999\n", "-273000\n", "4_8000\n"])
def test_malformed_or_impossible_temperature_is_null(tmp_path, temp):
    _, sys_root = fake_roots(tmp_path, temp=temp)
    assert cpu_temperature_c(sys_root) is None


def test_cold_but_real_temperature_is_kept(tmp_path):
    _, sys_root = fake_roots(tmp_path, temp="-5000")
    assert cpu_temperature_c(sys_root) == -5.0


def test_database_without_wal_counts_main_file(tmp_path):
    db = tmp_path / "d.db"
    db.write_bytes(b"x" * 10)
    assert database_bytes(db) == 10


def test_board_without_probe_reports_nulls():
    snap = StatusBoard(BOOT, upload_enabled=True).snapshot()
    assert set(snap["system"].values()) == {None}
    assert snap["upload"] == {
        "consecutiveFailures": 0,
        "retriesSinceStart": 0,
        "lastErrorClass": None,
        "lastErrorAtMs": None,
    }


# ── Retry counters ───────────────────────────────────────────────────


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


def test_retry_counters_across_failures_and_recovery(db, backend):
    add(db, 2)
    transport = SwitchableTransport(backend.origin)
    clock = Clock()
    board = StatusBoard(BOOT, upload_enabled=True, now_ms=clock)
    up = Uploader(db, board, transport, TOKEN, now_ms=clock)

    transport.offline = True
    assert up.upload_once() == "transport_error"
    clock.t = up.pause_until_ms
    assert up.upload_once() == "transport_error"
    transport.offline = False
    backend.mode = "down"  # HTTP 503
    clock.t = up.pause_until_ms
    assert up.upload_once() == "server_error"
    u = board.snapshot()["upload"]
    assert u["consecutiveFailures"] == 3
    assert u["retriesSinceStart"] == 3
    assert u["lastErrorClass"] == "http_503"
    failed_at = u["lastErrorAtMs"]
    assert failed_at == clock.t

    backend.mode = "ok"
    clock.t = up.pause_until_ms
    assert up.upload_once() == "ok"
    u = board.snapshot()["upload"]
    assert u["consecutiveFailures"] == 0  # recovered
    assert u["retriesSinceStart"] == 3  # history kept since start
    assert (u["lastErrorClass"], u["lastErrorAtMs"]) == ("http_503", failed_at)

    report = up.health_report()
    assert report["uploadConsecutiveFailures"] == 0
    assert report["uploadRetriesSinceStart"] == 3
    assert report["lastUploadErrorClass"] == "http_503"


def test_a_transport_failure_records_its_class_name_only(db, backend):
    add(db, 1)
    transport = SwitchableTransport(backend.origin)
    board = StatusBoard(BOOT, upload_enabled=True)
    up = Uploader(db, board, transport, TOKEN, now_ms=Clock())
    transport.offline = True
    up.upload_once()
    assert board.snapshot()["upload"]["lastErrorClass"] == "OSError"


class Garbage200(HttpTransport):
    def post(self, path, body, headers):
        return HttpResponse(200, {}, b"not json")


def test_unparseable_200s_count_as_consecutive_failures(db):
    add(db, 1)
    clock = Clock()
    board = StatusBoard(BOOT, upload_enabled=True)
    up = Uploader(db, board, Garbage200("http://127.0.0.1:1", 1.0), TOKEN, now_ms=clock)
    assert up.upload_once() == "bad_response"
    clock.t = up.pause_until_ms
    assert up.upload_once() == "bad_response"
    u = board.snapshot()["upload"]
    assert (u["consecutiveFailures"], u["lastErrorClass"]) == (2, "bad_response")


# ── Heartbeat: full report, and an older backend ─────────────────────


class StrictHealthServer(ThreadingHTTPServer):
    """A backend that, like one from before the measurement fields, refuses
    any key it does not know with 400 INVALID_REQUEST."""

    daemon_threads = True

    def __init__(self, known_keys):
        self.known = set(known_keys)
        self.reports: list[dict] = []
        super().__init__(("127.0.0.1", 0), _StrictHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class _StrictHandler(BaseHTTPRequestHandler):
    server: StrictHealthServer

    def log_message(self, *_):
        pass

    def do_POST(self):
        report = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.reports.append(report)
        if set(report) - self.server.known:
            status = 400
            out = {"schemaVersion": 1, "error": {"code": "INVALID_REQUEST", "message": "x"}}
        else:
            status, out = 200, {"schemaVersion": 1, "status": "accepted"}
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def strict_server():
    s = StrictHealthServer(BASE_HEALTH_KEYS)
    yield s
    s.shutdown()
    s.server_close()


def board_with_probe(tmp_path):
    proc, sys_root = fake_roots(tmp_path)
    return StatusBoard(
        BOOT, upload_enabled=True, system=SystemProbe(tmp_path / "d.db", proc, sys_root).read
    )


def test_report_carries_the_measurement_fields(db, tmp_path):
    board = board_with_probe(tmp_path)
    up = Uploader(db, board, HttpTransport("http://127.0.0.1:1", 1.0), TOKEN, now_ms=Clock())
    report = up.health_report()
    fixture = json.loads((FIXTURES / "health.report.withMetrics.json").read_text())
    assert set(report) == set(fixture)
    assert report["cpuTemperatureC"] == 48.3
    assert report["processRssBytes"] == 41236 * 1024
    assert report["databaseBytes"] > 0
    assert len(json.dumps(report, separators=(",", ":"))) < 2048  # MAX_HEALTH_BODY_BYTES


def test_an_older_backend_still_gets_the_base_report(db, tmp_path, strict_server):
    clock = Clock()
    up = Uploader(
        db,
        board_with_probe(tmp_path),
        HttpTransport(strict_server.origin, 2.0),
        TOKEN,
        now_ms=clock,
    )
    assert up.send_health() == "ok"
    full, base = strict_server.reports
    assert "cpuTemperatureC" in full
    assert set(base) == set(BASE_HEALTH_KEYS)

    # Base only for a while: one request per heartbeat, accepted.
    clock.t += HEALTH_BASE_ONLY_MS - 1
    assert up.send_health() == "ok"
    assert set(strict_server.reports[2]) == set(BASE_HEALTH_KEYS)
    assert len(strict_server.reports) == 3

    # Then the full report is offered again (the backend may be updated).
    clock.t += 1
    strict_server.known |= set(full)
    assert up.send_health() == "ok"
    assert "cpuTemperatureC" in strict_server.reports[3]
    assert len(strict_server.reports) == 4


def test_a_refusal_for_another_reason_is_not_retried_in_a_loop(db, tmp_path, strict_server):
    strict_server.known = set()  # refuses everything, even the base report
    up = Uploader(
        db,
        board_with_probe(tmp_path),
        HttpTransport(strict_server.origin, 2.0),
        TOKEN,
        now_ms=Clock(),
    )
    assert up.send_health() == "rejected"
    assert len(strict_server.reports) == 2  # full, then base once; no more
