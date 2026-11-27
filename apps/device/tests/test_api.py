import http.client
import json

import pytest

from itssb_device.api import LocalApiServer, render_page
from itssb_device.status import StatusBoard


@pytest.fixture
def api():
    board = StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=False)
    server = LocalApiServer("127.0.0.1", 0, board)
    server.start()
    yield server
    server.shutdown()
    server.server_close()


def request(server, method="GET", path="/health", host=None):
    port = server.server_address[1]
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Host": host} if host is not None else {}
    conn.request(method, path, headers=headers)
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp, body


def test_health_keeps_gps_network_backend_separate(api):
    resp, body = request(api)
    assert resp.status == 200
    assert resp.getheader("Cache-Control") == "no-store"
    assert resp.getheader("Access-Control-Allow-Origin") is None
    snap = json.loads(body)
    assert snap["gps"]["status"] == "unknown"  # GPSD not connected yet: unknown, not no_fix
    assert snap["network"]["status"] == "unknown"
    assert snap["backend"]["status"] == "unconfigured"
    assert snap["run"] is None


def test_foreign_host_header_is_refused(api):
    resp, _ = request(api, host="evil.example.invalid")
    assert resp.status == 421


@pytest.mark.parametrize("host", ["localhost:8765", "127.0.0.1", "[::1]:8765"])
def test_loopback_host_headers_allowed(api, host):
    resp, _ = request(api, host=host)
    assert resp.status == 200


def test_state_changing_methods_refused(api):
    resp, _ = request(api, method="POST")
    assert resp.status == 405


def test_status_page_loads(api):
    resp, body = request(api, path="/")
    assert resp.status == 200
    assert b"no active run" in body


def test_refuses_non_loopback_bind():
    board = StatusBoard("b", upload_enabled=False)
    with pytest.raises(ValueError, match="loopback"):
        LocalApiServer("0.0.0.0", 0, board)  # noqa: S104


def test_page_escapes_values():
    board = StatusBoard("b", upload_enabled=False)
    board.gps_rejected("<script>")
    board.gpsd_state("connected")
    assert "<script>" not in render_page(board.snapshot())
