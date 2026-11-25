# I.T.S.S.B. — Decisions, assumptions, and sources

**Intelligence Transportation System for School Buses**  
Edition: 25 November 2026. [Documentation index](README.md).

## 1. How to interpret this pack

This pack turns the existing product concept and visual specification into separate build guides. It does not claim the custom applications have been implemented, deployed, compiled, or field-tested. It preserves the purchased hardware and original route/student-management requirements while choosing a coherent proposed first implementation.

“Confirmed” below means supplied as a project requirement or purchase, not independently inspected on the user's hardware. “Recommended” means a design choice to implement and validate. “Open” means a deployment-specific choice that should be recorded when its dependency is reached; it does not prevent completion of this documentation.

## 2. Confirmed project baseline

| Item | Baseline |
|---|---|
| Official name | I.T.S.S.B. — Intelligence Transportation System for School Buses |
| Hardware | Raspberry Pi 5 2GB; seven-inch Touch Display 2; SmartiPi Touch Pro 3 Large; matching Pi 5 fan; official 27W supply; 64GB Raspberry Pi OS microSD; GlobalSat BU-353N5 USB GPS |
| User-supplied purchase total | $296.28 before tax and shipping; historical figures, not a current retail quotation |
| Mobile direction | Native Swift iOS application with Apple Maps |
| Driver main actions | Show QR Code, Record Route, Start Route, Show Students |
| Route creation | Record a path and ordered stops; review/approve before service |
| Enrollment | Private name and address, with nearby eligible or selectable approved stop |
| Driver student management | Authorized route-scoped removal, seat information, and operational notes |
| Visual inventory | 24 driver screens D01-D24 and 28 iOS screens/states I01-I28 |

The existing report describes a successfully booting touchscreen assembly. The guides still require actual GPS capture, cloud data flow, application, power, and field checks. Do not treat a reported OS boot as verification of those later features.

## 3. Recommended implementation decisions

| Decision | Recommendation and reason |
|---|---|
| Pi operating system | Supported 64-bit Raspberry Pi OS desktop; inspect the installed release first |
| Driver application | Local static browser UI and Python API so its application assets load without internet |
| GPS input | GPSD loopback JSON reports; validate usable fixes and optional fields |
| Local persistence | SQLite state and durable outgoing queue, with bounded retention and explicit acknowledgments |
| Local API | `127.0.0.1:8765`, with request/session protection and sensitive-action authorization |
| Runtime layout | Code under `/opt/itssb/current`, venv `/opt/itssb/venv`, config `/etc/itssb`, data `/var/lib/itssb` |
| Service account | Non-root `itssb`; separate normal graphical desktop account for kiosk |
| Device secret | Initial authorized administrator installation into root-owned mode0600 `device.env`; no general app sudo |
| Shared backend | Convex TypeScript functions and database, with explicit user/device authorization |
| iOS client | SwiftUI, MapKit, one authenticated Convex client, explicit domain/UI state |
| First offline scope | Continue an already authorized run; new offline starts require a later explicit expiring grant |
| ETA | Measurable remaining-route baseline before an evaluated learned model |
| Alerts | Server-side logical events and delivery outbox; APNs for iOS |
| Family web | Responsive authenticated browser experience using the same contracts |

The Python, TypeScript, and Swift source files described in this pack are work to implement. Package prerequisites and example configuration alone do not create them.

## 4. Canonical contract clarifications

The [API document](08_DATA_CONTRACTS_AND_API.md) is the authority for shared field names and wire types. These details deliberately tighten earlier conceptual examples:

1. **Run identity:** use `runId`, an opaque backend-issued string. A route display number or date is not a primary key.
2. **Times:** use UTC epoch milliseconds with an `Ms` suffix: `capturedAtMs`, `receivedAtMs`, `generatedAtMs`, `expiresAtMs`, and equivalent start/end fields. An ISO date string is not interchangeable under those names.
3. **Swift conversion:** backend JavaScript `number` values use the documented Convex floating-point wrappers in DTOs. Convert and validate domain integers explicitly; divide epoch milliseconds by 1000 when constructing a Swift date.
4. **Event identity:** generate an `eventId` once and persist it before upload. Retrying must preserve it.
5. **Process ordering:** `bootId` identifies a fresh collector process session, not necessarily a whole Linux boot. Reset the per-session sequence only with a new identifier. The per-run ordering survives process restarts.
6. **Observation cadence:** inspect receiver reports around every second, but select/persist outgoing cloud telemetry around every five seconds by default. Denser raw route-recording samples are a separate local concern.
7. **Per-event results:** an HTTP response alone does not acknowledge every event. Inspect each accepted/duplicate/rejected/retryable result before changing the local outbox.
8. **Lifecycle and health:** run states are `scheduled`, `active`, `completed`, `cancelled`; GPS/network/freshness are independent attributes.
9. **Check-in semantics:** an accepted scan is an attributed check-in claim. Physical boarding, door opening, seat occupancy, and digital trip completion are different facts.
10. **Current state:** late observations can be valid history without replacing a newer live observation or generating historical alerts.

