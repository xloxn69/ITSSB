"""Entry point: `python -m itssb_device` or `itssb-device`.

Subcommands:
  run (default)  the device service: GPS reader, recorder, local API
  watch          bench test: print GPSD fixes / rejection reasons
  outbox         print outbox rows (eventId, status, attempts; no coordinates)
  hash-pin       print an scrypt hash of a driver PIN read from stdin, for drivers.json
  fixture-run    DEVELOPMENT ONLY: mark a fictional run active/completed locally,
                 standing in for online start until the backend has trip-events
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
from pathlib import Path

from .config import DEFAULT_ENV_FILE, ConfigError, load_config
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


def _env_file(arg: str | None) -> Path:
    return Path(arg or os.environ.get("ITSSB_ENV_FILE") or DEFAULT_ENV_FILE)


def cmd_run(args: argparse.Namespace) -> int:
    from .service import Service, setup_logging

    logging.basicConfig(level="INFO")  # until the configured logging is installed
    try:
        config = load_config(env_file=_env_file(args.env_file))
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    setup_logging(config.log_level, config.log_file)
    return Service(config).run_forever()


def cmd_watch(args: argparse.Namespace) -> int:
    try:
        return watch(args.gpsd_host, args.gpsd_port)
    except OSError as exc:
        print(f"cannot reach GPSD at {args.gpsd_host}:{args.gpsd_port}: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


def _db(args: argparse.Namespace):
    from .database import Database
    from .service import prepare_database

    config = load_config(env_file=_env_file(args.env_file))
    prepare_database(config.database_path)
    return Database(config.database_path)


def cmd_outbox(args: argparse.Namespace) -> int:
    db = _db(args)
    try:
        print(json.dumps({"counts": db.outbox_counts(), "run": db.active_run()}))
        for row in db.list_outbox(limit=args.limit):
            print(json.dumps(row))
    finally:
        db.close()
    return 0


def cmd_fixture_run(args: argparse.Namespace) -> int:
    print(
        "WARNING: development fixture. This run is NOT server-issued; a real backend "
        "will reject its telemetry.",
        file=sys.stderr,
    )
    db = _db(args)
    try:
        if args.action == "start":
            current = db.active_run()
            row = db.conn.execute(
                "SELECT state FROM local_runs WHERE run_id=?", (args.run_id,)
            ).fetchone()
            if row and row["state"] in ("completed", "cancelled"):
                print(f"run {args.run_id} is {row['state']}; never reactivated", file=sys.stderr)
                return 1
            if current and current["runId"] != args.run_id:
                print(f"another run is active: {current['runId']}", file=sys.stderr)
                return 1
            db.save_run(args.run_id, "active")
        else:
            db.save_run(args.run_id, "completed")
        print(json.dumps({"run": db.active_run()}))
    finally:
        db.close()
    return 0


def cmd_hash_pin(_args: argparse.Namespace) -> int:
    """Reads one PIN from stdin (never argv, which other users can see) and
    prints only its hash."""
    from .local_auth import hash_pin, valid_pin_format

    pin = sys.stdin.readline().strip()
    if not valid_pin_format(pin):
        print("PIN must be 4-12 digits", file=sys.stderr)
        return 2
    print(hash_pin(pin))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="itssb-device")
    parser.add_argument(
        "--env-file", help=f"settings file (default: $ITSSB_ENV_FILE or {DEFAULT_ENV_FILE})"
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("run", help="run the device service (default)").set_defaults(func=cmd_run)
    w = sub.add_parser("watch", help="print GPSD fixes for bench testing")
    w.add_argument("--gpsd-host", default="127.0.0.1")
    w.add_argument("--gpsd-port", type=int, default=2947)
    w.set_defaults(func=cmd_watch)
    o = sub.add_parser("outbox", help="print outbox rows")
    o.add_argument("--limit", type=int, default=100)
    o.set_defaults(func=cmd_outbox)
    sub.add_parser("hash-pin", help="hash a driver PIN read from stdin").set_defaults(
        func=cmd_hash_pin
    )
    f = sub.add_parser("fixture-run", help="DEVELOPMENT ONLY: set a fictional local run")
    f.add_argument("action", choices=["start", "end"])
    f.add_argument("--run-id", default="demo_run_001")
    f.set_defaults(func=cmd_fixture_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    func = getattr(args, "func", cmd_run)
    return func(args)


if __name__ == "__main__":
    raise SystemExit(main())
