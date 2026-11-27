# I.T.S.S.B. — School administration and Android web

**Intelligence Transportation System for School Buses**  
Status: proposed web scope using the same backend rules as the Pi and iOS app. [Documentation index](README.md).

## 1. Why a web application is part of the system

The backend needs an authorized human workflow for approving routes, assignments, and guardian relationships. Without that workflow, a pending request has no reliable destination and a driver cannot know which route version is approved. Staff also need a way to correct cancellations, replacements, and operational issues without editing database rows manually.

A responsive family website provides Android access to the same transportation records. The staff and family interfaces can share a codebase while using separate navigation and permission checks. The backend remains the authority for both. A browser path named `/admin` is not an access-control mechanism.

The existing visual atlas covers the 24 driver and 28 iPhone screens. The web views described here are additional implementation requirements; their layouts were not included among those 52 concepts.

## 2. Suggested web structure

Use a maintained web stack that the implementer can support, such as React with an appropriate build tool or Next.js if its server features are needed. The framework choice is provisional. Build static client assets once during release rather than using a development server as the production service.

Recommended boundaries are family views, staff views, shared authentication, domain data adapters, common status components, and an API/repository layer. Keep the backend query names and response semantics aligned with [08_DATA_CONTRACTS_AND_API.md](08_DATA_CONTRACTS_AND_API.md).

Native SwiftUI views cannot simply be copied into an Android browser. Share contracts, permission rules, copy, and acceptance cases across the clients; implement platform-appropriate views separately.

## 3. Staff workflows

| Workspace | What staff do | Required feedback |
|---|---|---|
| Organization and access | Authorize staff/drivers and review membership | Current role, scope, who changed it, effective status |
| Devices and buses | Enroll or revoke a device, associate a vehicle, inspect health | Pairing state, last contact, software version, queue/fix age |
| Route library | Find drafts, approved versions, and retired routes | Direction, version, effective dates, reviewer |
| Route review/editor | Review recorded path, stops, ordering, gaps, instructions | Draft changes, validation results, explicit approval action |
| Enrollment queue | Review private details and eligible stop choices | Pending/approved/declined state and reason |
| Guardian links | Verify the intended relationship | Evidence/workflow status, scope, revocation action |
| Service calendar | Maintain operating days, late starts, cancellations | Affected run/service period and family-facing notice |
| Run supervision | See current permitted runs and their information quality | Position age, GPS/network health, route version, replacement history |
| Reports and corrections | Review driver reports, proposed changes, and disputed records | Author/source, timestamps, resolution, audit history |
| Delivery and maintenance | Inspect alert failures, exports, retention, and restore readiness | Job state, limited diagnostics, authorization and confirmation |

Show operational uncertainty directly. A device that has not reported for several minutes should not appear as a normally moving bus. A GPS-derived possible delay should not be presented as a confirmed mechanical problem.

## 4. Route review and publication

A driver-recorded route arrives as a draft. Staff should inspect the geometry and stop order, especially gaps, loops, parallel streets, accidental pauses, and direction-specific access. Review stop labels and pickup instructions as operational information, not merely map decoration.

Approval creates or activates a version with an effective date. Keep the current run pinned to the version it started with. For an active detour, use an explicit run amendment/report and appropriate family message rather than silently changing the reusable route behind every client.

A draft save, submission, approval, rejection, and retirement are distinct actions. Preserve who performed each action and its time. Avoid a generic Save button that unexpectedly publishes a route to families.

## 5. Student assignment and address review

The enrollment queue shows the requested private name/address information only to appropriate reviewers. The reviewer verifies the school relationship and eligible stop selection, resolves geocoding ambiguity, and approves or declines with a useful reason.

Keep the geocoding provider's data flow explicit: entering an address may send it to the configured provider. Decide and document that provider, permitted fields, and retention before pilot use. A manual approved-stop selection path should remain available when automatic geocoding fails.

Staff should not approve a stop solely because it is nearest by straight-line distance. Route direction, actual pedestrian access, road crossings, and school transportation rules determine eligibility. The software can present candidates and distances; staff retain the approval responsibility.

An assignment has effective dates and direction applicability. Removing it preserves the student's account and relevant history. A driver-initiated removal is displayed with its reason and source. Reinstatement creates an authorized recorded change rather than deleting the original removal event.

## 6. Guardian verification

An adult account cannot establish a relationship by searching a name. Use the school's approved verification process and issue a scoped invitation or approved link. Display pending and revoked relationships clearly.

On revocation, future backend reads and alert jobs must fail their relationship check. Known client state should be cleared. The [security guide](11_SECURITY_PRIVACY_AND_ACCESS.md) explains the unavoidable limitation for an already cached offline view.

## 7. Cancellations and replacement buses

Cancel a scheduled service/run explicitly and record who acted and why. The live/family interfaces should receive a cancellation state and relevant notice, not an empty map that looks like a technical error.

A replacement vehicle may serve the same approved route. Staff update the run assignment through an authorized operation that records the transition, checks device/driver authorization, and resolves conflicts. Preserve one clear active assignment and ordering history. A second device cannot claim an active run simply by supplying its ID.

Late starts and special-day service belong in the calendar or scheduled-run configuration. Store the service timezone separately from UTC event timestamps so a date boundary is interpreted intentionally.

## 8. Android/family features

The first responsive family site should provide sign-in, approved assignments, tracking, stop details, alerts, enrollment, guardian linking, eligible check-in, and account management. Use the same meanings as the iPhone app for fresh/stale data, pending actions, accepted check-in, and completed/cancelled runs.

