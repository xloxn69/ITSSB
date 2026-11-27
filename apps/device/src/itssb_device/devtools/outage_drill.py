"""Bench outage drill: one authorized run through link loss, GPS loss, and kill -9.

    python -m itssb_device.devtools.outage_drill --workdir var/drill \\
        --upstream https://example.convex.site --token-file ~/.itssb-drill-token

Before running, record a SERVER-ISSUED active run in the drill database
(`fixture-run start --run-id <runId>` with ITSSB_DATABASE_PATH pointing at
`<workdir>/device.sqlite3`). The drill never creates a run.

It starts its own fake GPSD (FICTIONAL positions), the link proxy, and the
real device service on non-default loopback ports, then walks a fixed
timeline (docs/13 D05, D07, D08, D09):

1. baseline              link up, GPS fix
2. link down             queue must grow; nothing claimed as synced
3. link restored         time to the first acknowledgement is measured
4. GPS lost              no new observations; last fix keeps its time
5. GPS back
6. link down + kill -9   restart recovers the same run with a new bootId
7. link restored, drain  GPS stopped, outbox drained, then SIGTERM

Every 5 s it writes one transcript line from the local health API (status
fields and counts only: no coordinates, no token). At the end it checks the
outbox: every row acknowledged, eventIds unique, runSequence unbroken, and
writes the eventIds to `<workdir>/eventids.txt` for comparison with the
backend. The link and GPS failures are SIMULATED; the transcript says so.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from ..database import Database

GPSD_PORT = 2951
PROXY_PORT = 8793
API_PORT = 8767


def _log(out, text: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {text}"
    print(line, flush=True)
    out.write(line + "\n")
    out.flush()


def _health() -> dict | None:
    try:
        conn = http.client.HTTPConnection("127.0.0.1", API_PORT, timeout=2)
        conn.request("GET", "/health")
        data = json.loads(conn.getresponse().read())
        conn.close()
        return data
    except (OSError, ValueError):
        return None


def _summary(h: dict | None) -> str:
    if h is None:
        return "service not answering"
    o, r = h["outbox"], h["recorder"]
    oldest = o.get("oldestPendingCapturedAtMs")
    behind = f"{(h['generatedAtMs'] - oldest) // 1000}s" if oldest else "-"
    return (
        f"boot={h['process']['bootId'][:8]} run={(h['run'] or {}).get('runId', '-')} "
        f"gps={h['gps']['status']} lastFix={h['gps']['lastValidFixCapturedAtMs']} "
        f"net={h['network']['status']} backend={h['backend']['status']} "
        f"pending={o['pending']} acked={o['acknowledged']} rejected={o['rejected']} "
        f"behind={behind} savedThisBoot={r['observationsThisBoot']}"
    )


class Drill:
    def __init__(self, workdir: Path, upstream: str, token: str, out, shots: bool = False) -> None:
        self.workdir, self.upstream, self.token, self.out = workdir, upstream, token, out
        self.shots = shots
        self.db_path = workdir / "device.sqlite3"
        self.gps_control = workdir / "gps"
        self.link_control = workdir / "link"
        self.procs: list[subprocess.Popen] = []
        self.service: subprocess.Popen | None = None

    def _spawn(self, args: list[str], env: dict[str, str] | None = None) -> subprocess.Popen:
        log = open(self.workdir / f"{args[1].rsplit('.', 1)[-1]}.log", "a")  # noqa: SIM115
        p = subprocess.Popen(  # noqa: S603 - our own modules, fixed arguments
            [sys.executable, *args],
            env={**os.environ, **(env or {})},
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
        )
        self.procs.append(p)
        return p

    def start_service(self) -> None:
        self.service = self._spawn(
            ["-m", "itssb_device", "run"],
            {
                "ITSSB_ENV_FILE": str(self.workdir / "none.env"),
                "ITSSB_DATABASE_PATH": str(self.db_path),
                "ITSSB_GPSD_PORT": str(GPSD_PORT),
                "ITSSB_LOCAL_API_PORT": str(API_PORT),
                "ITSSB_PUBLISH_INTERVAL_SECONDS": "2",
                "ITSSB_UPLOAD_INTERVAL_SECONDS": "2",
                "ITSSB_DEVICE_API_ORIGIN": f"http://127.0.0.1:{PROXY_PORT}",
                "ITSSB_DEVICE_TOKEN": self.token,
            },
        )
        deadline = time.monotonic() + 20
        while _health() is None and time.monotonic() < deadline:
            time.sleep(0.5)

    def watch(self, seconds: float, until=None) -> float | None:
        """Logs health every 5 s. Returns seconds until `until(health)` held."""
        start = time.monotonic()
        next_line = start
        while (elapsed := time.monotonic() - start) < seconds:
            h = _health()
            if until is not None and h is not None and until(h):
                _log(self.out, f"  condition met after {elapsed:.1f}s: {_summary(h)}")
                return elapsed
            if time.monotonic() >= next_line:
                _log(self.out, "  " + _summary(h))
                next_line += 5
            time.sleep(0.5)
        return None

    def phase(self, text: str) -> None:
        _log(self.out, f"== {text}")

    def shot(self, name: str) -> None:
        """Marks a moment for a driver-screen capture. The page is served on
        loopback only, so the capture is taken from another machine through
        an SSH tunnel (headless Chromium on a 2 GB Pi stalls on a polling
        page); the marker lets it pick the right moment."""
        if self.shots:
            (self.workdir / "shot-request").write_text(name)
            _log(self.out, f"  driver screen capture point: {name}")
            time.sleep(8)

    def run(self) -> int:
        self.gps_control.write_text("drive")
        self.link_control.write_text("up")
        self._spawn(
            [
                "-m",
                "itssb_device.devtools.fake_gpsd",
                "--port",
                str(GPSD_PORT),
                "--control",
                str(self.gps_control),
            ]
        )
        self._spawn(
            [
                "-m",
                "itssb_device.devtools.link_proxy",
                "--port",
                str(PROXY_PORT),
                "--upstream",
                self.upstream,
                "--control",
                str(self.link_control),
            ]
        )
        time.sleep(2)
        db = Database(self.db_path)
        run = db.active_run()
        db.close()
        if run is None:
            _log(self.out, "no active run in the drill database; record a server-issued one first")
            return 2
        _log(self.out, f"run {run['runId']} nextRunSequence={run['nextRunSequence']}")
        _log(self.out, "NOTE: GPS positions are FICTIONAL (fake GPSD); link loss is SIMULATED")

        self.start_service()
        self.phase("1 baseline: link up, GPS fix")
        self.watch(40)
        self.shot("1-baseline")

        self.phase("2 D07 link DOWN, GPS still valid")
        self.link_control.write_text("down")
        self.watch(60)
        self.shot("2-link-down")
        self.watch(30)

        self.phase("3 D08 link RESTORED with a backlog")
        acked_before = (_health() or {}).get("outbox", {}).get("acknowledged", 0)
        self.link_control.write_text("up")
        took = self.watch(60, until=lambda h: h["outbox"]["acknowledged"] > acked_before)
        _log(self.out, f"  first acknowledgement after restore: {took}s")
        self.watch(30, until=lambda h: h["outbox"]["pending"] <= 1)

        self.phase("4 D09 GPS LOST (receiver connected, no fix), link up")
        self.gps_control.write_text("nofix")
        self.watch(30)
        self.shot("4-gps-lost")
        self.watch(30)

        self.phase("5 GPS back")
        self.gps_control.write_text("drive")
        self.watch(30)

        self.phase("6 D05 link DOWN, then kill -9 mid-run")
        self.link_control.write_text("down")
        self.watch(20)
        if self.service is None:
            return 1
        old_pid = self.service.pid
        self.service.send_signal(signal.SIGKILL)
        self.service.wait(10)
        _log(self.out, f"  SIGKILL sent to the service (pid {old_pid}); restarting")
        self.start_service()
        self.watch(20)
        self.shot("6-after-kill-offline")

        self.phase("7 link RESTORED; GPS stopped; drain")
        self.link_control.write_text("up")
        self.watch(30)
        self.gps_control.write_text("nofix")
        self.watch(120, until=lambda h: h["outbox"]["pending"] == 0)
        self.service.send_signal(signal.SIGTERM)
        self.service.wait(30)
        _log(self.out, f"  service stopped with SIGTERM (exit {self.service.returncode})")
        return self.verify(run["runId"])

    def verify(self, run_id: str) -> int:
        db = Database(self.db_path)
        rows = [r for r in db.list_outbox(1_000_000) if r["runId"] == run_id]
        db.close()
        ids = [r["eventId"] for r in rows]
        seqs = sorted(r["runSequence"] for r in rows)
        statuses: dict[str, int] = {}
        for r in rows:
            statuses[r["status"]] = statuses.get(r["status"], 0) + 1
        unbroken = seqs == list(range(seqs[0], seqs[0] + len(seqs))) if seqs else False
        (self.workdir / "eventids.txt").write_text("\n".join(ids) + "\n")
        self.phase("verify local outbox")
        _log(self.out, f"  rows={len(rows)} statuses={statuses}")
        _log(self.out, f"  unique eventIds={len(set(ids)) == len(ids)}")
        rng = f"{seqs[0]}..{seqs[-1]}" if seqs else "-"
        _log(self.out, f"  runSequence {rng} unbroken={unbroken}")
        ok = rows and statuses == {"acknowledged": len(rows)} and len(set(ids)) == len(ids)
        _log(self.out, "  RESULT " + ("PASS" if ok and unbroken else "FAIL"))
        return 0 if ok and unbroken else 1

    def stop(self) -> None:
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="outage_drill", description=__doc__.splitlines()[0])
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--upstream", required=True, help="https origin of the DEV backend")
    parser.add_argument("--token-file", type=Path, required=True, help="file with the device token")
    parser.add_argument("--screenshots", action="store_true", help="mark capture points")
    args = parser.parse_args(argv)
    args.workdir.mkdir(parents=True, exist_ok=True)
    token = args.token_file.expanduser().read_text().strip()
    with open(args.workdir / "transcript.txt", "a") as out:
        drill = Drill(args.workdir, args.upstream, token, out, args.screenshots)
        try:
            return drill.run()
        finally:
            drill.stop()


if __name__ == "__main__":
    raise SystemExit(main())
