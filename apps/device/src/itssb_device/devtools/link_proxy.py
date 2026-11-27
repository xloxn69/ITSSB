"""A switchable stand-in for the bus internet link, for outage drills.

    python -m itssb_device.devtools.link_proxy --port 8791 \\
        --upstream https://example.convex.site --control var/link

The device service talks plain HTTP to this loopback port (allowed for
loopback only) and the proxy forwards each request to the real HTTPS
backend. The control file holds `up` or `down` and is re-read every
half second. While `down` the listening socket is closed, so connections
are refused exactly like a dead route, and the device's own reconnect and
backlog logic is what gets exercised. Nothing is cached, retried, or
rewritten: requests and answers pass through byte for byte.

It simulates a link outage without root. It cannot reproduce every real
failure (DNS loss, a captive portal, a modem that hangs), so drill
transcripts must say the outage was simulated. Never use it on a bus.
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "host", "content-length"}


class _Forwarder(BaseHTTPRequestHandler):
    upstream: tuple[str, int]
    context: ssl.SSLContext

    def log_message(self, *_args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        host, port = self.upstream
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn = http.client.HTTPSConnection(host, port, timeout=30, context=self.context)
        try:
            conn.request("POST", self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
        except OSError:
            self.close_connection = True
            return  # no answer: the device sees a lost response
        finally:
            conn.close()
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class LinkProxy:
    def __init__(self, port: int, upstream: str, control: str) -> None:
        parts = urlsplit(upstream)
        if parts.scheme != "https" or not parts.hostname:
            raise SystemExit("--upstream must be an https origin")
        handler = type(
            "Forwarder",
            (_Forwarder,),
            {
                "upstream": (parts.hostname, parts.port or 443),
                "context": ssl.create_default_context(),
            },
        )
        self.port, self.handler, self.control = port, handler, control
        self.server: ThreadingHTTPServer | None = None

    def _wanted(self) -> str:
        with contextlib.suppress(OSError), open(self.control) as f:
            return "down" if f.read().strip() == "down" else "up"
        return "up"

    def _set(self, state: str) -> None:
        if state == "up" and self.server is None:
            ThreadingHTTPServer.allow_reuse_address = True
            self.server = ThreadingHTTPServer(("127.0.0.1", self.port), self.handler)
            self.server.daemon_threads = True
            threading.Thread(target=self.server.serve_forever, daemon=True).start()
            print(f"{time.strftime('%H:%M:%S')} link UP", flush=True)
        elif state == "down" and self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
            print(f"{time.strftime('%H:%M:%S')} link DOWN (connections refused)", flush=True)

    def run(self) -> None:
        while True:
            self._set(self._wanted())
            time.sleep(0.5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="link_proxy", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--upstream", required=True, help="https origin of the backend")
    parser.add_argument("--control", required=True, help="file holding up|down")
    args = parser.parse_args(argv)
    with contextlib.suppress(KeyboardInterrupt):
        LinkProxy(args.port, args.upstream, args.control).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
