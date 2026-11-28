# I.T.S.S.B. — Build roadmap

**Intelligence Transportation System for School Buses**  
Status: implementation sequence. Each phase's **Status** line says what is met, with its evidence, and what only the field or the owner can close. [Documentation index](README.md).

## 1. Build order and why it matters

The earliest useful result is a real location moving from the GPS receiver through the Pi and backend to an authorized iPhone. Make that path survive interruption before layering enrollment, attendance, notifications, and AI onto it. Every later feature depends on the identity, trip, and freshness rules in that path.

Work in small checkpoints. A checklist item is complete only when its observable result exists. Installing Python or creating a SwiftUI project is progress, but neither establishes live bus tracking.

## 2. Phase 0 — Development organization

Create a version-controlled source repository with the planned `device`, `driver-ui`, `ios`, `backend`, `web`, and `docs` areas. The repository can begin with only the first components needed; empty future applications are not a milestone. Keep secrets outside version control and add example configuration with clearly fake values.

Choose the development backend and authentication integration, establish fictional fixture accounts, and make environment names visible. Inspect the actual Pi OS and the Mac/Xcode compatibility before selecting version-specific instructions. Record provisional choices in [17_DECISIONS_AND_SOURCES.md](17_DECISIONS_AND_SOURCES.md).

**Done when:** the repository has a documented owner, reproducible setup notes, development configuration, and a fixture identity plan. No production credentials are embedded in source.

## 3. Phase 1 — Bench hardware

Follow [02_HARDWARE_ASSEMBLY.md](02_HARDWARE_ASSEMBLY.md) and [03_RASPBERRY_PI_SETUP.md](03_RASPBERRY_PI_SETUP.md). Preserve the already installed OS if it is usable; inspecting or updating it is different from reflashing the card.

Verify the rotated display, touch alignment, USB receiver, outdoor fix, network, cooling, and local storage. Use the supplied mains adapter for the desk prototype. Vehicle installation is a later independently reviewed task.

**Done when:** the Pi can show a usable real GPS fix, and you can explain separately whether receiver detection, positioning, internet, and backend access are working.

## 4. Phase 2 — Local device application

Implement the Python package, GPSD reader, validation, state store, and outbox described in [04_RASPBERRY_PI_SOFTWARE.md](04_RASPBERRY_PI_SOFTWARE.md). Build a minimal local status page before the full interface. Persist the chosen outbound observation and queue entry together.

Implement health output that reports truthfully when GPS or the backend is unavailable. Add bounded logs, deliberate configuration loading, a clean shutdown path, and controlled service restart recovery. Install the systemd unit only once its custom application exists and can run in the intended environment.

**Done when:** local status and a temporary run fixture survive a controlled application restart without losing acknowledged/pending meaning or inventing a new run.

## 5. Phase 3 — Backend and the first authorized run

Implement the schema and server rules in [07_BACKEND_AND_DATABASE.md](07_BACKEND_AND_DATABASE.md) using the contracts in [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md). Create one fictional approved route, one driver, one bus/device assignment, and one student assignment.

Implement idempotent online start, telemetry ingestion, explicit per-event results, current-state selection, and completion. Reject wrong device/run/account scope from the beginning. Do not defer authorization until after a public map is working.

**Done when:** one credentialed Pi can start and report one authorized run, duplicate delivery cannot duplicate events, and unrelated accounts cannot read it.

## 6. Phase 4 — Native Swift tracking

Create the Xcode project, configure authentication, add the backend dependency, and build a minimal authorized route/track view using [06_IOS_SWIFT_APP.md](06_IOS_SWIFT_APP.md). Use one backend client and explicit loading, no-run, stale, error, and access-unavailable states.

Map the canonical DTO into a domain model with deliberate timestamp conversion. Render the approved route, own stop, bus marker, and last-update age. Make the age advance locally even if no new update arrives.

**Done when:** a real Pi-originated observation appears on the correct student's iPhone, and a denied account receives no protected data.

## 7. Phase 5 — Reliability before feature expansion