If implementation needs a different choice, change the contract and affected components together. Do not silently let each language infer its own representation.

## 5. Open decisions and when they matter

| Open choice | Resolve before | Evidence or decision needed |
|---|---|---|
| Exact Pi OS release and desktop session | Version-specific setup | Actual `/etc/os-release`, architecture, and session inspection |
| Supported Mac/Xcode and iPhone versions | Native project/dependency setup | Current Apple support matrix and intended device population |
| Identity provider | Real sign-in integration | Supported Swift/web flow, email-code behavior, school needs, token verification |
| School and pilot authority | Real student data or bus operation | Responsible organization, approval process, staff roles, operating procedures |
| Mobile router/service | Moving test and deployment | Coverage, independent power/connectivity, measured data use |
| Vehicle power and mount | Vehicle installation | Appropriate professional integration for the actual vehicle |
| Backend environment/domain | Device-to-cloud communication | Development/pilot separation, approved deployment settings, endpoint configuration |
| APNs signing/team configuration | Real iOS push test | Actual app identity, capability, token handling, server credential setup |
| Geocoding and web mapping provider | Automatic address suggestions/web maps | Terms, data flow, credentials, usage limits, failure fallback |
| Retention and deletion periods | Real-record pilot | School-approved per-record and backup policy |
| Freshness and alert thresholds | Pilot acceptance | Measured transport behavior and explicit product targets |
| Minimum iOS target | Build/release configuration | iOS17+ is a proposed baseline for the illustrated Observation approach, subject to device support |
| Fleet size and viewer count | Capacity planning | Expected buses, run duration, concurrent family views, retention |
| Offline new-run authorization | Any offline-start feature | Expiring grants, revocation limits, reconciliation and conflict behavior |

These choices are recorded tasks. The next implementation phase should resolve the ones it depends on without requiring every later deployment decision first.

## 6. Capacity example and budget limits

Assume one bus operates for two hours per school day, publishes one selected observation every five seconds, and operates for 20 days in a month:

```text
2 hours x 3,600 seconds / 5 seconds = 1,440 observations per day
1,440 x 20 = 28,800 observations per month
28,800 x assumed 1 KB payload = approximately 28.8 MB of application telemetry
```

This is arithmetic under stated assumptions. It excludes request/protocol overhead, retries, denser route recordings, map tiles, software updates, health events, authentication, and downloads to each viewer. If you decide to upload every one-second observation in five-second batches, the observation count becomes five times larger. Measure actual traffic before choosing service capacity.

The purchase total does not cover mobile service, vehicle integration, hosting, provider usage, app distribution, or support. Verify current prices when selecting actual services. No recurring-price claim is made in this pack.

## 7. Source catalog

Official documentation supports platform capabilities and installation details. The architecture, file boundaries, role matrix, workflow, screen inventory, and acceptance plan are project design choices. Each guide includes the sources closest to its claims; use the current page for version-sensitive details.

### Raspberry Pi, case, receiver, and Linux runtime

