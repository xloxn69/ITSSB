# I.T.S.S.B. — Deployment and operations

**Intelligence Transportation System for School Buses**  
**Status:** Proposed release and operating procedure. This documentation does not deploy a backend, install the custom Pi application, sign an iOS build, or authorize a school-bus installation.

Use with [Pi setup](03_RASPBERRY_PI_SETUP.md), [Pi software](04_RASPBERRY_PI_SOFTWARE.md), [Swift app](06_IOS_SWIFT_APP.md), [Testing](13_TESTING_AND_ACCEPTANCE.md), and [Troubleshooting](16_TROUBLESHOOTING.md).

## 1. Deployment means releasing several coordinated parts

There are separate releases for the device service, driver UI, backend functions/schema, iOS client, web client, and prediction algorithm. Record their versions together in a release manifest. A polished screen does not establish that an old Pi understands a new protocol or that the selected APNs environment matches the app build.

For each release record the source revision, dependency locks, supported `schemaVersion`, database migration version, device configuration version, model version if any, and known limitations. Store source history in a repository; store credentials through the chosen protected operational mechanism.

## 2. Keep environments separate

| Environment | Data and purpose |
| --- | --- |
| Development | Fictional students, generated tokens, route playback, frequent changes. |
| Integration/staging | Controlled test devices and accounts exercising a candidate release. |
| Pilot/production | Approved operating records and deliberately controlled releases. |

The Pi display and app development build should visibly indicate a nonproduction environment. A replay publisher must not accidentally become a live bus. Keep client URLs, device credentials, identity-provider configuration, push token environment, and notification recipients separated.

