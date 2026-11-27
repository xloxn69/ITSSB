"""A tiny fake GPSD for tests and bench demos. FICTIONAL data only.

    python -m itssb_device.devtools.fake_gpsd --port 2948 --mode fix

Speaks just enough of the GPSD JSON protocol: VERSION, DEVICES, then one TPV
per second. `--mode fix` reports a fictional moving position stamped with the
current time; `nofix` reports mode 1; `nodevice` reports no receivers and then
stays silent, like a real GPSD with the USB receiver unplugged.

`--control FILE` switches behavior live for bench demos: the file holds
`drive` (moving fix), `stop` (fix at rest), or `nofix`, re-read every tick.
The fictional position only advances while driving, so stop-and-go looks
like one continuous trip.

It exists so the outbox/restart path can be exercised indoors, where a real
receiver correctly reports no fix. Never point a production device at it.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import socketserver
import threading
from datetime import UTC, datetime

# Fictional coordinates (docs/08 examples), not anyone's real location.
DEMO_LAT, DEMO_LON = 34.1, -83.98


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class FakeGpsd(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self, port: int = 0, mode: str = "fix", interval_s: float = 1.0, control: str | None = None
    ) -> None:
        self.mode = mode
        self.control = control
        self.interval_s = interval_s
        self.stopping = threading.Event()
        super().__init__(("127.0.0.1", port), _Handler)

    @property
    def port(self) -> int:
        return self.server_address[1]

    def start(self) -> FakeGpsd:
        threading.Thread(target=self.serve_forever, name="fake-gpsd", daemon=True).start()
        return self

    def stop(self) -> None:
        self.stopping.set()
        self.shutdown()
        self.server_close()


class _Handler(socketserver.StreamRequestHandler):
    server: FakeGpsd

    def _send(self, obj: dict) -> None:
        self.wfile.write(json.dumps(obj).encode() + b"\n")
        self.wfile.flush()

    def handle(self) -> None:
        srv = self.server
        try:
            self._send({"class": "VERSION", "release": "fake-3.25", "proto_major": 3})
            self.request.settimeout(5)
            self.rfile.readline()  # ?WATCH=...
            devices = [] if srv.mode == "nodevice" else [{"class": "DEVICE", "path": "/dev/fake"}]
            self._send({"class": "DEVICES", "devices": devices})
            self._send({"class": "WATCH", "enable": True, "json": True})
            step = 0
            while not srv.stopping.is_set():
                mode = srv.mode
                if srv.control:
                    with contextlib.suppress(OSError), open(srv.control) as f:
                        mode = {"drive": "fix", "stop": "stopped"}.get(f.read().strip(), "nofix")
                if mode == "stopped":
                    self._send(
                        {
                            "class": "TPV",
                            "mode": 3,
                            "time": _now_iso(),
                            "lat": DEMO_LAT + step * 1e-5,
                            "lon": DEMO_LON + (step // 40) * 2e-4,
                            "speed": 0.0,
                            "track": 0.0,
                            "eph": 6.0,
                        }
                    )
                    srv.stopping.wait(srv.interval_s)
                    continue
                if mode == "fix":
                    self._send(
                        {
                            "class": "TPV",
                            "mode": 3,
                            "time": _now_iso(),
                            "lat": DEMO_LAT + step * 1e-5,
                            "lon": DEMO_LON + (step // 40) * 2e-4,
                            "speed": 5.0,
                            "track": 0.0,
                            "eph": 6.0,
                        }
                    )
                elif mode == "nofix":
                    self._send({"class": "TPV", "mode": 1, "time": _now_iso()})
                step += 1
                srv.stopping.wait(srv.interval_s)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fake_gpsd", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=2948)
    parser.add_argument("--mode", choices=["fix", "nofix", "nodevice"], default="fix")
    parser.add_argument("--control", help="file holding drive|stop|nofix, re-read every tick")
    args = parser.parse_args(argv)
    server = FakeGpsd(args.port, args.mode, control=args.control)
    print(f"fake gpsd ({args.mode}, FICTIONAL data) on 127.0.0.1:{server.port}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
