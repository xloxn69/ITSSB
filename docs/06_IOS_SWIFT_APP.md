# 06 — Native iOS app in Swift

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

This is the build guide for the student/guardian iPhone app. It defines what you will create in Xcode, which frameworks belong in the app, how data reaches each view, and how the app should behave in normal and failed conditions. Code fragments are illustrative design examples, not a complete compiled application. Nothing here claims the Pi, backend, signing, or push service has already been deployed.

Read [system architecture](01_SYSTEM_ARCHITECTURE.md) first. The precise shared payloads live in [data contracts](08_DATA_CONTRACTS_AND_API.md); enrollment rules live in [QR and attendance](09_ENROLLMENT_QR_AND_ATTENDANCE.md).

## 1. What goes on the iPhone

The iPhone holds an installed native app built from Swift source. SwiftUI creates the interface, MapKit displays maps, a configured authentication SDK handles sign-in, and the Convex Swift client communicates with the backend. AVFoundation can read QR codes, and UserNotifications/APNs provide the notification integration.

The app does not connect directly to the USB receiver, read the Pi's SQLite database, or control the Pi's operating system. It asks the backend for the user's authorized data. The bus and phone can use entirely different internet connections. Phone GPS is optional; the bus marker comes from the bus device.

The visible promise is specific: show the latest reported bus position, its age, an appropriate arrival prediction, and relevant transportation notices. A prediction is an estimate. A check-in is a record with a source. Neither should be presented as a physical safety sensor.

## 2. Development tools and Xcode project

Use a Mac with an Xcode version compatible with the macOS and iOS versions you intend to support. Check Apple's current [Xcode support matrix](https://developer.apple.com/support/xcode/) when installing; do not assume a named Xcode release will remain current.

Create an **iOS App** project, choose **SwiftUI** for the interface and **Swift** for the language, and use a stable bundle identifier owned by your team. A suggested project/product name is `ITSSB`; the display name can be `I.T.S.S.B.`. Do not put a school's production identity into an unrelated personal development configuration.

Use a provisional minimum of **iOS 17** if it covers the intended families' phones. That supports the Observation-based examples described below. The actual minimum is a product decision to validate against the supported device population. Apple documents SwiftUI Observation from iOS 17 onward. [Model-data documentation](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app).

Start with these project decisions:

| Setting | Proposed approach |
|---|---|
| Interface/language | SwiftUI and Swift. |
| App environments | Separate development and pilot/production configurations. |
| Backend URL | Public deployment configuration, selected per build configuration. |
| Authentication | Provider integration chosen and configured separately; no invented local login server. |
| Supported devices | iPhone first, adaptive layout rather than fixed screenshot dimensions. |
| Assets | App icon, brand colors, and appropriate small image assets. |
| Local persistence | Small account-bound cache, initially simpler than a full offline database. |
| Logging | Structured diagnostics with private fields redacted. |

Add `https://github.com/convex/convex-swift` using Xcode's package dependency interface and add the `ConvexMobile` product to the application target. Record the resolved dependency version. Add only the auth integration that you actually choose; Auth0 and Clerk are documented options, not mandatory simultaneous dependencies. [Convex Swift setup](https://docs.convex.dev/client/swift/overview).

**Checkpoint:** an empty ITSSB app runs in Simulator with fictional placeholder content and the correct development configuration. No real student data is needed at this stage.

## 3. Proposed source organization

These are source files you will create in the iOS project, not additional packages to install. The paths are suggested repository-relative locations.

