"""Device health heartbeat (docs/08 §7, docs/13 D09)."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from test_uploader import BOOT, TOKEN, Clock, SwitchableTransport, add

from itssb_device.database import Database
from itssb_device.status import StatusBoard
from itssb_device.uploader import HttpTransport, Uploader

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


class HealthServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        self.reports: list[dict] = []
        self.status = 200
        super().__init__(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.server_address[1]}"


class _Handler(BaseHTTPRequestHandler):
    server: HealthServer

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        assert self.path == "/device/v1/health"
        assert self.headers["Authorization"] == f"Bearer {TOKEN}"
        self.server.reports.append(json.loads(body))
        out = json.dumps({"schemaVersion": 1, "status": "accepted"}).encode()
        self.send_response(self.server.status)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture
def server():
    s = HealthServer()
    yield s
    s.shutdown()
    s.server_close()


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "d.db")
    d.save_run("demo_run_001", "active")
    yield d
    d.close()


def no_fix_board():
    board = StatusBoard(BOOT, upload_enabled=True)
    board.gpsd_state("connected")
    board.gps_receivers(1)
    board.gps_fix(1_795_609_025_000, 3)
    return board


def test_report_has_exactly_the_contract_fields_and_no_coordinates(db, server):
    add(db, 2)
    board = no_fix_board()
    up = Uploader(db, board, HttpTransport(server.origin, 2.0), TOKEN, now_ms=Clock())
    report = up.health_report()
    fixture = json.loads((FIXTURES / "health.report.noFix.json").read_text())
    assert set(report) == set(fixture)
    assert report["bootId"] == BOOT
    assert report["runId"] == "demo_run_001"
    assert report["pendingCount"] == 2
    assert report["lastValidFixAtMs"] == 1_795_609_025_000
    assert report["gpsStatus"] in ("valid", "no_fix")  # by local receipt age
    assert not {"latitude", "longitude"} & set(report)


def test_d09_gps_loss_is_reported_as_no_fix(db, server):
    board = no_fix_board()
    board._gps.last_fix_mono -= 60  # last fix a minute ago: no fix now
    up = Uploader(db, board, HttpTransport(server.origin, 2.0), TOKEN, now_ms=Clock())
    assert up.send_health() == "ok"
    [sent] = server.reports
    assert sent["gpsStatus"] == "no_fix"
    assert sent["lastValidFixAtMs"] == 1_795_609_025_000  # keeps its timestamp


def test_health_never_touches_the_queue_and_a_success_ends_an_offline_pause(db, server):
    ids = add(db, 3)
    board = no_fix_board()
    transport = SwitchableTransport(server.origin)
    up = Uploader(db, board, transport, TOKEN, now_ms=Clock())
    transport.offline = True
    assert up.upload_once() == "transport_error"
    assert up.paused_unreachable
    assert up.send_health() == "transport_error"
    assert board.snapshot()["network"]["status"] == "offline"
    transport.offline = False
    assert up.send_health() == "ok"
    assert not up.paused_unreachable  # the link is back: resume uploads now
    assert board.snapshot()["network"]["status"] == "online"
    assert [db.outbox_status(i) for i in ids] == ["pending"] * 3  # health acks nothing


def test_an_old_backend_without_health_is_harmless(db, server):
    server.status = 404
    up = Uploader(db, no_fix_board(), HttpTransport(server.origin, 2.0), TOKEN, now_ms=Clock())
    assert up.send_health() == "rejected"
    assert up.pause_until_ms == 0  # uploads are not paused by a health failure
