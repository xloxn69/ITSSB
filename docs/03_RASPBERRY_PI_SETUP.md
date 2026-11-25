# 03 — Set up the Raspberry Pi

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

This is the practical setup guide: what to inspect, what to install, and what you must still build. The operating system and ordinary packages can be installed now. The I.T.S.S.B. device application, local API, frontend, and backend integration are custom software described in the next guide; these documents do not install them automatically.

**Run the Linux commands in this guide on the Raspberry Pi**, either in its Terminal or an authorized SSH session. They are not commands for your Mac's normal terminal unless that terminal is connected to the Pi. No command in this guide has been tested on your particular hardware.

Before this guide: [Hardware assembly](02_HARDWARE_ASSEMBLY.md). After it: [Pi software implementation](04_RASPBERRY_PI_SOFTWARE.md).

## 1. Preserve your working microSD installation

You bought a card with Raspberry Pi OS and have a working display as a starting point. First inspect that installation. Do not format the card or write a new image merely because a tutorial begins with Raspberry Pi Imager.

In the Pi Terminal, run these individually:

~~~bash
cat /etc/os-release
~~~

~~~bash
uname -m
~~~

~~~bash
dpkg --print-architecture
~~~

~~~bash
python3 --version
~~~

~~~bash
whoami
~~~

~~~bash
hostname
~~~

Record the OS name/version, architecture, Python version, username, and hostname. A 64-bit ARM installation normally reports `aarch64` from the kernel and `arm64` from Debian package architecture. Do not assume the username is `pi`; use the account actually configured on your machine.

Raspberry Pi's current documentation identifies Trixie as the latest major Raspberry Pi OS base and advises a fresh image for major-version migration rather than a cross-release in-place upgrade. That does **not** mean you should erase your existing card now. If migration becomes necessary, first back up the application/configuration and use a spare card when practical. [Official OS documentation](https://www.raspberrypi.com/documentation/computers/os.html)

**Checkpoint:** you know which installation you have and have not destroyed the working one.

## 2. Identify the graphical desktop

The kiosk launcher depends on the desktop session. Run this in a Terminal opened on the Pi's actual desktop:

~~~bash
printenv XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
~~~

An SSH session might not have these desktop environment variables. An empty SSH result does not prove that the Pi has no desktop.

Also inspect the available browser:

~~~bash
command -v chromium
~~~

~~~bash
command -v chromium-browser
~~~

The main path below targets Raspberry Pi OS Desktop with **labwc/Wayland**, matching Raspberry Pi's current kiosk tutorial. If your installation uses another desktop, confirm its autostart mechanism before copying the labwc step. Raspberry Pi OS Lite does not supply the same desktop environment; adding a complete graphical stack is a separate setup decision. [Official kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)

Use the desktop's display controls to choose landscape rotation. Check touch alignment afterward. Configure the real operating timezone and Wi-Fi country in the OS settings; application timestamps still use UTC and the route's service timezone separately.

**Checkpoint:** the display is readable at 1280 × 720 landscape, touches hit the intended controls, and the desktop/browser choice is known.

## 3. Connect ordinary network access

Use the desktop network menu to join the development Wi-Fi. Enter its password through the OS interface rather than putting it in a project file or a shell command that could remain in history.

Useful read-only checks include:

~~~bash
ip -brief address
~~~

~~~bash
ip route
~~~

~~~bash
timedatectl status
~~~

The Pi needs a plausible clock for HTTPS validation, invitation expiry, and trustworthy timestamps. GPS time handling must be deliberate; do not disable certificate verification because a clock is wrong.

If remote development is useful, enable SSH through the installed OS's supported settings and use an account you control. Use a private development network and appropriate key-based access. Do not forward the device's SSH or local API ports through a public router.

A school Wi-Fi network may require a captive portal or enterprise configuration. A successful Wi-Fi association is not the same as usable internet or successful backend authentication.

## 4. Update packages within the installed release

At a desk, with stable power and no active run, inspect and install ordinary package updates:

~~~bash
sudo apt update
~~~

~~~bash
sudo apt full-upgrade
~~~

Review the proposed changes before accepting them. This updates packages using your configured release repositories; do not rewrite repository names to force a major OS migration.

Reboot after an update when required, then confirm that display and touch still work:

~~~bash
sudo reboot
~~~

This command interrupts services. During a future pilot, updates and reboots belong in a maintenance window.

## 5. Install the basic tools