| Suggested location | What belongs there |
|---|---|
| `ios/ITSSB/App/ITSSBApp.swift` | App entry, long-lived dependency construction, environment injection. |
| `ios/ITSSB/App/AppRootView.swift` | Chooses session restoration, onboarding, signed-in tabs, or access recovery. |
| `ios/ITSSB/App/AppConfiguration.swift` | Development/production public configuration. |
| `ios/ITSSB/App/AppDelegateAdapter.swift` | UIKit delegate integration for APNs registration callbacks. |
| `ios/ITSSB/Session/SessionStore.swift` | Identity, session status, approved assignments, and guardian relationships. |
| `ios/ITSSB/Networking/BusRepository.swift` | Application-facing interface to queries, mutations, and streams. |
| `ios/ITSSB/Networking/ConvexBusRepository.swift` | Convex-specific implementation and DTO decoding. |
| `ios/ITSSB/Models/TransportDTOs.swift` | Wire response types matching contract version 1. |
| `ios/ITSSB/Models/DomainModels.swift` | Validated application types and state enums. |
| `ios/ITSSB/Tracking/TrackingStore.swift` | Selected assignment/run, latest snapshot, subscription lifetime, and failure state. |
| `ios/ITSSB/Tracking/TrackingView.swift` | Textual trip summary and map composition. |
| `ios/ITSSB/Tracking/BusMapView.swift` | Route line, assigned stop, marker, camera/follow behavior. |
| `ios/ITSSB/Enrollment/EnrollmentFlow.swift` | Invitation, private details, eligible stops, pending/rejected/approved result. |
| `ios/ITSSB/Guardian/GuardianDashboard.swift` | Authorized linked-student cards and context switching. |
| `ios/ITSSB/Scanning/QRScannerView.swift` | Camera presentation and scan state. |
| `ios/ITSSB/Scanning/QRPayloadParser.swift` | Strict expected URL/purpose parsing before backend validation. |
| `ios/ITSSB/Notifications/NotificationCoordinator.swift` | Permission state, token synchronization, and notification routing. |
| `ios/ITSSB/Alerts/AlertsView.swift` | Authorized alert list and details. |
| `ios/ITSSB/Account/AccountView.swift` | Preferences, privacy, account deletion, and sign-out. |
| `ios/ITSSB/Persistence/AccountCache.swift` | Small scoped cache and its invalidation/expiry. |
| `ios/ITSSB/PreviewData/Fixtures.swift` | Fictional stable data for every screen and state. |
| `ios/ITSSBTests/` | Contract, mapping, state, and permission tests. |

Do not put authentication, camera control, subscription ownership, and every backend call into one enormous `ContentView`. Keep the view focused on display and user intent. Names can change as implementation develops, but responsibilities should remain clear.

## 4. Session and role flow

The designed sign-in flow is email plus a one-time code. It only works after the chosen identity provider is configured to support it. Verifying the code proves control of the sign-in identity; it does not establish school membership, student assignment, or a parent-child relationship.

On launch, restore the session through the provider. While restoration is unresolved, show a real loading state. Once authenticated, request current application access. A student with an approved assignment enters Track. A guardian enters the linked-student dashboard. A person with pending enrollment sees that request's status. An expired session leads back to sign-in.

Selecting **Student** or **Parent/guardian** in profile setup expresses the intended workflow. The backend decides what access is approved. Do not let an editable profile field become an authorization claim. A guardian must use the school-approved linking process, not a search for a child's name.

Let the auth SDK manage its supported token lifecycle. Any app-managed secrets belong in appropriate protected storage, not `UserDefaults` or a committed configuration file. The app receives no device credential, database admin key, or APNs signing private key. See [access controls](11_SECURITY_PRIVACY_AND_ACCESS.md).

## 5. Navigation and complete screen inventory

Use four signed-in tabs: **Track / My Route / Alerts / Account**. Track opens student tracking or the guardian dashboard. Use navigation stacks for details, and bounded sheets/full-screen presentations for scanning or a short settings flow. Choose APIs supported by the deployment target; newer tab APIs need their appropriate availability strategy.

Every trip-related detail should preserve the selected student/assignment. A notification opening Jordan's trip must not leave Alex's name above Jordan's map. The following 28 named views or major states match the visual atlas; several share one implementation with different state.

