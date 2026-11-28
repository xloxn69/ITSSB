# 16 — Troubleshooting I.T.S.S.B.

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

Diagnose one boundary at a time: power/display → Linux USB → GPSD → Pi application → backend → Swift app. This guide uses the planned paths and service names from the implementation guides. Commands referencing the custom application apply only after it has been built and installed.

Read alongside [hardware](02_HARDWARE_ASSEMBLY.md), [Pi setup](03_RASPBERRY_PI_SETUP.md), [Pi software](04_RASPBERRY_PI_SOFTWARE.md), and [testing](13_TESTING_AND_ACCEPTANCE.md).

## 1. Begin with the observed symptom

Write down the time, current route/run if any, what the screen actually says, the last action, and whether the problem affects one device or several. Note whether the bus is safely stopped before investigating.

Do not start by erasing the card, deleting the database, installing an unrelated driver, or changing several settings together. Preserve evidence and change one relevant thing at a time.

Useful initial Pi checks:

~~~bash
cat /etc/os-release
~~~

~~~bash
df -h
~~~

~~~bash
systemctl status gpsd.socket gpsd.service itssb-device.service --no-pager
~~~

~~~bash
sudo journalctl -u itssb-device.service -b --no-pager -n 100
~~~

A message that `itssb-device.service` does not exist is expected before the custom service has been created. These Markdown files are documentation, not an installer.

Logs and coordinates can contain private information. Share a redacted diagnostic summary, not an unrestricted database or complete credential file.

## 2. No display or no boot

**Possible boundary:** power, microSD, ribbon, display power, or OS.

1. Confirm the official supply and intended USB-C power connection.
2. Observe whether the Pi is booting or completely unpowered.
3. If an authorized SSH connection works, the OS may be alive while the display path is failing.
4. Shut down and remove power before checking the display ribbon or power lead.
5. Compare orientation and connector placement to the actual manufacturer diagrams.
6. If a card problem is suspected, preserve it before attempting recovery or using a separately prepared spare.

Do not move small display connectors while powered. The display power connection is described in [02_HARDWARE_ASSEMBLY.md](02_HARDWARE_ASSEMBLY.md), with the official source.

A successful boot to the desktop proves only that part of the system. It does not show that the GPS or application works.

## 3. Picture rotated, touch wrong, or text too small

**Possible boundary:** desktop rotation, input mapping, or UI layout.

Use the installed desktop's display settings. Then touch all four corners and buttons near each edge. Do not assume image rotation automatically established correct touch behavior.

The target layout is 1280 × 720 landscape. If the frontend is designed for a larger desktop and merely shrunk, correct the responsive layout rather than lowering readability.

Confirm browser zoom is at its intended value and that the screen uses the target resolution. Test with the actual seven-inch display, not only a laptop screenshot. See [driver touchscreen](05_DRIVER_TOUCHSCREEN.md).

## 4. GPS receiver is not detected

**Possible boundary:** USB, cable, port, kernel support, or power.

~~~bash
lsusb
~~~

~~~bash
sudo journalctl -k -b --no-pager -n 100
~~~

Compare device enumeration before and after reconnecting the receiver during a safe desk test. A stable USB connection should not repeatedly disappear under normal load.

Inspect the actual serial nodes:

~~~bash
ls -l /dev/serial/by-id/
~~~

~~~bash
ls -l /dev/serial/by-path/
~~~

Do not assume `ttyUSB0` is always the same device. If a by-id link is unavailable or not unique, record the by-path/port arrangement and test it through a reboot.

The purchased receiver is USB. Enabling GPIO UART options does not inherently fix USB enumeration.

## 5. Receiver detected, but no usable location

**Possible boundary:** satellite reception rather than software installation.

Move the initial test to an appropriate outdoor location with a clear sky view. Run:

~~~bash
cgps -s
~~~

A no-fix state differs from a disconnected receiver. Inspect the reported fix mode and position fields, not only whether a device name appears.

Do not use 0,0 as a placeholder location. Do not promise a precise acquisition time indoors or turn a satellite-count display into an accuracy guarantee. The relevant GlobalSat manual and GPSD docs are linked in the source list.

## 6. GPSD cannot open the port or reports no device

**Possible boundary:** wrong device path, service/socket behavior, conflicting process, or permissions.

~~~bash
systemctl cat gpsd.socket gpsd.service
~~~

~~~bash
cat /etc/default/gpsd
~~~

~~~bash
pgrep -a gpsd
~~~

~~~bash
sudo journalctl -u gpsd.service -b --no-pager -n 100
~~~

Check the installed package's configuration. If it contains a placeholder path from documentation, replace that with the receiver actually observed on the Pi.

Avoid having a terminal serial reader, a manually started GPSD process, and the packaged service compete for the same receiver. GPSD's service may be activated by its socket. Stopping only `gpsd.service` does not necessarily prevent the socket from starting it again. [GPSD troubleshooting](https://gpsd.io/troubleshooting.html)