Convex supports development and production deployments, with options for preview/staging workflows. Confirm the actual target rather than inferring it from the folder name. The current [production guide](https://docs.convex.dev/production/overview) describes these choices.

## 3. Configuration inventory

| Location | Configuration to manage |
| --- | --- |
| Pi `/etc/itssb/device.toml` | Device endpoint, environment label, local port, sampling/publishing settings, queue budgets, feature settings. |
| Pi `/etc/itssb/device.env` | Device secret and any approved session-related environment inputs. |
| Pi `/var/lib/itssb/` | Durable local database and permitted caches. |
| Backend environment | Identity-provider configuration, permitted link domain, APNs settings, delivery credentials, optional prediction-service access. |
| iOS build configuration | Backend URL, bundle identifier, associated domain, build environment, supported protocol version. |
| Web configuration | Backend URL, permitted origin, map authorization configuration, environment label. |

In the initial device arrangement, an authorized administrator installs `device.env` as a root-owned `0600` file. The system service manager reads it and supplies the required environment to the non-root `itssb` process. The application does not receive sudo access or rewrite `/etc` in order to provision itself. An eventual pairing flow needs a separately reviewed privileged installation mechanism; the concept screen does not implement that mechanism.

Use the current secret-management facilities of the chosen backend deployment. Convex exposes deployment environment variables for server functions; keep private values out of public frontend build variables. See [Convex environment variables](https://docs.convex.dev/production/environment-variables). Do not paste secrets into support screenshots or command histories.

## 4. First device provisioning

Follow the hardware/setup guides to verify the actual operating system and assembled components. Then provision one development device:

1. Create its device record and intended bus association in the development backend.
2. Generate a unique revocable credential through the implemented administration path.
3. Install approved configuration through the authorized operator workflow.
4. Install the built device package, dependencies, and locally served driver assets.
5. Install the service only after its entry point and configuration exist.
6. Start the service and desktop kiosk in their separate intended user contexts.
7. Verify GPS, loopback API, cloud authentication, and a valid authorized trip.
8. Record the installed software and configuration versions.

The normal paths are `/opt/itssb/current` for application code, `/opt/itssb/venv` for the Python environment, and `/var/lib/itssb/device.sqlite3` for durable state. `python -m itssb_device` becomes usable only after that custom package has actually been implemented and installed.

A duplicate microSD image must not create two active buses with the same credential. Use a generic base image without operational secrets, then provision each unit separately. Reassignment or replacement rotates the relevant credential and updates the authorized bus/device relationship.

## 5. Releasing a Pi update

Make software changes during an inactive maintenance period. Downloading a candidate in the background can be separate from activating it, but activation must not interrupt an active run.

A release procedure should:

1. Identify the intended device and current environment.
2. Confirm no active trip is being interrupted and inspect pending events.
3. Verify the new artifact's integrity and supported protocol/database versions.
4. Preserve a consistent state backup and the previous code/dependency lock.
5. Stage the new code and dependencies without modifying the running release.
6. Stop the service in the controlled maintenance window.
7. Apply only the planned, tested local migration.
8. Activate the matching code and dependency environment together.
9. Start the service and verify local health, GPS reading, backend communication, and kiosk display.
10. Retain a rollback path until the release is accepted.

Switching `/opt/itssb/current` alone is not sufficient if `/opt/itssb/venv` has incompatible dependencies. The release mechanism must manage both consistently. This pack describes that requirement rather than providing an untested updater script.

Rollback code only when it can read the current database format. Destructive migrations need a separate recovery plan; they cannot be undone merely by restarting an old executable. Preserve unsent events unless an authorized incident procedure explicitly determines their disposition.

These read-only commands are useful after the proposed unit has been installed:

```bash
systemctl status itssb-device.service --no-pager
journalctl -u itssb-device.service -n 100 --no-pager
df -h /var/lib/itssb
```

Their output can contain operational information; inspect it before sharing. A running process alone is not proof that usable GPS observations are reaching the correct deployment.

## 6. Backend releases and migrations

Develop and test using the development deployment. `npx convex deploy` is a deployment command, not a harmless local build. Depending on configuration it targets production or preview infrastructure. Confirm the intended project and credential before an authorized release. See the [deploy command reference](https://docs.convex.dev/cli/reference/deploy).

Prefer compatible changes in stages: add a new optional field, deploy code that can read old and new records, backfill through bounded jobs, update clients, and only later retire the old representation. Pin the contract revision and maintain compatibility with devices or phones that have not yet updated.

Test migrations on representative fictional records, including older schemas and partially completed jobs. Do not deploy a function that expects a field every existing document lacks. A schema deployment and an application data migration are related but separate tasks.

Maintain a release checklist for authorization tests, telemetry replay, null/stale GPS, start/end idempotence, and notification suppression. Restore or rollback must also consider any external effects already sent; a database rollback cannot unsend a notification.

## 7. iOS and web releases

Build and sign the native app using the chosen Apple development setup. Exercise camera scanning, permissions, session restoration, and real push behavior on physical devices as well as using simulated tracking fixtures.

TestFlight is Apple's beta-distribution workflow and can be used for a controlled app test before wider release. The build still needs the correct account, app record, signing, capabilities, and distribution configuration. See [Apple TestFlight](https://developer.apple.com/testflight/).

Keep release notes specific: supported backend contract, known offline limitations, notification behavior, and changes affecting enrollment or access. Account creation/deletion, privacy descriptions, and permission purpose strings must match implemented behavior. The Swift guide describes those flows.

Deploy the staff/Android website separately from the local Pi kiosk. Keep its assets versioned and its API origin configured for the correct environment. A service worker or browser cache must not continue presenting a deleted assignment as live. Test sign-out and permission changes with cached pages.

## 8. Backups that can actually be restored

There are several different things to preserve:

- Backend application data.
- Backend source/configuration and an inventory of secret settings.
- Pi application/version metadata and allowed local state.
- Necessary identity-provider and domain configuration.
- Model artifacts, preprocessing, and evaluation records.

Convex's data backups do not include the application code, environment variables, or pending scheduled functions. Its restore operation replaces deployment data, so rehearse restoration in an isolated target and take the appropriate current-state backup before an authorized restore. Verify available plan features and retention rather than assuming a schedule is included. See [Convex Backup & Restore](https://docs.convex.dev/database/backup-restore).

For the Pi, use a consistent SQLite backup mechanism or an explicitly stopped, checkpointed procedure. Copying only a live database's main file can omit state associated with its journaling mode. The [SQLite online backup API](https://www.sqlite.org/backup.html) provides a supported approach for obtaining a consistent copy.

Protect backups like the original data. Do not casually copy real students into a public test environment. Apply access, retention, and deletion policies to exports as well as live records.

### Restore verification

After restoration, reconcile active runs against actual operational status. Restore credentials/configuration deliberately, check relationship permissions, and recover durable application jobs. Expire old approaching alerts; do not replay every pending notification because a historical snapshot says it was pending. Reconcile deletion/revocation actions that occurred after the backup before reopening access.

A successful file export is not a demonstrated recovery procedure. The checkpoint is a controlled restore that can serve the correct authorized data and safely resume ingestion without duplicate runs or stale alerts.

## 9. Health monitoring and support

Monitor outcomes, not only uptime. Useful metrics include age of the latest valid GPS fix, age of device contact, upload success rate, queue depth/oldest item, rejected-event reasons, disk pressure, restart count, and application version. Record temperature or power-related warnings only when actually observed.

For the family service, measure snapshot freshness, query failures, subscription recovery, prediction coverage/error, and notification job outcomes. Distinguish provider acceptance from user visibility. Do not place raw home addresses, sign-in codes, device secrets, or full QR tokens into routine logs.

Assign responsibility for device support, school assignment corrections, backend incidents, and credential revocation. A driver should know whether to retry, continue the existing authorized offline run, or follow the school's established fallback procedure. The app is not an emergency-dispatch service.

## 10. Capacity and costs

For one bus publishing a selected observation every five seconds during two active hours:

```text
2 × 60 × 60 ÷ 5 = 1,440 cloud observations per operating day
1,440 × 20 = 28,800 observations over 20 operating days
```

At an illustrative 1,000 bytes of application payload per observation, that is about 28.8 MB before protocol overhead, retries, health/events, route data, map downloads, software updates, and subscriber traffic. This is a planning calculation, not measured cellular use or a recommended data allowance.

Denser local route recordings have a separate storage/retention budget. Publishing every one-second sample would increase cloud record volume approximately fivefold relative to this example. Measure real usage before choosing a service plan or fleet capacity.

The historical hardware purchase total is $296.28 before tax/shipping. Mobile service, vehicle power/mounting, backend usage, identity services if selected, app distribution, and optional traffic/model services are additional deployment decisions. No ongoing provider price is assumed in this guide.

## 11. Field pilot gate

Before a school pilot, validate the authorized mount, electrical integration, shutdown behavior, satellite reception, cellular coverage, and touchscreen usability under the intended conditions. The purchased wall supply and enclosure do not themselves provide vehicle-rated power or a battery backup.

Begin with controlled fictional-data runs, then an authorized limited pilot with a documented fallback. Rehearse loss of GPS, bus internet, phone internet, and device power as separate cases. Verify the system communicates its actual state and recovers without erasing history or inventing confirmation.

## Sources

- [Convex production deployments](https://docs.convex.dev/production/overview)
- [Convex deploy command](https://docs.convex.dev/cli/reference/deploy)
- [Convex environment variables](https://docs.convex.dev/production/environment-variables)
- [Convex Backup & Restore](https://docs.convex.dev/database/backup-restore)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [Apple TestFlight](https://developer.apple.com/testflight/)

Release procedures, capacity assumptions, paths, monitoring choices, and pilot gates are proposed I.T.S.S.B. operating decisions to implement and validate.