For camera scanning, provide an explicit user action, explain the permission, and keep a compatible manual invitation-code alternative. A trip check-in fallback must preserve authorization and the distinction between pending and accepted records. Students without phones use the authorized staff procedure.

A browser tab may be hidden, suspended, or closed. Do not promise that a web page remains a continuous background tracking process. A visible live subscription and a notification delivery channel are separate features. Validate browser notifications on the actual supported devices before promising parity with iOS.

## 9. Mapping

MapKit JS is a possible Apple Maps implementation for the website. Apple's documentation supports web embedding across platforms including Android, with annotations and overlays; it also specifies Maps-token authorization for initialization and certain API calls. See [MapKit JS](https://developer.apple.com/documentation/mapkitjs).

That setup is separate from native SwiftUI MapKit. Configure the chosen web mapping provider and its credentials, domain restrictions, terms, and usage limits deliberately. Do not put a private signing key in browser JavaScript.

Draw the approved school route. A generic fastest-driving route does not automatically match an ordered school-bus route. If the map cannot load, show the textual stop, trip status, last update time, and appropriate ETA state. Map rendering failure should not hide all useful transportation information.

## 10. Accessibility and small screens

Family views need large controls, readable text, meaningful focus order, and text alternatives to the map. Staff tables need usable filtering, pagination, clear empty states, and detail views that avoid squeezing every field into a phone-width grid.

Use names and words as well as status colors. A stale position, pending enrollment, and cancelled trip should have distinct explanations and recovery actions. Retain the selected student/run context while navigating into a notice or stop detail.

## 11. Staff audit and support tools

Provide a limited diagnostic view with run IDs, device contact age, queue depth, schema/application version, and delivery/error codes. Do not default to exporting full payloads, private addresses, or authentication tokens.

Every sensitive mutation needs server-side authorization and an audit event. Confirmation is especially useful for cancellation, route publication, assignment removal, device revocation, and data exports. These are product confirmations for the authorized human workflow, not a reason to stop building the documentation.

Support staff should have a clear way to distinguish a failing receiver, a disconnected router, a rejected credential, an outdated app, and a server problem. Follow the [troubleshooting guide](16_TROUBLESHOOTING.md) and link to the relevant evidence rather than guessing from a single icon.

## 12. Acceptance and related sources

Verify that the same account receives equivalent authorized trip meaning in iOS and web. Check wrong-organization URLs, stale browser state after revocation, multiple-student switching, camera denial, closed tabs, expired invitations, route-version changes, and notification links after completion. Confirm that staff actions produce the expected audit history and family state.

- [Convex authentication in functions](https://docs.convex.dev/auth/functions-auth).
- [Convex React client](https://docs.convex.dev/client/react).
- [Apple MapKit JS](https://developer.apple.com/documentation/mapkitjs).
- [Data contracts](08_DATA_CONTRACTS_AND_API.md), [security](11_SECURITY_PRIVACY_AND_ACCESS.md), [testing](13_TESTING_AND_ACCEPTANCE.md).

The page grouping and school workflow above are recommended product design choices, to be finalized with the responsible transportation staff.

## 13. What is built now

`apps/web` is React with Vite, built to static files. Hash routes are used, so no server routing is needed.

- **Family tracking (`#/`).** Our own email-code sign-in (Clerk headless, no Clerk prebuilt screens), then the same states and words as the iPhone app: loading, live, waiting for an update, last known location (stale), waiting for the first position, GPS unavailable (no fix or no receiver), trip completed or cancelled, no trip, tracking not available, signed out, and error. The age advances every second without a new update. Nothing is called fresh until verified server time arrives (docs/08 §8.1), and it is measured again whenever the tab becomes visible. A student switcher appears for guardians with more than one linked student.
- **Map.** No map provider is configured yet, so the approved path, assigned stop and bus position are drawn as a simple diagram, with a text summary beside it (§9).
- **Staff (`#/staff/…`).** Routes (approved version, approver, stops), route review (waiting and decided drafts, path, ordered stops, checks, approve with confirmation, reject with a required reason), buses and devices (contact age that turns to "not reporting" past the stale cutoff, family-facing bus name, add a device and replace its credential with the secret shown once, revoke with confirmation; [credential runbook](runbooks/device-credentials.md)), and drivers. The server checks the staff role on every call (docs/08 §11).
- **Diagnostics (`#/staff/diagnostics`).** Backend release and environment, contract version, raw-GPS retention and its last cleanup, and per device: contact age (latest heartbeat or position receipt), software version and upload queue from its heartbeat, active run ID, and most recent run (§11). No positions, addresses or credentials.
- **Service calendar (`#/staff/calendar`).** No-service days and late starts (1 to 240 minutes) with a notice for families, one entry per date, today and later only. Family apps do not show the notices yet.
- **Cancellation and replacement.** On an active run: cancel with a required reason, or cancel and send a free, non-revoked bus. The replacement driver starts the same approved route normally; that start is linked to the cancelled run (`replacesRunId` / `replacedByRunId`). A cancelled run stops accepting positions. Family apps show it as no trip running until the replacement starts; a cancellation notice for families is not built yet.
- **Maintenance windows.** Per device, at most 12 hours, no overlaps, not starting now on a bus that is running. The Pi update tool independently refuses to switch during an active run.
- **Not built yet:** enrollment, guardian linking, alerts, check-in, and organization scoping.

Every page shows a **Development** or **Staging** badge unless built with `VITE_ITSSB_ENVIRONMENT=production`; hovering it shows the release and commit ([release runbook](runbooks/release.md)).

Fictional screens for every state are under `?fixture=` in development only. `bun run screenshots` in `apps/web` captures them.