- [Raspberry Pi documentation](https://www.raspberrypi.com/documentation/) — operating system, configuration, hardware, and remote access.
- [Raspberry Pi OS](https://www.raspberrypi.com/documentation/computers/os.html) and [configuration](https://www.raspberrypi.com/documentation/computers/configuration.html) — installed-release and desktop setup guidance.
- [Touch Display 2](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html) — compatibility, display cable, power connections, resolution, and rotation.
- [Raspberry Pi kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/) — graphical kiosk/autostart reference.
- [Official 27W supply](https://www.raspberrypi.com/products/27w-power-supply/) — supported power profile.
- [SmartiPi Touch Pro 3](https://smarticase.com/products/smartipi-touch-pro-3) — enclosure compatibility and installation features.
- [Matching Pi 5 fan](https://smarticase.com/products/smartipi-touch-pro-3-fan-for-raspberry-pi-5) — fan connection and control.
- [GlobalSat BU-353N5](https://www.globalsat.com.tw/en/product-289508/USB-GNSS-Receiver-BU-353N5.html) — receiver product and support resources.
- [GPSD JSON protocol](https://gpsd.io/gpsd_json.html) — TPV/SKY report fields, fix and timing considerations.
- [GPSD manual](https://gpsd.io/gpsd.html) — daemon options and device access.
- [GPSD installation](https://gpsd.io/installation.html), [troubleshooting](https://gpsd.io/troubleshooting.html), and [Debian package defaults](https://sources.debian.org/src/gpsd/3.25-5%2Bdeb13u2/packaging/deb/etc_default_gpsd) — packaged service/socket behavior; inspect the actual installed version.
- [Python virtual environments](https://docs.python.org/3/library/venv.html) — isolated Python dependencies.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html) — local transactional behavior.
- [systemd service units](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) — service lifecycle and restart configuration.
- [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [Uvicorn settings](https://uvicorn.dev/settings/), and [HTTPX timeouts](https://www.python-httpx.org/advanced/timeouts/) — device application lifecycle and networking.

### Backend and Swift connection

- [Convex Swift overview](https://docs.convex.dev/client/swift/overview) — client lifecycle, subscriptions, calls, and auth integrations.
- [Convex Swift types](https://docs.convex.dev/client/swift/data-types) — numeric and model conversion.
- [Convex authentication in functions](https://docs.convex.dev/auth/functions-auth) — authenticated identity and application authorization.
- [Convex schemas](https://docs.convex.dev/database/schemas) — record validation.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/) — indexed reads and application access patterns.
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions) — device-facing request handling and validation boundary.
- [Convex mutations](https://docs.convex.dev/functions/mutation-functions) — transactional updates.
- [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions) — scheduling, failure handling, and authentication scope.
- [Convex production](https://docs.convex.dev/production) — deployment guidance; check the exact current command in the operations guide before use.
- [Convex backup and restore](https://docs.convex.dev/database/backup-restore) — what data backups contain and how restore affects a deployment.

### Apple frameworks and distribution

- [Xcode support](https://developer.apple.com/support/xcode/) — current Xcode, macOS, SDK, and deployment-target compatibility.
- [SwiftUI model data](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app) — observable state.
- [MapKit for SwiftUI](https://developer.apple.com/documentation/mapkit/mapkit-for-swiftui) — native annotations and polylines.
- [AVCaptureMetadataOutput](https://developer.apple.com/documentation/avfoundation/avcapturemetadataoutput) — camera metadata/QR pipeline.
- [Camera purpose string](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription) — permission explanation.
- [Core Location authorization](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services) — optional location-dependent actions.
- [Notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications) — user-facing authorization.
- [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns) — device token registration.
- [Sending APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) — provider transport and best-effort delivery.
- [Background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app) — delivery limits and background behavior.
- [Preparing UI for background](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background) — application lifecycle.
- [Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app) — supported app/web link routing when configured.
- [Account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion) — in-app initiation requirements for relevant App Store apps.
- [Beta testing and releases](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases) — signed distribution workflow.
- [MapKit JS](https://developer.apple.com/documentation/mapkitjs) — web maps and their authorization setup.

### Evaluation and request protection

- [scikit-learn common pitfalls](https://scikit-learn.org/stable/common_pitfalls.html) — leakage and fitting preprocessing only to training data.
- [scikit-learn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html) — time-aware evaluation reference; preserve complete runs for this project.
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — browser action protection patterns.

## 8. Change-record template

For a material implementation decision, add a short record with: date, decision, reason, alternatives considered, affected documents/components, migration requirement, verification evidence, and person responsible. Examples include choosing the identity provider, changing telemetry cadence, adding offline starts, or introducing a different ETA model.

Keep documented plans, executed checks, and measured outcomes separate. A finished Markdown guide is useful implementation work; it is not a substitute for the application and pilot evidence defined in [13_TESTING_AND_ACCEPTANCE.md](13_TESTING_AND_ACCEPTANCE.md).
