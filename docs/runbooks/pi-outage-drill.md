# Runbook: Pi outage drill (real link, real GPSD, reboot)

Owner-run steps for the docs/13 §12 cases that need root or physical access:
a real network pull, stopping the real GPSD, and an OS reboot in the middle of
an authorized run. Agents run the same timeline without root using
`apps/device/src/itssb_device/devtools/outage_drill.py` (simulated link,
fake GPSD, `kill -9`). This runbook covers the parts that the drill can't simulate.

Use the **development** backend and a fictional device and route only. Never
run this on a bus in service.

## Before you start

1. The Pi runs the installed service (`itssb-device.service`) from the
   current release, with a dev device credential in `/etc/itssb/device.env`
   (see [device-credentials.md](device-credentials.md)).
2. Start a run from the driver screen on a fictional route. The health page
   (`curl -s http://127.0.0.1:8765/health`) shows `run.runId` and
   `gps.status: valid`. Write down the `runId`.
3. Open the family view for that route (iPhone or web) as a fictional student.

## 1. Real network pull (D07, D08)

1. Turn off Wi-Fi on the Pi (or unplug the uplink) while GPS has a fix.
2. Wait 2 minutes. Expect:
   - On the driver screen: Internet or School server shows a problem, and
     "Waiting to sync" grows.
   - In the family view: the position ages and turns "Last known location".
     It never looks current.
3. Turn Wi-Fi back on. Expect the family view to show a fresh position within
   about 10 s, and "Waiting to sync" to return to 0 within a minute.

## 2. Stop the real GPSD (D09)

1. `sudo systemctl stop gpsd.socket gpsd` while the network is up.
2. Expect:
   - On the driver screen: GPS shows "GPS service down".
   - In the family view: no new positions, and the last position keeps its
     time. GPSD down is reported to families as no GPS status, not as a fix
     problem.
3. `sudo systemctl start gpsd.socket gpsd`. GPS returns to Fix.

To see the family-side "Bus location unavailable", move the receiver indoors
(no fix) or unplug it (receiver missing) instead of stopping GPSD.

## 3. Reboot mid-run (D05)

1. With the run active and a few rows waiting (turn Wi-Fi off first if you
   want a backlog), run `sudo reboot`.
2. After boot, the service starts on its own. Expect:
   - The health page shows the same `run.runId` and a new `process.bootId`.
   - The pending count matches the count before the reboot, or is lower
     once the backlog has drained.
3. End the run from the driver screen once "Waiting to sync" reaches 0.

## 4. Check that nothing was lost or duplicated

Take a consistent copy of the database (SQLite's backup API includes rows
still in the WAL file, which a plain `cp` can miss), then check the outbox for
the run. The check reads the copy only:

```sh
mkdir -p /tmp/drill
sudo python3 -c "import sqlite3; sqlite3.connect('/var/lib/itssb/device.sqlite3').backup(sqlite3.connect('/tmp/drill/device.sqlite3'))"
sudo chown "$USER" /tmp/drill/device.sqlite3
PYTHONPATH=/opt/itssb/current/src python3 -m itssb_device.devtools.outage_drill \
  --workdir /tmp/drill --upstream https://example.invalid --token-file /dev/null \
  --verify-only <runId>
```

`RESULT PASS` means every row for the run was acknowledged, every eventId is
unique, and runSequence has no gap. Record the result, the date, the release
version and the runId in the docs/13 §12 table.
