# 05 — Driver touchscreen

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

This document specifies the seven-inch driver's interface you will build. It is a product and implementation guide, not a claim that the software is installed. For the physical assembly and operating system, start with [hardware assembly](02_HARDWARE_ASSEMBLY.md) and [Pi setup](03_RASPBERRY_PI_SETUP.md). For the background processes, read [Pi software](04_RASPBERRY_PI_SOFTWARE.md).

## 1. What runs on the screen

Use a lightweight web interface served by the local device service at `http://127.0.0.1:8765`. Chromium opens that local address in kiosk mode. The app's HTML, CSS, JavaScript, icons, fonts, and essential layouts live on the Pi. Starting the driver's interface must not depend on downloading a remote website.

The target interface is **1280 × 720 landscape** after rotating the Touch Display 2. The manufacturer's native panel resolution is 720 × 1280; verify both display rotation and touch alignment on the actual unit. [Raspberry Pi display documentation](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html).

The browser presents information and requests actions. The Python device service owns actual run state, authorizations, persistence, and synchronization. Closing or refreshing Chromium must not end the trip. The driver should not need a terminal during ordinary operation.

A suitable starting frontend has a page shell, reusable large buttons, a status bar, a map panel, a route/roster list, confirmation dialogs, and an API client. Use a framework only if it helps development; this display does not need a desktop-sized dashboard framework or a collection of heavy animation libraries.

## 2. The four main actions

Preserve the original dashboard actions exactly:

| Action | Meaning |
|---|---|
| **Show QR Code** | Choose route enrollment or current-trip check-in, with the purpose written clearly. |
| **Record Route** | Create a proposed path and ordered stops for review. |
| **Start Route** | Start an approved passenger-service run after preflight. |
| **Show Students** | Open the roster the current driver is authorized to use. |

The dashboard also shows the bus, selected route and direction, active run status, GPS status, last cloud contact, and pending changes. Keep these separate: a valid GPS fix does not imply internet access, and internet access does not imply a successful authorized backend connection.

The four actions may be unavailable in some states. For example, a driver cannot start a second run while one is active, show a valid trip challenge for a completed run, or open another driver's roster merely by changing a URL.

## 3. State and interaction rules

The operational run states are `scheduled`, `active`, `completed`, and `cancelled`. GPS quality, internet availability, driver authorization, and motion are independent attributes. An active run can simultaneously have a valid fix and no internet.

Use a driver-confirmed safely stopped state for complex actions. The **Parked** badge means that the driver has confirmed a safely stopped context and available motion information does not contradict it. It does not mean the device has read the transmission gear. GPS speed alone cannot prove parking; the purchased equipment has no gear or ignition interface.

During motion, show D13. Complex actions stay unavailable. When motion is unknown, do not silently unlock the roster or keyboard. An authorized recovery procedure can resolve the state while safely stopped. Avoid an easy permanent override that defeats the intended protection.

Route recording can continue automatically while driving. Adding a stop, editing a name, changing a note, or reporting an issue happens when safely stopped. The physical screen should be mounted for the approved operating procedure, with usability checked on the actual display.

## 4. Complete screen inventory

These 24 named screens match the visual atlas. Each screen also owns its loading, empty, permission, error, and confirmation variations.

