# Runbook: update, roll back, back up and restore a Pi

Owner-run steps for [docs/14 §5 and §8](../14_DEPLOYMENT_AND_OPERATIONS.md).
The tool is `apps/device/deploy/itssb_release.py` (standard library only). It
never calls `sudo` and never edits `/etc`; you run it with `sudo` because
`/opt/itssb` and `/var/lib/itssb` belong to root and the service user.

Rehearsed without sudo on the bench Pi by
`apps/device/scripts/pi_release_rehearsal.sh` (update, a candidate that fails
to start, rollback, a tampered release refused, restore from backup).

## Layout

```text
/opt/itssb/releases/<version>/   one copy of apps/device + RELEASE.json (immutable)
/opt/itssb/current  -> releases/<version>   what systemd runs
/opt/itssb/previous -> releases/<version>   the rollback target
/opt/itssb/activations.log                  one JSON line per switch
/var/lib/itssb/device.sqlite3               state; never inside a release
```

`RELEASE.json` records the version, git commit, database schema version, and a
SHA-256 over every file. `activate` refuses a release whose files changed since
staging. The device health API reports it as `process.release`, so the kiosk,
`curl` and support can name the exact build.

The service runs the source tree with `/usr/bin/python3` and has no runtime
dependencies, so there is no separate virtualenv to switch: the one symlink
moves code and dependencies together. If a release ever adds a runtime
dependency, this tool must stage a matching environment inside the release
before that release ships.

## Version names

Use `<UTC date>-<7-char commit>`, for example `2026.11.27-b0dad42`, from a
commit on `main`, so the name alone identifies the source.

## Convert a first install (once)

`INSTALL.md` §3 copied the code straight into `/opt/itssb/current`. The tool
refuses to replace a plain directory. Convert it in a maintenance window:

```sh
sudo systemctl stop itssb-device
sudo mv /opt/itssb/current /opt/itssb/legacy-current
cd ~/ITSSB && git checkout <commit> && cd apps/device
sudo python3 deploy/itssb_release.py stage . --version <version> --revision "$(git rev-parse HEAD)"
sudo python3 deploy/itssb_release.py activate <version>
sudo systemctl start itssb-device
```

Delete `/opt/itssb/legacy-current` after the release is accepted.

## Update

Outside any run, from a checkout of the reviewed commit on the Pi:

```sh
cd ~/ITSSB && git fetch && git checkout <commit> && cd apps/device
T="sudo python3 deploy/itssb_release.py"

$T preflight                         # refuses during an active run; shows pending events
$T stage . --version <version> --revision "$(git rev-parse HEAD)"
sudo systemctl stop itssb-device
$T backup --out /var/backups/itssb   # consistent SQLite copy, prints row counts
$T activate <version>                # refuses if the service still answers,
                                     # the files changed, or the database is newer
sudo systemctl start itssb-device
curl -s http://127.0.0.1:8765/health | python3 -m json.tool
```

Accept the release when health shows the new `process.release.version`, the
same or a draining `outbox.pending`, GPS as expected for the location, the
backend status you had before, and the kiosk loads.

Pending events are never deleted by an update. They stay in
`/var/lib/itssb` and upload after the service starts.

## Roll back

If the new release does not start or is not accepted:

```sh
sudo systemctl stop itssb-device
sudo python3 deploy/itssb_release.py rollback
sudo systemctl start itssb-device
```

`rollback` refuses when the database was migrated past what the previous
release knows. Then either:

- restore the pre-update backup (loses events recorded since the update, so
  only after they uploaded: check `outbox.pending` is 0 first), or
- pass `--accept-newer-db`, only when the release notes say the newer
  migrations are additive (new tables or columns the old code ignores).

## Back up

`backup` uses SQLite's online backup API, so it is consistent even while the
service writes (WAL content included). Copying `device.sqlite3` with `cp` is
not.

```sh
sudo python3 deploy/itssb_release.py backup --out /var/backups/itssb
```

The file is mode `0600`. It holds run IDs and positions: keep it on the Pi or
on storage you control, never in this repository or a shared folder, and
delete it when the retention period ends ([docs/11 §9](../11_SECURITY_PRIVACY_AND_ACCESS.md)).

## Restore

```sh
sudo systemctl stop itssb-device
sudo python3 deploy/itssb_release.py restore --from /var/backups/itssb/device-<stamp>.sqlite3
sudo chown itssb:itssb /var/lib/itssb/device.sqlite3
sudo systemctl start itssb-device
```

`restore` refuses while the service answers and refuses a file that is not an
intact device database. It keeps the replaced state as
`device.sqlite3.before-restore-<stamp>` and prints row counts before and after.

After a restore, check the run in health against what is actually happening
on the bus. A restored snapshot can say a run is active that ended since; end
it through the normal driver flow, never by editing the database.