| ID | Screen | Required behavior |
|---|---|---|
| I01 | Welcome | Explain tracking/alerts; Get started and Sign in. |
| I02 | Email sign-in | Validate email and request the configured provider's code. |
| I03 | Verify sign-in code | Verify, resend when allowed, change email, show errors inline. |
| I04 | Profile and role | Collect name and intended student/guardian role without granting authority. |
| I05 | Join a route | Scan an enrollment invitation or enter its alternative code. |
| I06 | Review enrollment | Review private name/address, route/direction, and eligible stop selection. |
| I07 | Approval pending | Show request status without unauthorized live tracking. |
| I08 | Enrollment unavailable | Explain expired, invalid, declined, or unavailable enrollment and recovery. |
| I09 | Student live tracking | Show latest bus position, assigned stop, ETA, progress, and age. |
| I10 | Guardian dashboard | Show only approved linked students and their own trip states. |
| I11 | Link a student | Submit the school-approved relationship invitation and display its outcome. |
| I12 | Selected student's trip | Show named student context, stop, authorized seat detail, notices, and own check-in. |
| I13 | My route and assigned stop | Review approved geometry, direction, stop, and applicable check-in access. |
| I14 | Stop details and directions | Read pickup instructions, request walking directions, or set walking time. |
| I15 | Bus approaching | Emphasize a fresh supported estimate and assigned stop. |
| I16 | Bus at assigned stop | Show arrival state and eligible student check-in action. |
| I17 | Scan trip check-in QR | Scan the active run's temporary challenge and offer a help path. |
| I18 | Check-in result | Show accepted, already recorded, pending, or rejected status truthfully. |
| I19 | Trip completed | Clear active countdowns. With no trip running, show "Trip completed" and when it finished for today's completed run on the route (`endedRun`), with no bus marker, until that service day ends. |
| I20 | Alerts inbox | Show authorized notices with timestamps, unread state, and empty state. |
| I21 | Alert details | Show source, affected run, issue/update time, and current/superseded status. |
| I22 | Account and settings | Manage profile, preferences, privacy, Delete account, and sign-out. |
| I23 | Notification preferences | Set thresholds/categories and show actual iOS permission state. |
| I24 | Display and accessibility | Appearance, reduced map motion, contrast, and system text-size behavior. |
| I25 | Connection lost or stale position | Preserve explicit last-known age while withholding unsupported current estimates. |
| I26 | GPS unavailable | Explain the bus's missing fix independently of the phone connection. |
| I27 | No active trip | No live marker. Show what `tracking:myRun` says about today: "Trip cancelled", with "the school is sending a replacement bus" while a replacement is pending, and fixed wording, never the staff reason. Or show today's calendar notice ("No service today", "Starts 20 minutes late today", with the school's text). Otherwise "No trip right now". A running trip shows today's notice on its status card. Each item disappears when its service day ends. Next scheduled service is not built yet. |
| I28 | Session or access unavailable | Reauthenticate or explain assignment/relationship loss; clear restricted content. |

