# I.T.S.S.B. — Security, privacy, and access

**Intelligence Transportation System for School Buses**  
Status: proposed application rules and pilot controls, not a certification or legal compliance finding. [Documentation index](README.md).

## 1. Protect the actual transportation relationships

The essential rule is that an account receives only the data and actions belonging to its approved transportation relationship. Signing in establishes account identity. Staff approval establishes route, driver, and guardian authority. The application must not infer authority from a selected role, a known student name, an invitation screenshot, or a route display number.

Use the identity provider's supported authentication flow and server verification. Avoid inventing a custom password system or treating a token decoded in the app as verified identity. Convex exposes identity in functions; each protected function must then enforce the application's authorization rules. [Official reference](https://docs.convex.dev/auth/functions-auth).

## 2. Authorization matrix

| Actor | Can read | Can request or change | Must not receive |
|---|---|---|---|
| Unauthenticated visitor | Public product/help content | Begin sign-in | Bus tracking, rosters, assignments, private invitations resolved into protected details |
| Student | Own approved assignment, permitted run state, own check-in, relevant alerts | Own enrollment request, eligible check-in, preferences, account deletion | Other students' identities/addresses/notes, device secrets, administrative controls |
| Guardian | Approved linked students and permitted transportation details | Link request, own preferences, own account management | Arbitrary student lookup, unlinked trips, a remote boarding-claim button |
| Driver | Required roster and operating data for authorized route/run | Authorized starts/ends, route drafts, seat notes, corrections, scoped removal, reports | Other schools' data or automatic administrator powers |
| Dispatcher/admin | Appropriate organization records for assigned responsibility | Approvals, assignments, calendars, replacement vehicles, incident review | Cross-organization data without a separate explicit grant |
| Device | Minimal approved configuration, route/roster needed for operation | Telemetry and authorized operating events for its scope | Database administration, arbitrary user impersonation |
| Worker | Data required for its internal job | Prediction, delivery, maintenance through internal functions | Unrestricted public endpoints or inherited user authority assumed without checking |

Enforce this matrix in server queries, mutations, actions, HTTP handlers, and subscriptions. A hidden UI element is only a usability measure. Test direct requests that bypass the UI.

## 3. Field-level minimization

Return a tracking snapshot, not an entire run document with internal fields attached. Students need a bus position, their stop, current status, and a relevant estimate. They do not need every assigned student's name.

Private address information belongs in the enrollment/approval workflow. After an approved stop is assigned, the Pi usually needs that stop and the relevant roster details rather than the student's full home address. A guardian should see an assigned seat only if the school intentionally authorizes that field. Operational notes should remain staff data unless a specific field has an explicit family-facing purpose.

Use response builders that select allowed fields deliberately. Avoid adding private fields to a generic shared object and relying on each client to hide them.

## 4. Device identity and provisioning

Give each Pi its own revocable credential, linked to an organization and device assignment. Derive the submitting device from that credential; a `deviceId` supplied in an untrusted JSON body cannot establish identity. Check allowed run, pairing generation where used, and current device status before accepting events.

For the initial prototype, an authorized administrator installs the device secret into `/etc/itssb/device.env`, owned by root with mode `0600`. The system manager reads the file when starting `itssb-device.service`; the non-root service inherits the needed environment values. The application does not receive general `sudo` access to rewrite system configuration.

Automatic pairing and credential rotation require an implemented provisioning mechanism. The designed D03 screen can show pairing status, but a screen alone does not securely install secrets. Document who issues a credential, where it is installed, how the old one is revoked, and how the service is restarted. See the [Pi setup guide](03_RASPBERRY_PI_SETUP.md) and [operations guide](14_DEPLOYMENT_AND_OPERATIONS.md).

Keep a deployment administration key, APNs signing key, and identity-provider management credentials in the appropriate backend/deployment secret environment. They do not belong in the Pi browser, Swift bundle, source repository, example configuration, or logs.

## 5. Local driver access and the kiosk

A local PIN unlocks an already authorized driver session. Use a maintained password-verification implementation, attempt limits, lockout/backoff, and an authorized recovery process. Avoid a universal bypass PIN. Conceal the roster when locked and clear or replace driver context between shifts.

A PIN does not provide physical tamper resistance for the entire Pi or removable microSD. SQLite does not automatically encrypt stored data. If physical-loss protection is a pilot requirement, choose and test an appropriate storage/encryption and key-management approach before storing more personal data.

The API at `127.0.0.1:8765` is local but still needs request protection. Require driver authorization for sensitive operations, validate expected host/origin, use a session/CSRF design for browser actions, and reject broad cross-origin requests. Bind only the intended interface. Loopback binding helps limit remote access; it does not establish who is allowed to perform a local action.

Keep administrative maintenance behind its intended authorization. Do not run Chromium as root or weaken its sandbox to bypass a startup problem.

## 6. Network and mobile credentials

Use authenticated TLS connections for backend traffic with normal certificate verification. Do not disable verification to make a request succeed. A time/configuration/certificate failure belongs in troubleshooting, not in a permanent insecure flag.

Use the supported authentication SDK and platform-protected storage for iOS session material. Avoid putting reusable secrets in ordinary preference files or bundled JSON. Clear account-bound caches and detach push token associations on sign-out according to the backend design. Device tokens can change; maintain the account/device association instead of treating the first registration as permanent. [Apple APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).

Native MapKit does not require embedding a backend administrator credential. Web mapping credentials have their own intended constraints and configuration. Do not assume that every value named a token has the same secrecy and lifecycle requirements.

## 7. Invitations, check-ins, and changes

An enrollment invitation and a trip check-in challenge have separate purposes and validation rules. Limit their lifetime and scope. Verify account eligibility on the backend even when the token is valid. Do not place addresses or rosters in a QR payload. Keep tokens out of analytics URLs and routine logs.

A shared trip QR supports multiple eligible students; consuming it globally after the first scan would prevent the rest of the bus from checking in. Deduplicate the accepted record per student/run/phase instead. Expiration limits replay but does not prove physical presence.

Record who changed a seat note, corrected attendance, removed an assignment, or approved a route. Record the object, action, old/new state where appropriate, timestamp, reason, and source. Restrict audit access and avoid duplicating unnecessary personal details in the log.

An authorized driver can remove a student from their own route. The backend validates that scope at acceptance time, including for an offline-queued request. This removes the relevant assignment, not the person's entire account. The [QR and attendance guide](09_ENROLLMENT_QR_AND_ATTENDANCE.md) defines the complete flow.

## 8. Offline access and revocation

The first offline scope is continuation of an already authorized run with bounded cached information. A new offline start needs an explicit, expiring grant design and is outside the default first milestone.

An offline device cannot discover a newly revoked permission until it communicates again. Limit the duration and fields of offline caches, identify their last validation time, and revalidate when connectivity returns. Known revocation clears restricted app content and ends its relevant subscriptions; unknown revocation cannot honestly be described as instantly applied everywhere.

Distinguish a queued action from accepted state. A pending route removal can change the local display, but it does not establish that the server has already removed family access.

## 9. Retention and deletion

Agree with the responsible school on which records are necessary and how long each is retained. Define separate periods for raw GPS, aggregated travel-time statistics, check-ins, enrollment details, operational notes, audits, and backups. This document does not establish legal retention periods.

For a fictional-data prototype, choose short retention and make cleanup observable. A proposed pilot starting point is to keep raw GPS no longer than 30 days for evaluation, then retain only justified aggregates; the school must approve or change that before using real records. Acknowledged local telemetry should have a short cleanup window, and expired roster caches should be removed.

Account deletion needs an in-app initiation flow for an App Store app supporting account creation. Explain timing and any information that must be retained, remove other associated personal data, and report completion. Deleting an app account is a different operation from changing a transportation assignment. [Apple account-deletion guidance](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).

Include backups and exports in the retention/deletion design. Otherwise an apparently deleted address may remain indefinitely in an unmanaged export.

## 10. Incident and access recovery

| Event | Required response |
|---|---|
| Lost or replaced Pi | Revoke its credential, reassign intentionally, review cached-data exposure, provision replacement separately |
| Wrong guardian link | Revoke the relationship, clear known client state, stop future alerts, review how approval occurred |
| Unexpected cross-route access | Stop the affected release, reproduce with fictional accounts, correct server checks, verify related endpoints |
| Leaked secret | Revoke/rotate it, remove it from active configurations, inspect relevant logs; deleting the visible copy alone is insufficient |
| Accidental route removal | Authorized review and a new assignment change with history; do not erase the original audit event |
| Notification to wrong recipient | Disable the offending job/rule, correct recipient resolution, check queued jobs and token associations |

Recovery actions must be authorized and auditable. Diagnostics should expose event IDs and error codes needed to investigate without exporting complete student records.

## Acceptance and sources

Before a pilot, demonstrate cross-organization denial, wrong-route denial, revoked guardian denial, attempted client role escalation, expired QR rejection, scoped driver removal, offline pending state, secret-free diagnostics, and account-cache clearing. See [testing](13_TESTING_AND_ACCEPTANCE.md).

- [Convex authentication in functions](https://docs.convex.dev/auth/functions-auth).
- [Convex HTTP actions](https://docs.convex.dev/functions/http-actions).
- [Apple APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).
- [Apple account deletion](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion).

The access matrix, local provisioning choice, cache limits, and incident workflow are recommended I.T.S.S.B. design decisions.
