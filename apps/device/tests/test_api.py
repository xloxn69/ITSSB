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


# ── Driver UI and API through the real HTTP server ──────────────────


@pytest.fixture
def driver_server(tmp_path):
    from itssb_device.database import Database
    from itssb_device.driver_api import DriverApi
    from itssb_device.local_auth import SessionManager, allowed_origins
    from itssb_device.motion import MotionJudge, ObservedFixHolder

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html><title>ITSSB Driver</title>")
    db_path = tmp_path / "d.sqlite3"
    Database(db_path).close()
    board = StatusBoard("3cd44c56-c96b-4b83-a970-5414990bc25a", upload_enabled=False)
    latest = ObservedFixHolder()
    judge = MotionJudge(latest)
    server = LocalApiServer("127.0.0.1", 0, board)
    port = server.server_address[1]
    server.driver_api = DriverApi(
        board, SessionManager({}), judge, latest, db_path, static, allowed_origins(port)
    )
    server.start()
    yield server, port
    server.shutdown()
    server.server_close()


def call(port, method, path, headers=None, body=b""):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, body=body, headers=headers or {})
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp, data


def test_ui_page_sets_session_cookie_and_csp(driver_server):
    _, port = driver_server
    resp, body = call(port, "GET", "/")
    assert resp.status == 200 and b"ITSSB Driver" in body
    assert "HttpOnly" in resp.getheader("Set-Cookie")
    assert "frame-ancestors 'none'" in resp.getheader("Content-Security-Policy")
    assert resp.getheader("Access-Control-Allow-Origin") is None


def test_post_with_foreign_host_is_refused_before_anything_else(driver_server):
    _, port = driver_server
    resp, _ = call(port, "POST", "/api/session/lock", {"Host": "evil.example.invalid"}, b"{}")
    assert resp.status == 421


def test_post_end_to_end_lock_with_session_and_csrf(driver_server):
    _, port = driver_server
    resp, _ = call(port, "GET", "/")
    cookie = resp.getheader("Set-Cookie").split(";", 1)[0]
    resp, body = call(port, "GET", "/api/session", {"Cookie": cookie})
    csrf = json.loads(body)["csrfToken"]
    headers = {
        "Cookie": cookie,
        "Origin": f"http://127.0.0.1:{port}",
        "Content-Type": "application/json",
        "X-ITSSB-CSRF": csrf,
    }
    resp, _ = call(port, "POST", "/api/session/lock", headers, b"{}")
    assert resp.status == 200
    resp, _ = call(
        port, "POST", "/api/session/lock", {**headers, "Origin": "http://evil.example"}, b"{}"
    )
    assert resp.status == 403


def test_post_body_limit(driver_server):
    _, port = driver_server
    resp, _ = call(port, "POST", "/api/session/lock", {"Content-Length": "999999"}, b"")
    assert resp.status == 413