For a deliberate manual diagnostic session, stop the managed socket and service together first, and restore the managed configuration afterward. Do not solve a permission problem with world-writable serial nodes or by running the entire application as root.

If unplug/replug recovery fails, inspect the actual hotplug/defaults behavior. A configuration that works only when the receiver happens to enumerate before startup is not yet a reliable deployment.

## 7. GPS data works in cgps but not in I.T.S.S.B.

**Possible boundary:** custom reader, parser, expected device identity, or model validation.

Inspect a small stream:

~~~bash
gpspipe -w -n 10
~~~

Then compare with the app's safe diagnostics: receiver identity, last TPV time, fix mode, accepted/rejected sample counts, and last valid observation age.

Common implementation errors include expecting every TPV field, treating a partial report as a complete replacement, parsing the wrong timestamp unit, or ignoring a changed receiver path.

Unknown speed/heading/accuracy should be null. HDOP should not be labeled as meters. Missing or implausible time should result in a clear quality state, not fabricated freshness. [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)

## 8. Python service will not start

**Possible boundary:** missing application, wrong environment, invalid configuration, permissions, or incompatible migration.

~~~bash
systemctl status itssb-device.service --no-pager
~~~

~~~bash
sudo journalctl -u itssb-device.service -b --no-pager -n 100
~~~

| Error | Likely next check |
| --- | --- |
| Unit not found | Has the custom unit actually been created and systemd reloaded? |
| ModuleNotFoundError for itssb_device | Has your custom package been implemented and installed into the runtime environment? |
| Missing Python dependency | Does the service use /opt/itssb/venv/bin/python and the tested lock? |
| Permission denied on SQLite | Does the itssb service identity own /var/lib/itssb? |
| Credentials unavailable | Has the administrator provisioned /etc/itssb/device.env? The proposed unit can start a restricted unpaired UI without it, but protected/cloud operations remain disabled. |
| Invalid configuration | Does device.toml match the parser and contain real configured values? |
| Restart limit reached | Fix the actual startup error before resetting/restarting the service. |
| Migration failure | Preserve state and follow the versioned migration/rollback procedure. |

Do not install random packages globally to fix a virtual-environment problem. Do not use `--break-system-packages` to bypass the intended separation. Do not chmod the whole application tree to 777.

## 9. Local page cannot connect or kiosk is blank

**Possible boundary:** application listener, wrong URL, missing static build, or desktop startup.

After the app exists:

~~~bash
curl --fail http://127.0.0.1:8765/health
~~~

~~~bash
ss -ltnp
~~~

If health fails, investigate the service first. If health works but the page is blank, inspect whether static files were built and deployed, the expected asset paths, and the browser's developer console during development.

If Chromium works when launched manually but not after boot, check the actual graphical session and its autostart file. The labwc path applies to labwc; an SSH shell's empty desktop variables are not proof of the GUI session type.

Run Chromium as the normal desktop user. Running it as root or adding `--no-sandbox` is not the remedy. Verify that the kiosk launcher waits for the local application and does not repeatedly create extra windows.

## 10. Local UI works, but internet or cloud does not

**Possible boundary:** network, DNS, clock, device authentication, endpoint origin, or backend rules.

Check the OS's network status and clock:

~~~bash
ip -brief address
~~~

~~~bash
ip route
~~~

~~~bash
timedatectl status
~~~

A Wi-Fi symbol does not prove cloud access. Captive portals and school network restrictions can allow association while blocking the application.

Confirm the configured device HTTP origin. Hosted Convex client subscriptions and HTTP actions use different deployment URL roles; use the device-ingestion origin documented in [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md).

Never disable TLS verification to work around a clock/certificate issue.

| Response | Meaning |
| --- | --- |
| 401 | Device authentication needs correction or provisioning. |
| 403 | Valid identity lacks authority for this operation/run. |
| 409 or content conflict | Reconcile identity/version disagreement; do not overwrite records. |
| 429 | Apply bounded backoff and server retry guidance. |
| Network timeout / 5xx | Outcome may be unknown; retry the same persisted identity. |

Do not put the device token into browser JavaScript to make a failing server call “work.”

## 11. Queue grows, data duplicates, or position jumps backward

**Possible boundary:** upload acknowledgment, event identities, historical replay, or ordering.

Inspect queue count, oldest pending time, rejection codes, and per-event acknowledgment results. Do not assume HTTP 200 acknowledges every item.

An eventId is generated once before its local commit. Recreating it for a retry prevents deduplication. A new bootId is created for each collector start; runSequence must continue from durable run state.

Old samples received after an outage belong in history. A backend that uses received time alone for live state can incorrectly replace a new position with an old one.

Prioritize a fresh observation, then drain bounded historical batches. Never discard the queue solely to stop a warning. The exact response handling is defined in the data contract.

