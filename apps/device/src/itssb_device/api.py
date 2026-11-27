"""Local status API on 127.0.0.1:8765 (docs/04 §12).

Standard library only. Read-only for now:

- `GET /health`: JSON snapshot. GPS, network, and backend are separate.
- `GET /`: a minimal status page that loads without internet.

Loopback binding is enforced at config time and again here. The Host header
must name a loopback host, which blocks DNS-rebinding pages from reading the
API. No CORS headers are sent, so other origins cannot read responses.
"""

from __future__ import annotations

import html
import json
import logging
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .config import is_loopback
from .status import StatusBoard

log = logging.getLogger(__name__)


def _host_allowed(header: str | None) -> bool:
    if not header:
        return False
    host = header.strip()
    if host.startswith("["):  # [::1]:8765
        host = host[1 : host.find("]")] if "]" in host else ""
    else:
        host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    return is_loopback(host)


def _age(ms: int | None) -> str:
    if ms is None:
        return "never"
    s = ms // 1000
    return f"{s}s ago" if s < 120 else f"{s // 60}m ago"


def render_page(snap: dict[str, Any]) -> str:
    g, n, b, o, r = snap["gps"], snap["network"], snap["backend"], snap["outbox"], snap["run"]
    rows = [
        ("GPS", f"{g['status']} (gpsd {g['gpsd']}; last valid fix {_age(g['lastValidFixAgeMs'])})"),
        ("GPS detail", g["lastRejectReason"] or g["gpsdError"] or "-"),
        ("Network", f"{n['status']}" + (f" ({n['detail']})" if n["detail"] else "")),
        ("Backend", f"{b['status']}" + (f" ({b['detail']})" if b["detail"] else "")),
        ("Run", f"{r['runId']} {r['state']}" if r else "no active run"),
        ("Recording", f"FAULT: {snap['recorder']['fault']}" if snap["recorder"]["fault"] else "ok"),
        (
            "Outbox",
            f"{o['pending']} pending, {o['acknowledged']} acknowledged, {o['rejected']} rejected",
        ),
        (
            "Process",
            f"v{snap['process']['version']} boot {snap['process']['bootId'][:8]} "
            f"up {snap['process']['uptimeS']}s",
        ),
    ]
    body = "".join(
        f"<tr><th>{html.escape(k)}</th><td>{html.escape(str(v))}</td></tr>" for k, v in rows
    )
    return (
        "<!doctype html><html lang=en><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<meta http-equiv=refresh content=2><title>ITSSB device status</title>"
        "<style>body{font:16px system-ui,sans-serif;margin:1rem;background:#fff;color:#111}"
        "th{text-align:left;padding:.3rem 1rem .3rem 0}td{padding:.3rem 0}</style></head>"
        f"<body><h1>ITSSB device status</h1><table>{body}</table>"
        "<p>Ages are measured on this device; this page refreshes every 2 seconds.</p>"
        "</body></html>"
    )


class _Handler(BaseHTTPRequestHandler):
    server: LocalApiServer
    server_version = "itssb-device"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:
        log.debug("local api: " + format, *args)

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, separators=(",", ":")).encode(), "application/json")

    def do_GET(self) -> None:
        if not _host_allowed(self.headers.get("Host")):
            self._json(HTTPStatus.MISDIRECTED_REQUEST, {"error": "host not allowed"})
            return
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._json(HTTPStatus.OK, self.server.board.snapshot())
        elif path == "/":
            page = render_page(self.server.board.snapshot()).encode()
            self._send(HTTPStatus.OK, page, "text/html; charset=utf-8")
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _method_not_allowed(self) -> None:
        self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})

    do_POST = do_PUT = do_PATCH = do_DELETE = _method_not_allowed


class LocalApiServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, board: StatusBoard) -> None:
        if not is_loopback(host):
            raise ValueError("local API must bind to a loopback address")
        self.board = board
        super().__init__((host, port), _Handler)

    def start(self) -> threading.Thread:
        thread = threading.Thread(target=self.serve_forever, name="local-api", daemon=True)
        thread.start()
        return thread
