# I.T.S.S.B. — Project documentation

**Intelligence Transportation System for School Buses**  
Documentation edition: 25 November 2026  
Scope: the proposed first complete version, with a practical prototype-first build sequence.

## Start here

This pack explains what belongs on the Raspberry Pi, what you build in Swift on a Mac, what runs in the backend, and how the parts communicate. It contains **18 Markdown files**. The documents are a specification and implementation guide; they are not an installed application, a compiled Xcode project, or proof of a completed bus pilot.

Your purchased hardware is the starting point: Raspberry Pi 5 2GB, seven-inch Touch Display 2, SmartiPi Touch Pro 3 Large, its Pi 5 fan, official 27W supply, 64GB Raspberry Pi OS microSD, and GlobalSat BU-353N5 USB GPS. The previously generated 52-screen visual atlas remains a design reference. The complete screen inventories are also written into the driver and iOS documents here, so you can work from this pack independently.

### If you are asking “what do I put on the Pi?”

Read [hardware assembly](02_HARDWARE_ASSEMBLY.md), then [Pi setup](03_RASPBERRY_PI_SETUP.md), then [Pi software](04_RASPBERRY_PI_SOFTWARE.md). The Pi needs an operating system, GPS software, Python runtime and dependencies, a custom I.T.S.S.B. device application, local database/configuration, and a browser showing the local driver interface. The installed operating system does not already contain that custom application.

### If you are asking “what do I build in Swift?”

Read the [iOS guide](06_IOS_SWIFT_APP.md), then the [data contracts](08_DATA_CONTRACTS_AND_API.md). You build the student/guardian interface in Xcode, using SwiftUI, MapKit, account authentication, an authorized backend connection, and native camera/notification features. The iPhone app reads backend results; it does not directly operate the Pi's USB GPS.

### If you want the shortest useful first milestone

Make one authorized online-started test run on the Pi produce a fresh location in the Swift app. Disconnect the bus internet, show the position becoming stale, reconnect without duplicated records, and end the run cleanly. Add enrollment, check-in, alerts, and evaluated AI after that path works. See the [build roadmap](15_BUILD_ROADMAP.md).

## File index

| File | Main question it answers |
|---|---|
| [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md) | How does the entire product fit together, and what runs where? |
| [02_HARDWARE_ASSEMBLY.md](02_HARDWARE_ASSEMBLY.md) | How do the seven purchased parts connect, and what is still needed for a vehicle? |
| [03_RASPBERRY_PI_SETUP.md](03_RASPBERRY_PI_SETUP.md) | What do I inspect and install on the Pi, in what order, and how do I check it? |
| [04_RASPBERRY_PI_SOFTWARE.md](04_RASPBERRY_PI_SOFTWARE.md) | What custom source files, services, database, configuration, and boot behavior do I build? |
| [05_DRIVER_TOUCHSCREEN.md](05_DRIVER_TOUCHSCREEN.md) | How do all 24 driver screens and their actions behave? |
| [06_IOS_SWIFT_APP.md](06_IOS_SWIFT_APP.md) | How do I structure and build the native Swift app and all 28 planned states? |
| [07_BACKEND_AND_DATABASE.md](07_BACKEND_AND_DATABASE.md) | What does the shared server store, authorize, calculate, and publish? |
| [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md) | What exact fields, timestamps, IDs, endpoints, and acknowledgments connect the parts? |
| [09_ENROLLMENT_QR_AND_ATTENDANCE.md](09_ENROLLMENT_QR_AND_ATTENDANCE.md) | How do private address enrollment, guardian links, QR codes, check-ins, and corrections work? |
| [10_ETA_AI_AND_NOTIFICATIONS.md](10_ETA_AI_AND_NOTIFICATIONS.md) | How are arrival estimates evaluated and useful alerts delivered? |
| [11_SECURITY_PRIVACY_AND_ACCESS.md](11_SECURITY_PRIVACY_AND_ACCESS.md) | Who can access which data, and how are credentials and changes protected? |
| [12_ADMIN_AND_ANDROID_WEB.md](12_ADMIN_AND_ANDROID_WEB.md) | What do transportation staff and Android users need? |
| [13_TESTING_AND_ACCEPTANCE.md](13_TESTING_AND_ACCEPTANCE.md) | What must pass before a demo, a pilot, and broader use? |
| [14_DEPLOYMENT_AND_OPERATIONS.md](14_DEPLOYMENT_AND_OPERATIONS.md) | How are versions, environments, backups, updates, and recovery managed? |
| [15_BUILD_ROADMAP.md](15_BUILD_ROADMAP.md) | What should be built first, and what proves each stage is done? |
| [16_TROUBLESHOOTING.md](16_TROUBLESHOOTING.md) | What do I check when display, GPS, services, network, or synchronization fail? |
| [17_DECISIONS_AND_SOURCES.md](17_DECISIONS_AND_SOURCES.md) | Which choices are settled, provisional, or still open, and which official sources support them? |

Owner-run procedures live under [runbooks/](runbooks/): [releases](runbooks/release.md), [Convex backup and restore](runbooks/convex-backup-restore.md), and [Pi update, rollback, backup and restore](runbooks/pi-update-and-rollback.md).

## How to use the instructions

Each guide distinguishes **inspection**, **installable prerequisites**, **custom application work**, and **example templates**. Run a command only on the machine named by that section. Raspberry Pi commands belong on the Pi; Xcode setup belongs on a compatible Mac; backend development commands belong in the backend source checkout. This pack has not executed those commands on your hardware.

A directory tree in a document describes a proposed source layout. It does not mean the corresponding source files already exist. A service template with `python -m itssb_device` works only after the custom package has been implemented and installed. Never copy a dummy token, fictional ID, or example domain into a real deployment unchanged.

The system design is the common contract. If you change a shared field, update [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md), both clients, the backend, and the relevant verification together. Local styling changes do not require a data-contract change.

## The canonical V1 choices

- Pi OS: supported 64-bit Raspberry Pi OS with a graphical desktop; inspect the installed release before applying desktop-specific setup.
- Pi runtime: Python, GPSD, SQLite, a local API, and a locally served touchscreen interface.
- Pi API: loopback address `127.0.0.1:8765`; GPSD remains local on its own port.
- iOS: SwiftUI and MapKit, with one authenticated backend client and explicit app state.
- Shared backend: proposed Convex TypeScript functions with server-side authorization.
- Run states: `scheduled`, `active`, `completed`, `cancelled`; connection/GPS health are separate.
- Wire times: UTC epoch milliseconds using names such as `capturedAtMs`, `receivedAtMs`, and `expiresAtMs`.
- Normal active-run target: inspect GPS around once per second and select one outgoing telemetry observation around every five seconds. These are tunable targets, not measured guarantees.
- First offline scope: continue recording an already authorized run. New offline starts need a later, explicit expiring authorization design.
- Original driver actions remain **Show QR Code**, **Record Route**, **Start Route**, and **Show Students**.
- iOS tabs are **Track**, **My Route**, **Alerts**, and **Account**.

## What the hardware does not establish by itself

The purchase list does not include independent mobile internet, vehicle power protection, backup power, passenger sensors, or door/ignition integration. A QR check-in records an authenticated claim; it is not a physical passenger detector. The generated screens are concepts. Predictions and alerts become trustworthy only after their data path and failure behavior are implemented and evaluated.

Use this pack as a living specification. Record implementation status and evidence in your repository as you build. The [decisions file](17_DECISIONS_AND_SOURCES.md) explains how to resolve an open choice without silently changing another component's assumptions.