The proposed baseline packages are:

~~~bash
sudo apt install gpsd gpsd-clients python3-venv python3-pip sqlite3 git curl usbutils
~~~

| Package | Why it is present |
| --- | --- |
| `gpsd` | Handles the receiver and exposes normalized GPS reports. |
| `gpsd-clients` | Supplies tools such as `cgps` and `gpspipe` for testing. |
| `python3-venv` | Creates an isolated Python dependency environment. |
| `python3-pip` | Installs application libraries inside that environment. |
| `sqlite3` | Provides the database inspection/maintenance command-line tool. |
| `git` | Retrieves and manages the source repository during development. |
| `curl` | Checks HTTP responses and local health endpoints. |
| `usbutils` | Supplies `lsusb` to inspect USB devices. |

Python's SQLite module is part of the standard library; the `sqlite3` OS package is a useful CLI, not a separate Python ORM requirement.

If Chromium is not already available, inspect the package candidate:

~~~bash
apt-cache policy chromium
~~~

Then install it if that is the supported package on the inspected OS:

~~~bash
sudo apt install chromium
~~~

A missing candidate is a reason to check the release/repositories, not to download an arbitrary browser binary. Use the command name actually installed by your OS.

Do not install Node.js, Docker, TensorFlow, an LLM, or Xcode on the Pi simply because the overall project uses web, AI, or Swift. The proposed production Pi runs a Python service and static frontend assets. The web frontend can be built on your development computer; the Swift app is built with Xcode on a Mac.

## 6. Find the GPS receiver

With the receiver connected, inspect:

~~~bash
lsusb
~~~

~~~bash
ls -l /dev/serial/by-id/
~~~

~~~bash
ls -l /dev/serial/by-path/
~~~

One of those directories may be absent. You can also inspect current serial nodes:

~~~bash
ls -l /dev/ttyUSB* /dev/ttyACM*
~~~

A pattern with no matching device may print an error. That does not invalidate the other result.

Use USB connect/disconnect observations and kernel messages to establish which node belongs to your receiver:

~~~bash
sudo journalctl -k -b --no-pager -n 100
~~~

A `by-id` link is useful when the receiver exposes a suitable stable identity. Some USB serial hardware has no unique serial identity; a `by-path` link instead identifies its physical connection path. Record which method actually works and retest after reboot. Do not invent a device path from another person's example.

Changing the GPIO serial-port setting is not normally required merely to use this USB receiver. Avoid treating a USB GNSS puck as if it were wired to the Pi's UART pins.

## 7. Let the packaged GPSD own the receiver

Use the distribution's GPSD package and its client package together. Do not mix an arbitrary source-built daemon with unrelated packaged clients.

Inspect the installed units and defaults:

~~~bash
systemctl status gpsd.socket gpsd.service --no-pager
~~~

~~~bash
systemctl cat gpsd.socket gpsd.service
~~~

~~~bash
cat /etc/default/gpsd
~~~