**Implemented in the app so far for I01, I13, I14, I21, and I24:**
- **I01** shows before sign-in only to a signed-out person who hasn't started signing in. It shows once per launch, so "Sign in again" goes straight to the sign-in form.
- **I13** (My Route > My route and stop) shows the approved `tracking:myRoute` path, the student, the route label, the assigned stop, and whether this account can check in. It shows no bus.
- **I14** shows the stop and hands walking directions to Apple Maps. `tracking:myRoute` carries no route direction or pickup instructions, so neither is shown. A walking-time setting isn't built. Stop details reads the live route, so it clears as soon as access is removed.
- **I21** opens from an Alerts row. It shows the source, the student, the route, the stop, the predicted arrival, when that estimate was made, and when the alert was sent. It checks the trip's live `tracking:myRun` and says whether the trip has ended, has a newer estimate, or still uses this one. It never calls an alert current before that check answers, after a restart until a new answer arrives, or while the phone is offline ("Can't confirm right now").
- **I24** (Account > Display and accessibility) stores an appearance choice and an in-app reduced-map-motion switch on the phone. With either that switch or iOS Reduce Motion on, Follow bus jumps instead of animating. Text size and Increase Contrast follow iOS and are shown read-only.
- **I04** (Account > Profile) keeps a name and an intended role (student, or parent or guardian) on the phone, for this account only, and clears them on sign-out. They are never sent and grant nothing.
- **I10:** an account with two or more approved assignments starts Track on a list of its students. Each row shows that student's own trip: no trip, waiting for a location, or the position's age, labeled "last known location" once stale. "All students" in the switcher returns to the list, and a tapped notification goes straight to its student.
- **I12/I16:** on a running trip, a student's own account gets Check in on the trip screen, and a larger "The bus is at your stop. Check in" when the bus reports it is at the stop. Guardians never get it.
- **I20:** an alert opened on this phone is marked read. The newest 200 read marks are kept locally and cleared on sign-out.
- **I22 Delete account** is not built: it waits on an owner decision about which records are kept after deletion (§13).

Camera, notification, and optional location permission prompts are native iOS overlays. Scanner retries, deletion confirmation, walking-time preference, and sign-out confirmation belong to their parent flow. Do not invent custom permission switches that claim to override iOS.

## 6. SwiftUI state ownership

For an iOS 17+ implementation, use small `@Observable` stores for UI-facing state, isolated to the main actor. An owning view preserves a store with private `@State`; an injected observable needing editable bindings uses `@Bindable`. Read-only children can receive ordinary values. Apple explains how Observation connects models and views. [Apple model data](https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app).

`SessionStore` owns identity and approved relationships. `TrackingStore` owns selected assignment, subscription, snapshot, and connection/error state. A map view owns transient camera/follow preference. A scanner owns camera presentation and its in-progress scan. These are different lifetimes.

Do not copy a changing parent selection into child-owned `@State` and expect future parent changes to replace it. Do not make every settings screen depend on a GPS-updated object. Keep frequently changing position state close to the map/status subtree. Use stable database/assignment identifiers in lists, so rows retain the correct identity when reordered.

A proposed UI state distinguishes loading, ready, no active run, session expired, access unavailable, and recoverable transport failure. A transient network failure should not become an empty list that looks like the school deleted the assignment. Preserve a timestamped previous snapshot only under the adopted cache policy.

## 7. Shared types and time conversion

The contract uses `runId`, never a display route number as an identifier. All wire times use explicit UTC epoch-millisecond names, including `capturedAtMs`, `receivedAtMs`, `generatedAtMs`, and `expiresAtMs`. The route's service timezone is separate. These names clarify older conceptual examples that used less explicit timestamps.

