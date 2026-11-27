# Installing the device service on the Pi (owner steps)

These steps need `sudo`, so the device owner runs them. Nothing in this repo
installs itself. Spec: [docs/04 §3, §14](../../../docs/04_RASPBERRY_PI_SOFTWARE.md).

The runtime is the Python standard library only (3.11+; Debian 13 ships
3.13), so there is no virtualenv or build step: systemd runs the source tree
with `/usr/bin/python3`.

| Path | Owner / mode | Holds |
|---|---|---|
| `/opt/itssb/current` | root, read-only to the service | `apps/device` release |
| `/etc/itssb/device.env` | root, `0600` | origin + device token (injected by systemd) |
| `/var/lib/itssb` | `itssb`, `0700` (systemd `StateDirectory`) | SQLite database |

## 1. Prerequisites

GPSD is installed and its socket is enabled (docs/03). Check with:

```sh
systemctl is-enabled gpsd.socket
python3 --version   # 3.11 or newer
```

## 2. Service account

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin itssb
```

## 3. Release files

From a checkout of the reviewed commit:

```sh
sudo mkdir -p /opt/itssb
sudo rsync -a --delete --exclude .venv --exclude var --exclude tests \
  apps/device/ /opt/itssb/current/
sudo chown -R root:root /opt/itssb/current
sudo chmod -R go-w /opt/itssb/current
```

## 4. Settings and credential

```sh
sudo install -d -o root -g root -m 0755 /etc/itssb
sudo install -o root -g root -m 0600 /opt/itssb/current/deploy/device.env.example /etc/itssb/device.env
sudoedit /etc/itssb/device.env
```

Set `ITSSB_DEVICE_API_ORIGIN` (the deployment's `.convex.site` URL) and
`ITSSB_DEVICE_TOKEN` (the provisioned credential). To run without cloud upload
for now, **delete both lines**. The placeholders are deliberately refused:
the service exits with status 2 and does not restart.

## 5. Install and start the unit

```sh
sudo install -o root -g root -m 0644 /opt/itssb/current/deploy/itssb-device.service \
  /etc/systemd/system/itssb-device.service
sudo systemd-analyze verify /etc/systemd/system/itssb-device.service
sudo systemctl daemon-reload
sudo systemctl enable --now itssb-device.service
```

## 6. Verify

```sh
systemctl status itssb-device --no-pager
journalctl -u itssb-device -n 50 --no-pager
curl -s http://127.0.0.1:8765/health | python3 -m json.tool
```

Expected indoors: `gps.status` is `no_fix` (or `receiver_missing` without the
USB receiver). `backend.status` is `unconfigured` until the origin and token
are set. `run` is `null` until a run is started. The service never invents one.

Restart check:

```sh
sudo systemctl restart itssb-device
curl -s http://127.0.0.1:8765/health   # new process.bootId; same run and outbox counts
```

## Update or roll back

Stop the service, rsync the new reviewed release over `/opt/itssb/current`
(keep the previous one for rollback), then start it again. Do this outside an
active trip. `/var/lib/itssb` is never touched by an update; the database
migrates forward on start.

## Remove

```sh
sudo systemctl disable --now itssb-device.service
sudo rm /etc/systemd/system/itssb-device.service && sudo systemctl daemon-reload
```

Before deleting `/var/lib/itssb`, check that its outbox has no pending rows.
Otherwise you discard unsent trip data.