## 12. Disk almost full or database problems

**Possible boundary:** unbounded retention, logs, stalled uploads, or storage failure.

~~~bash
df -h / /var/lib/itssb
~~~

~~~bash
sudo du -sh /var/lib/itssb
~~~

~~~bash
journalctl --disk-usage
~~~

First read what the device measured. The driver screen's **Recording** chip shows "Space low" or "Queue long" at warning and "Saving less" at critical, and the local health has the numbers:

~~~bash
curl -s http://127.0.0.1:8765/health | python3 -m json.tool | sed -n '/"storage"/,$p'
~~~

`storage.disk.freeBytes` against `warnFreeBytes`/`criticalFreeBytes`, `storage.queue.pending` against its limits, `storage.recording` (`normal` or `reduced`), and `storage.lastCleanup` (when acknowledged rows were last removed and how many).

- **Queue long, disk fine:** uploads are not getting through. Fix the network or server problem (sections on the school server and internet); the queue drains on its own, newest first. Do not delete pending rows.
- **Disk low:** the service already drops acknowledged rows outside the active and last-ended runs, which stops the database from growing but does not raise free space. Find what else is growing with the commands above (journald and other logs are the usual cause), and free that.
- **Recording reduced:** the bus saves one position per `ITSSB_REDUCED_PUBLISH_INTERVAL_SECONDS` (by default 60 s, or four publish intervals if that is longer) until space returns or the queue drops below critical. It returns to normal by itself; no restart is needed.

The thresholds and the full policy are in [04_RASPBERRY_PI_SOFTWARE.md §8](04_RASPBERRY_PI_SOFTWARE.md#8-database-durability-and-bounded-storage). Clean only acknowledged or expired data using the application retention rules. Do not delete the active SQLite database, its WAL file, or pending records as routine cleanup, and do not run `VACUUM` on a nearly full disk.

If corruption is suspected, preserve the affected files and use the recovery procedure on a copy. Supported SQLite backup methods are preferable to copying only the live main database file. [SQLite backup documentation](https://www.sqlite.org/backup.html)

The absence of backup power means an abrupt outage stops recording. SQLite transaction design improves recoverability but cannot guarantee survival of defective media or arbitrary power loss.

## 13. iPhone map is stale although the Pi appears healthy

Check the boundaries in order:

1. Does GPSD have a valid recent fix?
2. Has the Pi committed a selected cloud observation?
3. Did the backend acknowledge that exact event?
4. Does the authorized live query return the correct run and capturedAtMs?
5. Is the phone online and signed in?
6. Does the selected assignment belong to that run?
7. Did the app cancel an old subscription when switching students?
8. Is it converting epoch milliseconds to Date seconds correctly?

Do not add continuous student location permission to fix remote bus tracking. Those are different sources of location.

"Bus GPS unavailable" comes from the Pi's 30-second health heartbeat (`POST /device/v1/health`), not from a missing position. If families never see it while the driver screen shows No fix, check the device log for `health: HTTP 404`: the backend was deployed without the health route. Clients stop believing a reported GPS problem two minutes after the bus's last contact, and the backend expires it after the same interval.

A connected phone can correctly show Bus GPS unavailable or an aging bus position. The interface should not turn every problem into the generic text “You are offline.”

## 14. QR or notification problems

For a QR failure, check code purpose, expiration, active run, approved assignment, and duplicate status. An enrollment invitation must not be accepted as a trip check-in challenge.

Offline scans must not show accepted success before the backend confirms them. A staff fallback remains necessary for students without phones.

For a missing notification, check account preferences, actual iOS permission, APNs token/environment, current recipient authorization, and the notification job result. A provider acceptance is not proof of delivery or reading. A foreground subscription is not a background notification engine. See [ETA and notifications](10_ETA_AI_AND_NOTIFICATIONS.md).

Tapping an old notification should load current authorized state. A completed run should not revive an old countdown.

## 15. What to capture in a support summary

Include software and OS versions, device label, timestamp/timezone, safe error code, current component health, last successful contact, queue count/age, and steps to reproduce with fictional data where possible.

Exclude PINs, device credentials, APNs secrets, raw student addresses, entire rosters, and unredacted location history. Keep a stable event/request identifier when it helps an authorized administrator find the corresponding server record.

Return to [testing and acceptance](13_TESTING_AND_ACCEPTANCE.md) after a fix to verify the affected behavior. Broaden testing when the change creates a concrete related risk, rather than repeating every test after every small UI adjustment.

## Sources

- [Raspberry Pi OS](https://www.raspberrypi.com/documentation/computers/os.html)
- [Raspberry Pi Touch Display 2](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html)
- [Raspberry Pi kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)
- [GPSD troubleshooting](https://gpsd.io/troubleshooting.html)
- [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)
- [SQLite backup API](https://www.sqlite.org/backup.html)
- [Apple: sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)