Convex transports JavaScript `number` values as its floating-point type. Use its documented wrappers rather than assuming a JavaScript numeric counter decodes as a Swift integer. Optional numeric values use optional wrappers. [Convex type conversion](https://docs.convex.dev/client/swift/data-types).

**Illustrative DTO fragment for `run.lastPosition`; it is not the complete envelope:**

```swift
import Foundation
import ConvexMobile

struct PositionDTO: Decodable {
    let eventId: String
    @ConvexFloat var latitude: Double
    @ConvexFloat var longitude: Double
    @ConvexFloat var capturedAtMs: Double
    @ConvexFloat var receivedAtMs: Double
    @OptionalConvexFloat var horizontalAccuracyM: Double?
}
```

Map that wire object into a validated internal model before rendering. Check finite numbers, latitude/longitude ranges, timestamp plausibility, and nonnegative accuracy when present. Convert a validated timestamp with `Date(timeIntervalSince1970: capturedAtMs / 1_000)`. Validate numeric revisions as safe whole values before converting to an internal integer. Do not compare arbitrary event UUIDs to determine recency.

`tracking:myRun` takes an authorized `assignmentId`. Its envelope distinguishes `ready`, `no_active_run`, and `access_unavailable`. A ready `run` includes its state, live revision, nullable last position, GPS status, device contact time, assigned stop, and nullable ETA. Follow [08](08_DATA_CONTRACTS_AND_API.md) for exact nesting and field names rather than independently changing the Swift model.

## 8. Live subscriptions and changing students

Construct one authenticated Convex client for the process. A repository translates subscriptions into application snapshots; the tracking store consumes only the selected authorized context. Convex supports reactive query subscriptions and maintains its backend connection. [Swift client documentation](https://docs.convex.dev/client/swift/overview).

A selection change should perform this sequence:

1. Mark the old selection inactive and cancel its subscription task.
2. Increment a selection generation or establish a new context identity.
3. Clear old protected details and enter loading for the new assignment.
4. Start the authorized query for the new selection.
5. Accept a result only if the task is still active and the context still matches.
6. Map the DTO into validated domain state and update the UI on the main actor.

A task tied to a view's selection ID is one possible lifecycle mechanism. Cancellation alone is not a substitute for checking the response context; work may already be in flight. When a user signs out, cancel all account-specific subscriptions and purge the related state.

The subscription should stream compact current state. Cache geometry by `routeVersionId` and download a changed approved version only when required. Avoid returning an entire GPS history or a route-wide roster to a family phone.

## 9. The map and honest freshness

Use `Map`, a route `MapPolyline`, an assigned-stop marker, and a custom bus annotation. MapKit for SwiftUI supplies these map elements. [MapKit for SwiftUI](https://developer.apple.com/documentation/mapkit/mapkit-for-swiftui).

The route line represents the school's approved path. Do not silently replace it with the fastest driving directions. The bus marker represents the latest accepted observation. If no valid point exists, show the route/stop summary without inventing coordinates. If the last point is stale, dim or relabel it and display the capture time.

A small amount of visual interpolation can make fresh movement look smoother. Stop that animation when updates become stale; do not extrapolate an old point indefinitely and imply the bus is still reporting. Panning turns off automatic following until the user selects **Follow bus** again.

Age the last-update label locally even when no new packet arrives. A connected WebSocket is not proof of fresh bus data. Use the server time reference and the validated observation age carefully, with protection against unreasonable device-clock differences. Configured stale/expiry thresholds belong to the contract and operations policy, not scattered hard-coded constants.

The ETA includes its own generation/validity times. Display it only while the run and source data support it. Completion, cancellation, stale positioning, or an unsupported detour can remove the estimate while leaving useful route information visible.

## 10. QR scanning and enrollment screens

An AVFoundation scanner can use a capture session, camera input, metadata output restricted to QR, and a preview surface bridged into SwiftUI. Apple documents metadata outputs and their callback queues. [AVCaptureMetadataOutput](https://developer.apple.com/documentation/avfoundation/avcapturemetadataoutput).

Keep capture-session setup/start/stop off the UI's blocking path. Stop capture when leaving the scanner or entering the background. Debounce repeated frames so the same code does not start many requests. Keep a visible in-progress state until the server responds, and allow a deliberate retry after failure.

The parser checks an expected HTTPS host, path, token shape, and purpose. It then submits the token to the backend. Decoding a QR image is not authorization. Do not automatically open arbitrary scanned URLs, execute commands, or trust an embedded role/route claim.

Provide manual invitation entry if camera permission is unavailable. **Implemented:** check-in reads the camera's authorization before opening the scanner. When access is denied or restricted, it explains why, offers Open Settings, and keeps the typed-code field; it never opens a blank scanner. A device with no camera shows only the typed code. Backgrounding the app closes the scanner and stops capture. Trip check-in can instead use the authorized staff workflow. If using Universal Links, configure the app/website association and validate the incoming parameters; they should open a review flow, not bypass authorization. [Apple Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app).

I06 privately collects name/address and eligible stop choice. Keep geocoding, eligibility, and staff approval separate. A guardian invitation links an approved relationship; it cannot be replaced with a public student search. Full rules are in [09](09_ENROLLMENT_QR_AND_ATTENDANCE.md).

## 11. Permissions and capabilities

| Feature | Configure/request | Denial behavior |
|---|---|---|
| QR camera | `NSCameraUsageDescription`, then camera access when scanning is requested. | Explain the limitation and offer manual enrollment or staff check-in. |
| User's own location | `NSLocationWhenInUseUsageDescription` only if building that optional feature; request in context. | Bus tracking still works from server coordinates. |
| Visible notifications | Ask through `UNUserNotificationCenter` when the user enables relevant alerts. | Keep tracking and the in-app inbox available. |
| Remote pushes | Push Notifications capability and appropriate App ID/provisioning configuration. | Surface registration problems without blocking the rest of the app. |
| Universal Links | Associated Domains plus a corresponding website association. | A supported web flow remains the fallback. |

Camera access requires the declared purpose string ([Apple camera key](https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription)); optional phone location should request the necessary access level when used ([Apple location authorization](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services)). Use purpose strings that explain the actual feature. There is no custom app toggle that grants system permission, and repeated notification authorization requests do not repeatedly show the system prompt after a decision. Direct users to Settings when appropriate. [Apple notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications).

Remote bus tracking does not require the phone's continuous background-location mode. Do not add that capability merely to keep a network connection alive.

## 12. APNs and lifecycle

Use a notification coordinator with an app-delegate adapter where registration callbacks are needed. APNs registration produces a token for the app/device, which the app sends to the authorized backend. Keep it associated with the correct account, environment, and preferences; update it when registration returns a changed token, and remove the account association on sign-out. Do not assume a fixed token length. [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).

Permission to show alerts and registration for an APNs token are related but distinct. **Implemented:** the Alerts tab (`Alerts/AlertsView.swift`) shows the OS permission state, each approved assignment's approaching-alert choice (saved only when the server confirms), and the in-app inbox; `PushRegistrar` keeps `notifications:registerDevice` current with a stable installation ID, the hex token, the build's APNs environment, and the permission, asking for permission only from an explicit tap, re-reading permission whenever the app becomes active (for example after Settings), and deactivating this phone's registration before sign-out. Sign-out also drops a tapped notification that hasn't opened yet, and the Track and Alerts models return to their empty starting state, so a different account signing in next sees nothing of the previous one (docs/13 §5 A10). The installation ID lives in the Keychain, so a reinstall keeps it. A tapped notification carries only the opaque `assignmentId`; Track keeps it until assignments load, selects it only if it is one of the person's approved assignments, and then shows live state. The ETA appears on the trip card with its age (`EtaPresentation`), only on verified server time, and disappears at `validUntilMs` without waiting for an update. The backend decides which fresh event warrants an alert. The app displays the latest server state after a tap, including cases where the run has since completed or the assignment has been removed.

On background transition, stop camera work, preserve small permitted state, and release resources. iOS may suspend the app; the visible map's subscription is not a reliable background alert engine. On foreground return, restore authentication as needed, refresh access and current run state, and resume the correct subscription. **Implemented:** when the app returns from the background (not after only Control Center or Face ID), a visible Track drops its verified server time, measures it again, and resubscribes. The selected student stays selected, unless a notification tap chose another student meanwhile; that tap wins. A measurement already in flight when the app returns is thrown away, and so is a refresh overtaken by a restart. [Apple background behavior](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background).

Silent/background pushes are not a five-second telemetry channel. Apple may throttle them and does not guarantee delivery. [Background notifications](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app). Detailed server alert handling is in [10](10_ETA_AI_AND_NOTIFICATIONS.md).

## 13. Cache, privacy, and account deletion

For V1, cache approved route geometry, the assigned stop, and a small last-known snapshot with timestamps and account scope. Do not make an offline map look live. Apple map tiles being visible once does not establish that every required basemap region is available offline.

Clear account-bound caches on sign-out and known revocation. An offline cache cannot discover a new remote revocation immediately, so define limited cache lifetime and minimum stored fields. Never cache the entire school roster to simplify guardian search. Keep sensitive enrollment drafts short-lived and protected if saved at all.

**Pending:** Delete account isn't built yet. It waits on an owner decision about which records must be kept after deletion. I22 includes an easily found **Delete account** action. Confirm identity and intent, initiate deletion, and explain its completion status and any information that must be retained. Merely providing temporary deactivation is insufficient for the account-deletion feature Apple describes. [Apple account deletion guidance](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).

Deleting the app account, removing one route assignment, and revoking one guardian link are different operations. Explain the effect before confirmation, and let the backend perform the applicable authorized workflow.

## 14. Accessibility and performance

Use native buttons, labels, lists, and forms. Support system text styles and Dynamic Type, meaningful VoiceOver descriptions, icon-plus-text status, and a text summary beside the map. Use reduced map motion when requested. Do not create a pretend VoiceOver enable switch inside the app.

A large-text layout may move the ETA card below the map or reduce map height. Test actual offered width and safe areas rather than scaling a fixed screenshot. Keep the selected student's name visible without truncating away the distinguishing part.

Measure before adding complexity. Likely concerns are frequent whole-screen invalidation, repeatedly decoding large route geometry, excessive map-camera movement, leaking subscriptions when switching children, or keeping camera capture alive after dismissal. Use bounded caches and image assets appropriate to display size.

## 15. Build and test sequence

First implement all screens with fictional fixtures. Use a repository abstraction that supplies the same domain models for fixtures and the live backend. Then connect a real development sign-in, an authorized assignment query, and one live position from the Pi. Add enrollment, check-in, and alerts after that central path works.

Meaningful checks include:

- Null/invalid coordinates never become a false bus marker.
- Milliseconds convert correctly and old snapshots age without another update.
- Selecting one linked student cannot display a late result for another.
- Expired/revoked access clears protected data.
- Notification denial leaves the app usable.
- Repeated scans produce one logical check-in.
- Wrong-purpose/expired QR tokens are rejected.
- Background/foreground transitions restore current state without old countdowns.
- Notifications tapped after completion open the completed state.
- Largest supported text sizes and VoiceOver preserve usable navigation.

Test camera, real permissions, signing, and push behavior on a physical iPhone. Simulator fixtures are useful, but they do not establish field reliability. Before wider distribution, archive a signed build, use a separate pilot backend, and test the release configuration through the selected beta process. Apple documents TestFlight and release distribution through Xcode/App Store Connect. [Distribution guidance](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

**First end-to-end milestone:** the signed-in phone shows a current, authorized Pi-originated position, becomes honestly stale during a bus-network outage, recovers without replaying old movement, and clears active arrival information when the run ends.

## Sources and remaining decisions

Official sources consulted for platform behavior:

- Xcode support: https://developer.apple.com/support/xcode/
- Observation and model data: https://developer.apple.com/documentation/swiftui/managing-model-data-in-your-app
- MapKit for SwiftUI: https://developer.apple.com/documentation/mapkit/mapkit-for-swiftui
- Convex Swift: https://docs.convex.dev/client/swift/overview
- Convex numeric types: https://docs.convex.dev/client/swift/data-types
- Camera purpose string: https://developer.apple.com/documentation/bundleresources/information-property-list/nscamerausagedescription
- Location authorization: https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services
- Camera metadata output: https://developer.apple.com/documentation/avfoundation/avcapturemetadataoutput
- Notification permission: https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
- APNs registration: https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns
- Background lifecycle: https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background
- Background pushes: https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- Universal Links: https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app
- Account deletion: https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion
- Distribution: https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases

The exact authentication provider, app domain, signing team, supported device population, deployment target, and production configuration remain decisions in [17](17_DECISIONS_AND_SOURCES.md). They do not prevent building fictional previews or defining the client/backend contract now.