Exercise lost responses, duplicate batches, out-of-order observations, bus internet loss, phone internet loss, GPS loss, and process restart. Continue an already authorized run locally during an outage, then resume fresh tracking before draining history. Keep new offline starts outside the first milestone.

**Done when:** the core cases in [13_TESTING_AND_ACCEPTANCE.md](13_TESTING_AND_ACCEPTANCE.md) pass with evidence, and each failure has an understandable UI state.

## 8. Phase 6 — Driver workflow and approved route management

Implement the driver dashboard and the 24-screen state design from [05_DRIVER_TOUCHSCREEN.md](05_DRIVER_TOUCHSCREEN.md). Route recording needs ordered stops and a review/approval path. The moving view is read-only; roster and editing controls require the stopped workflow.

Build the minimum staff route/device/driver pages that make those approvals real. Do not leave route approval as an unimplemented button whose success is simulated against a live database.

**Done when:** a recorded draft can be reviewed and approved, a new run pins the intended version, and the original four driver actions operate under the correct permissions.

## 9. Phase 7 — Enrollment, family links, and check-in

Implement private name/address requests, eligible stop selection, school approval, verified guardian linking, distinct enrollment/check-in tokens, staff fallback, seat notes, scoped removal, and audit history. Follow [09_ENROLLMENT_QR_AND_ATTENDANCE.md](09_ENROLLMENT_QR_AND_ATTENDANCE.md).

**Done when:** pending accounts cannot track, wrong-purpose/expired tokens fail, multiple legitimate students can use the current trip challenge, duplicate scans are idempotent, and offline driver changes remain visibly pending until accepted.

## 10. Phase 8 — Baseline ETA and alerts

Build route progress and a transparent remaining-segment plus stop-dwell estimate. Store predictions for later evaluation. Add server-side notification rules and an outbox with bounded retries and expiry. Configure APNs and real-device registration before claiming closed-app alerts work.

**Done when:** baseline error is measured on unseen test runs, stale inputs suppress unsupported predictions, one logical alert is created per intended condition, and completion/cancellation/revocation stop obsolete jobs. See [10_ETA_AI_AND_NOTIFICATIONS.md](10_ETA_AI_AND_NOTIFICATIONS.md).

## 11. Phase 9 — Staff/Android completion and operations

Complete the staff calendar, cancellation, replacement, guardian, diagnostic, retention, and audit workflows. Build the responsive family experience and validate actual browser limitations. Use [12_ADMIN_AND_ANDROID_WEB.md](12_ADMIN_AND_ANDROID_WEB.md).

Implement release versions, backup/restore, configuration separation, maintenance windows, credential rotation, and rollback. A release is reproducible only when its exact source/dependencies/configuration can be identified. Follow [14_DEPLOYMENT_AND_OPERATIONS.md](14_DEPLOYMENT_AND_OPERATIONS.md).

**Done when:** staff can operate the system without ad hoc database edits, Android users receive the same authorized meanings, and a failed update can be recovered in a rehearsed process.

## 12. Phase 10 — Evaluated AI and an authorized pilot

Only train a more complex model after enough representative runs and independent arrival labels exist. Compare it with the baseline using the same held-out trips. A model that does not improve the relevant results should not replace the baseline just to add an AI label.

Before real bus use, establish the vehicle installation, connectivity, approved data process, staff procedures, support ownership, and realistic measurements. An attractive interface and a successful desk test do not establish field readiness.

**Done when:** the responsible people have authorized the pilot conditions, the defined release gates are met, and the measured results support the claimed behavior.

## 13. What to do in the next development session

1. Read the hardware and Pi setup guides through the first verification checkpoints.
2. Record the actual Pi OS release, desktop session, architecture, receiver identity, and display orientation.
3. Confirm a usable outdoor GPS fix with GPSD before writing map or AI features.
4. Create the device source package and local database path from the software guide.
5. Build a small truthful status page that distinguishes GPS, internet, and cloud authorization.
6. Continue into the backend/Swift milestone after those observations are reproducible.

This ordering gives each later feature real data and known failure behavior to build on. Keep implementation status separate from documentation completion in your repository.