| ID | Screen | Content, action, and result |
|---|---|---|
| D01 | Startup and self-check | Checks application, device pairing, receiver detection, valid fix, network, backend authorization, and local storage. Continue only into supported operation. |
| D02 | Device setup and network | Authorized Wi-Fi, display rotation, brightness, timezone, and other device settings. Protect passwords and restrict disruptive changes to maintenance. |
| D03 | Pair device with school | Shows a device enrollment code and pending/approved/expired state. Staff associate the device with the intended organization and bus. |
| D04 | Driver unlock | Shows the identified driver and masked PIN input, switch-driver action, and recovery instructions. Rate-limit failures. |
| D05 | Driver dashboard | Shows the four primary actions, selected route, direction, bus, run status, and independent health indicators. |
| D06 | Route library | Lists approved route versions and directions, with draft/review states clearly separated and cache status visible. |
| D07 | Record a new route | Names the draft, chooses direction, checks GPS/storage, and explains automatic sampling and stopped-only editing. |
| D08 | Recording a route | Shows elapsed recording, actual collected path, fix quality, marked stops, and stopped-state Mark Stop/Finish controls. |
| D09 | Add or edit a stop | Edits stop name, coordinate, order, and instructions; confirms destructive draft changes. |
| D10 | Review recorded route | Reviews ordered stops, geometry, gaps, and direction; saves the draft or submits it for review. Queued submission remains visibly pending. |
| D11 | Route awaiting approval | Shows the submitted version, review status, and requested changes. Approval does not rewrite an active run. |
| D12 | Start-trip preflight | Confirms driver, bus, approved route version, roster freshness, fix, storage, and cloud authorization before starting one run. |
| D13 | Driving view | Read-only next-stop information, simple progress, and concise positioning/connection status. No enabled complex controls. |
| D14 | Stopped at a bus stop | Shows the relevant stop, expected students, recorded check-ins, and limited authorized actions. |
| D15 | Route enrollment QR | Displays **Join this route**, route/direction, expiring invitation, and an accessible alternative code. No private roster appears behind it. |
| D16 | Trip check-in QR | Displays **Check in for this trip**, the active run, and a temporary challenge. Expired/unavailable states explain the fallback. |
| D17 | Student roster | Shows authorized names, assigned stops, seats where applicable, and record-based statuses. Supports stopped-state search/grouping. |
| D18 | Student detail and seat note | Edits permitted seat information and notes; includes **Remove from route**, confirmation, reason, and pending/accepted results. |
| D19 | Attendance correction | Identifies student and run, shows existing status, collects a correction/reason, and preserves its audit history. |
| D20 | Report a delay or issue | Selects a predefined category and optional explanation; reviews the notice and shows queued/submitted status. |
| D21 | GPS and device diagnostics | Shows receiver/fix age, cloud contact, queue depth, disk state, temperature, app version, and restricted maintenance controls. |
| D22 | Offline bus operation | Explains which records are saved locally, when the backend last heard from the bus, and what cannot currently be confirmed. |
| D23 | End-trip confirmation | Confirms the intended run, highlights unsynchronized/unresolved records, and saves completion once. |
| D24 | Trip summary | Shows start/end, stop progress, record counts, reported issues, and Completed locally versus Synced. |

## 5. First setup and a normal shift

During initial setup, staff pair the device, associate it with a bus, and authorize drivers. In the first prototype, an authorized administrator provisions the credential through the documented root-owned configuration file; systemd passes it to the service. D03 shows pairing status and the designed enrollment interaction, but automatic installation of a new credential requires a later narrowly scoped provisioning mechanism. Do not give the browser or general application unrestricted sudo to implement pairing. Pairing credentials are not the same as route invitations. The driver unlocks their own approved session and selects an available route.

The first version starts a new run online. This lets the backend verify the assignment and issue the canonical `runId`. A future offline-start feature needs a separately designed, expiring authorization; a cached route by itself does not authorize a new run. Continuing an already authorized run offline is part of V1.

Before starting, D12 must identify a stale roster. A visible warning or blocked start follows the school's adopted policy; the UI must not pretend the last download is current. Starting uses a stable `requestId` for that logical action. A double tap or timeout retry returns the same run instead of creating a duplicate.

Once active, all recording continues automatically. At each stop the driver can use D14 if safely stopped. Ending on D23 records the intended run's completion and produces D24. Switching drivers or buses during a run requires an explicit authorized reassignment, not a local identity edit.

## 6. Recording routes properly

A recording consists of real observations plus explicitly marked stop candidates. Save each accepted point with its actual capture time. If GPS becomes unavailable, mark a quality gap. The review may draw a visually distinct connector between known points, but it must not describe that connector as measured travel.

Stops have stable identifiers and an ordered position within a route version. Give each a useful public label and restricted staff instructions only where needed. A route that passes a stop twice must retain direction/order context so the first nearby pass does not falsely serve it.

Finishing a recording creates a draft. Review its direction, endpoint, stop sequence, missing sections, and accidental detours. Submission and approval are separate events. A locally saved draft can survive loss of internet; **Submitted** means the server accepted the submission. Students continue using their existing approved assignments until an authorized version becomes effective.

Do not use a generic fastest road route as a silent replacement for the recorded school route. Approved transportation routes can contain deliberate sequences that ordinary navigation would avoid.

## 7. Student information and attendance wording

The roster is scoped to the driver's authorized route/run. It should not download every student in the organization. Use name, approved school identifier where necessary, assigned stop, and permitted seat/operational details. Home addresses normally do not belong in the operating roster when stop assignment is sufficient.

Distinguish **Expected**, **Check-in recorded**, and a separately defined staff-recorded status. A count of 22 check-ins is not an occupancy-sensor reading. A seat assignment is not evidence that someone is sitting there. Ending the digital run is not confirmation that every student exited.

For a note edit, display the current value and save the change with its author and time. Reject unauthorized changes on the local service and backend. If two authorized devices modify the same record, use the documented version/conflict rule rather than silently discarding one edit.

