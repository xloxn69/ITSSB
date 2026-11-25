"""Entry point: `python -m itssb_device` or `itssb-device`.

Milestone 1 status: this prints GPSD fixes so you can verify the receiver
end to end. Run recording, upload, and the local API come next (docs/15).
"""

from __future__ import annotations

import argparse
import socket
import sys

from .gps import WATCH_COMMAND, Rejected, fix_from_tpv, parse_line


def watch(host: str, port: int) -> int:
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(WATCH_COMMAND)
        stream = sock.makefile("rb")
        for line in stream:
            report = parse_line(line)
            if not report or report.get("class") != "TPV":
                continue
            try:
                fix = fix_from_tpv(report)
            except Rejected as reason:
                print(f"no usable fix: {reason}", flush=True)
                continue
            print(
                f"fix mode={fix.fix_mode} lat={fix.latitude:.6f} lon={fix.longitude:.6f} "
                f"speed={fix.speed_mps} capturedAtMs={fix.captured_at_ms}",
                flush=True,
            )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="itssb-device")
    parser.add_argument("--gpsd-host", default="127.0.0.1")
    parser.add_argument("--gpsd-port", type=int, default=2947)
    args = parser.parse_args(argv)
    try:
        return watch(args.gpsd_host, args.gpsd_port)
    except OSError as exc:
        print(f"cannot reach GPSD at {args.gpsd_host}:{args.gpsd_port}: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