GPSD on Debian-derived systems commonly uses both a service and a socket, and can register devices through USB hotplug. A socket may activate the service when a client connects. Therefore, a service that was initially inactive is not necessarily a failure. The packaged configuration and unit files on your Pi are the authority for the installed release. [GPSD troubleshooting](https://gpsd.io/troubleshooting.html) · [Debian GPSD defaults](https://sources.debian.org/src/gpsd/3.25-5%2Bdeb13u2/packaging/deb/etc_default_gpsd)

Start the packaged socket if necessary:

~~~bash
sudo systemctl enable --now gpsd.socket
~~~

Then try:

~~~bash
cgps -s
~~~

Allow the receiver a clear sky view and observe whether position and fix state appear. Quit the client normally when finished.

If the packaged hotplug behavior already finds the receiver, preserve it. When the actual installation requires an explicit device, use `sudoedit /etc/default/gpsd` and set `DEVICES` to the inspected device path. A conceptual single-receiver configuration looks like this:

~~~sh
# EXAMPLE ONLY: replace the device path with the one observed on your Pi.
DEVICES="/dev/serial/by-id/REPLACE_WITH_ACTUAL_RECEIVER_LINK"
GPSD_OPTIONS="-n"
USBAUTO="true"
~~~

Do not paste the placeholder literally. Keep only settings understood by the installed package, and preserve existing unrelated configuration. `-n` requests polling without waiting for a client. **Do not add `-G`**, which is used to listen beyond the local machine. The app needs only loopback access. [GPSD manual](https://gpsd.io/gpsd.html)

After a relevant configuration change:

~~~bash
sudo systemctl restart gpsd.socket gpsd.service
~~~

Inspect the listener:

~~~bash
ss -ltnp
~~~

The intended TCP listener is local loopback port **2947**, possibly including IPv6 loopback. It should not expose GPS data on `0.0.0.0:2947` or a public interface.

Do not start a second manual `gpsd` process while the packaged service/socket already owns the receiver. Stop both managed units before a deliberate manual diagnostic session; the troubleshooting guide explains why stopping only the service can be insufficient.

**Checkpoint:** one managed GPSD instance reads the intended receiver and only local clients can reach it.

## 8. Inspect normalized GPS data

Use the client to inspect a short JSON stream:

~~~bash
gpspipe -w -n 10
~~~

You may see VERSION, DEVICES, WATCH, SKY, and TPV reports. A useful location report is a TPV report with usable fix mode and finite latitude/longitude. Mode 2 or 3 can supply coordinates; a connected receiver without a fix must not become a point at 0,0.

GPSD fields can be optional, and reports may be partial. The custom parser must handle missing speed, heading, uncertainty, and time. Raw HDOP must not be relabeled as meters of horizontal accuracy. [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)

This output contains real coordinates. Redact them before sharing diagnostics publicly.

**Checkpoint:** outdoor testing produces recognizable current coordinates. No cloud account or Swift app is needed to reach this milestone.

## 9. Prepare a Python development environment

A virtual environment keeps project libraries separate from the OS's Python packages. Raspberry Pi OS Bookworm and later direct pip installations into a virtual environment; do not bypass that separation with a global pip workaround. [Raspberry Pi Python guidance](https://www.raspberrypi.com/documentation/computers/os.html#python) · [Python venv documentation](https://docs.python.org/3/library/venv.html)

In your chosen development directory, a bootstrap example is:

~~~bash
mkdir -p "$HOME/itssb-device"
~~~

~~~bash
cd "$HOME/itssb-device"
~~~

~~~bash
python3 -m venv .venv
~~~

~~~bash
.venv/bin/python -m pip install --upgrade pip
~~~

Proposed initial application libraries are FastAPI, Uvicorn, and HTTPX:

~~~bash
.venv/bin/python -m pip install fastapi uvicorn httpx
~~~

These unpinned installs are a development bootstrap. A tested release must have a deliberate dependency lock and reproducible installation instructions. Additional packages should be added when a selected implementation needs them, not as a large speculative dependency list.

**Installing these packages does not create I.T.S.S.B.** You must still implement the package, routes, queue, authorization, UI, and cloud integration described in [04_RASPBERRY_PI_SOFTWARE.md](04_RASPBERRY_PI_SOFTWARE.md).

## 10. Create the runtime identity and directories

For a deployed prototype, keep the service account separate from the desktop user.

First check whether it exists:

~~~bash
id itssb
~~~

Only if it does not exist, create it:

~~~bash
sudo useradd --system --user-group --home-dir /var/lib/itssb --create-home --shell /usr/sbin/nologin itssb
~~~

Create the intended directories:

~~~bash
sudo install -d -o root -g root -m 0755 /opt/itssb
~~~

~~~bash
sudo install -d -o root -g itssb -m 0750 /etc/itssb
~~~

~~~bash
sudo install -d -o itssb -g itssb -m 0700 /var/lib/itssb
~~~

The service account needs to write its state directory. It should not need to rewrite application releases, browse the desktop user's files, or change arbitrary OS settings.

The fixed runtime paths are:

| Path | Contents |
| --- | --- |
| `/opt/itssb/current` | Deployed custom application release. |
| `/opt/itssb/venv` | Runtime Python environment for the deployed release. |
| `/etc/itssb/device.toml` | Nonsecret configuration. |
| `/etc/itssb/device.env` | Protected device credential configuration for the prototype. |
| `/var/lib/itssb/device.sqlite3` | Local database and durable outgoing work. |
| journald | Bounded operational service logs. |

A release installer should create/populate the runtime environment only after the source and dependency lock exist. It should not copy a virtual environment from a different machine or architecture.

## 11. Provision configuration without putting secrets in Git

The application configuration and protected environment file are templates in the software guide. They require actual backend/device provisioning.

For the prototype, an authorized administrator installs `device.env` as root-owned mode 0600. systemd reads it and passes the configured environment to the non-root service. Do not put a credential into a shell command, URL, screenshot, example repository, or frontend JavaScript.

A fully automated pairing mechanism needs its own narrowly scoped credential-storage design. Do not grant the browser or Python application general sudo access to make provisioning convenient.

D03 can show the device's pairing code/status while the approved provisioning process establishes the real credential.

## 12. Start the custom service only after it exists

The service name is **itssb-device.service**. Its proposed entry point is:

~~~text
/opt/itssb/venv/bin/python -m itssb_device
~~~

That command will fail until the custom package has been implemented and installed. It is not an apt package or a pre-existing command supplied by these Markdown files.

After the implementation, configuration, dependency environment, and unit file from the software guide are present, validate and enable it:

~~~bash
sudo systemd-analyze verify /etc/systemd/system/itssb-device.service
~~~

~~~bash
sudo systemctl daemon-reload
~~~

~~~bash
sudo systemctl enable --now itssb-device.service
~~~

~~~bash
systemctl status itssb-device.service --no-pager
~~~

~~~bash
sudo journalctl -u itssb-device.service -b --no-pager -n 100
~~~

A running process is only the first check. The UI must separately report GPS, device authorization, local database, and cloud connectivity.

## 13. Open the local UI before enabling kiosk mode

After the custom application implements its health endpoint and static frontend, inspect:

~~~bash
curl --fail http://127.0.0.1:8765/health
~~~

Then open this local URL in Chromium:

~~~text
http://127.0.0.1:8765/
~~~

The server should bind only to **127.0.0.1:8765**. Browser and API use the same local origin. The page should show a useful diagnostic/unpaired state even if the internet is unavailable.

The UI bundle must be installed on the Pi. Avoid making startup depend on a remote CDN for JavaScript, fonts, or icons. Cached approved route/stop geometry can support a simple local line-and-stop display. Online map tiles are not automatically offline maps; a fully offline basemap would need a separately chosen source, storage policy, and licensing arrangement.

## 14. Configure kiosk startup for the inspected desktop

For labwc, Raspberry Pi's official tutorial uses the desktop user's `~/.config/labwc/autostart`. Edit the existing file; do not overwrite unrelated desktop startup lines.

After the local UI works, a minimal launcher line is:

~~~sh
chromium --kiosk --no-first-run --user-data-dir="$HOME/.local/share/itssb-kiosk" http://127.0.0.1:8765/ &
~~~

Use the installed browser command if its name differs. Run the browser as the normal desktop user, never with sudo and never with `--no-sandbox`.

A production launcher should wait for the local health endpoint, report a startup failure, and recover from a browser exit without creating multiple windows. This launch/retry wrapper is custom code to implement; the single line above does not supply that supervisor.

Enable graphical desktop startup/autologin only for the dedicated kiosk operating account through the supported OS settings. OS autologin starts the display; it does not unlock the driver's application session. Keep the roster behind the application lock.

Before removing keyboard access, retain an authorized maintenance/recovery method. Test a reboot and observe the entire sequence: OS, device service, local page, driver lock, and clear readiness state.

## 15. Your setup milestone

You have completed the infrastructure milestone when the existing OS boots, GPSD supplies a valid fix, the intended service identity/directories are prepared, and the browser can render a local test/application page.

The following still require custom implementation: route recording, enrollment, trip state, cloud device credentials, durable upload acknowledgments, driver permissions, map states, and the Swift client. Continue with the software guide rather than assuming the package installation completed the product.

## Sources

- [Raspberry Pi OS](https://www.raspberrypi.com/documentation/computers/os.html)
- [Raspberry Pi configuration](https://www.raspberrypi.com/documentation/computers/configuration.html)
- [Raspberry Pi kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/)
- [GPSD installation](https://gpsd.io/installation.html)
- [GPSD troubleshooting](https://gpsd.io/troubleshooting.html)
- [GPSD manual](https://gpsd.io/gpsd.html)
- [GPSD JSON protocol](https://gpsd.io/gpsd_json.html)
- [Debian Trixie GPSD defaults](https://sources.debian.org/src/gpsd/3.25-5%2Bdeb13u2/packaging/deb/etc_default_gpsd)
- [Python virtual environments](https://docs.python.org/3/library/venv.html)
- [systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

Commands are reviewed documentation examples, not a claim of execution on your Pi. Inspect installed versions and replace clearly marked placeholders before deployment.