For removal, show the student, route, and exact effect before confirmation. Collect a reason, preserve history, and submit the scoped assignment change. While offline, show **Removal pending sync**. The local view may reflect the pending change, but the cloud can still permit access until it receives and accepts the request. See [enrollment and attendance](09_ENROLLMENT_QR_AND_ATTENDANCE.md).

## 8. Local frontend implementation

These are proposed source responsibilities to build, not files already installed:

| Suggested module | Responsibility |
|---|---|
| App shell and router | Select D01–D24 based on authoritative state and permitted navigation. |
| Device-state store | Holds the latest local service snapshot and update age. |
| Local API client | Reads status and sends authenticated commands with stable request IDs. |
| Status components | Represent receiver, fix, network, cloud, storage, and pending-record state. |
| Route/stop components | Render simplified geometry and ordered stops without repeatedly loading full history. |
| QR component | Renders the server-authorized invitation or challenge and remaining validity. |
| Roster components | Display only authorized fields and show pending changes. |
| Confirmation/feedback components | Distinguish local save, pending upload, server acceptance, and rejection. |

The local API is `127.0.0.1:8765`; its proposed endpoints are documented with the [device implementation](04_RASPBERRY_PI_SOFTWARE.md) and [contracts](08_DATA_CONTRACTS_AND_API.md). Keep browser assets and API under the same origin. Bind the server to loopback, validate origin/host, protect state-changing requests from cross-site request forgery, and enforce driver permissions in the service. A hidden button is not access control.

Subscribe to compact local state updates through the transport chosen in the implementation, or poll a compact status endpoint initially. Do not have browser JavaScript read the serial port or SQLite file. A refresh should request a fresh snapshot, discover the active run, and resume the correct view.

## 9. Layout, map availability, and touch behavior

Use the established navy, blue, teal, amber, and off-white palette. Give primary controls generous targets, approximately 80 pixels high as an initial design choice, then test on the real seven-inch panel. Use text with icons, sufficient contrast, large labels, and visible focus. Avoid hover-only behavior.

Keep the moving view short. A large next-stop label matters more than an intricate chart. Do not place a scrollable roster behind a translucent QR code; switch to a dedicated QR page so private content is not visible.

The local route line and stop coordinates can render without online map tiles. If the selected mapping provider's basemap is unavailable, show a plain route/progress view with an explicit map-background status. Do not claim offline map support unless the provider permits caching and the chosen tile data is actually stored. Maps and QR patterns in the visual atlas are illustrative, not credentials or production mapping assets.

Text entry can use the installed on-screen keyboard or a suitable application component. Test that it appears when needed, does not cover Save/Cancel, and disappears when leaving the stopped workflow. Do not rely on a hardware keyboard in ordinary bus operation.

## 10. Errors and recovery

A failed command must preserve understandable state. If the service times out after a save, ask for the same command result using its original `requestId`; do not manufacture a new action every retry. **Saved on this device**, **Waiting to sync**, **Accepted by server**, and **Rejected** are different outcomes.

If Chromium crashes, restart the browser and fetch authoritative state. If the device service restarts, recover its durable run and queue before displaying success. If storage cannot accept another event, show a blocking or degraded state according to the documented policy; a green **Recording** badge would be misleading.

A queued issue report is not an emergency call, and cloud acceptance is not confirmation that a dispatcher read it. Use the school's existing urgent communication procedure when needed; the interface should accurately describe only the communication it performed.

## 11. Acceptance checklist

- Every D01–D24 view can be shown with fictional fixtures.
- The dashboard preserves the four original actions.
- Display rotation and touch coordinates agree.
- Moving/unknown-motion states do not expose complex editing.
- A browser reload preserves the underlying active run.
- New V1 runs cannot start from an unauthorized offline cache.
- Expired QR content is visibly unusable and cannot be accepted server-side.
- A student scan and staff correction have distinct provenance.
- Double taps do not duplicate starts, check-ins, removals, or endings.
- A failed upload leaves a visible pending state.
- Local and cloud statuses recover independently.
- No secret, private address, or route-wide roster appears on public QR screens.
- Long names, large text, sunlight, glare, and imperfect touch are checked on the actual panel.

Continue with [iOS implementation](06_IOS_SWIFT_APP.md), [QR workflows](09_ENROLLMENT_QR_AND_ATTENDANCE.md), and [integration tests](13_TESTING_AND_ACCEPTANCE.md).

## Sources and status

- Raspberry Pi, Touch Display 2 hardware/resolution/rotation: https://www.raspberrypi.com/documentation/accessories/touch-display-2.html
- OWASP, cross-site request forgery prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

Screen organization, module names, action rules, and operating procedures are proposed I.T.S.S.B. engineering choices. The source links establish platform behavior; they do not implement these application rules automatically.
