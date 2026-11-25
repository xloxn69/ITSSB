# 09 — Enrollment, QR codes, student management, and attendance

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

This document defines the shared workflows used by the Pi, iOS app, backend, and school staff. These are proposed application rules to implement. The exact wire names and result envelopes belong to [data contracts](08_DATA_CONTRACTS_AND_API.md); client screens are listed in [driver touchscreen](05_DRIVER_TOUCHSCREEN.md) and [iOS app](06_IOS_SWIFT_APP.md).

## 1. Four relationships that must stay separate

An authenticated account establishes who signed in. A student route assignment establishes which transportation service that student may use. A guardian relationship establishes whose information an adult may view. A check-in records a particular event or claim during a run.

One record must not automatically imply the others. A verified email does not approve a stop. A scanned route invitation does not approve a guardian relationship. A guardian looking at a student's bus cannot remotely certify the student's boarding.

The school's adopted approval procedure determines how identity and transportation eligibility are verified. The software should record the decision and enforce it consistently instead of quietly treating a matching name as sufficient proof.

## 2. The two QR purposes

| Property | Route enrollment invitation | Trip check-in challenge |
|---|---|---|
| Driver screen | D15 — Route enrollment QR. | D16 — Trip check-in QR. |
| iPhone flow | I05 → I06 → I07 or I08. | I17 → I18. |
| Purpose | Request an approved route/stop assignment. | Submit a check-in claim for an active run. |
| Scope | Organization, route, direction, eligibility policy. | One active `runId`, challenge validity, eligible students. |
| Identity | Signed-in applicant, verified further by school policy. | Signed-in eligible student, derived from session. |
| Result | Pending request or permitted approval. | Accepted, already recorded, rejected, or locally uncertain/pending. |
| Sensitive contents | Opaque temporary reference only. | Opaque temporary challenge only. |
| Physical proof | Does not prove residency or school membership. | Does not independently prove physical boarding. |

The Pi should label these **Join this route** and **Check in for this trip**. A mode selector under **Show QR Code** is appropriate. Do not present one unlabeled generic code whose meaning changes without explanation.

Device pairing in D03 is a third, administrator-facing process. Its code is not a student enrollment invitation and must never grant family tracking access.

## 3. Invitation contents and validation

Use a scoped opaque token resolved by the backend. Keep raw addresses, student lists, notes, and permanent tracking credentials out of the QR payload. Store only what the service needs to validate the invitation: purpose, scope, issue/expiry time, issuer, revocation state, and policy parameters. A hash of a sufficiently random secret token is a reasonable storage design; the implementation should use appropriate cryptographic randomness rather than predictable route-number codes.

A conceptual link might use `https://example.invalid/join?token=example-token`. The `.invalid` domain and token are documentation placeholders, not an operating service. Production requires your actual controlled domain and routing configuration.

The client performs basic parsing: allowed HTTPS host/path, bounded length, supported purpose, and expected encoding. The backend then verifies authenticity/reference, expiration, revocation, intended scope, and caller eligibility. The client never grants access just because a QR decoded successfully.

If the system supports Universal Links, configure the corresponding website/app association. Incoming link parameters still require validation. Apple's guidance specifically warns against allowing incoming links to perform sensitive actions without appropriate handling. [Universal Links](https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app).

Avoid logging the full token in analytics, request logs, or screenshots. When a token expires, show an understandable rescan/code-entry action. An expired invitation must not become a permanent fallback link merely because the bus loses internet.

## 4. Student enrollment from start to finish

### Step 1 — Sign in

The applicant completes the configured account verification flow. The iPhone remembers the intended invitation long enough to resume review after sign-in, under a short-lived handling policy. It must validate the invitation again after authentication, because it may have expired during that interval.

### Step 2 — Review the intended service

Show the route label, morning/afternoon context, school, and a limited explanation of what access is being requested. Do not show the current bus location, route roster, or another family's private data before approval.

### Step 3 — Enter private details

Collect the requested student name and address. Explain the purpose: identifying the appropriate transportation assignment and eligible pickup/drop-off options. Validate required fields without echoing private details into public URLs or diagnostics.

Allow corrections. A failed network submission should preserve the user's draft for the current session rather than forcing repeated typing, but persistent storage of sensitive drafts requires the agreed protection/expiry policy. Keep unnecessary copies out of generic caches.

### Step 4 — Suggest eligible stops

Geocoding produces a candidate address location. The route system then considers approved stops, direction, eligibility, and practical pedestrian access. Straight-line proximity alone is not a suitable final rule: barriers, road crossings, route direction, and school policy can change the appropriate stop.

Show only eligible choices. If geocoding is ambiguous, allow correction or an authorized manual review path. If no permitted stop fits, submit a review request rather than silently creating an unapproved home stop. The backend independently validates the chosen `stopId`; a modified client must not select an arbitrary stop.

### Step 5 — Submit once

Submit through the proposed `enrollment:request` function with a stable `requestId`, invitation reference, private details, and chosen stop. Reuse that identity after a timeout. A double tap should not create several enrollment requests.

The server records the request and returns the applicable outcome. **Request sent** means the backend accepted the request. A local unsent form should say it is still waiting, not pretend that staff have it.

### Step 6 — Approve and activate

Where verification is required, staff review the details and create the approved assignment. Previously verified school records may support a more direct approval rule if explicitly designed. Until approved, the user remains in I07 without live tracking access.

The assignment records route, direction, stop, effective dates, and status. The active run uses a frozen route version. A future assignment change does not retroactively alter earlier trip history. Once approved and effective, the app refreshes access and opens the appropriate authorized route.

## 5. Guardian linking

A guardian starts from the dashboard's **Link a student** flow. Use a school-approved invitation or verification process. Do not expose a searchable list of students or accept a known name/student identifier as sufficient proof of a relationship.

The relationship has its own status and audit history. Pending linking shows a limited result. Approval allows the specific student's authorized transportation data. Revocation stops future protected reads and future alert delivery for that relationship.

A guardian with multiple students can switch contexts, but each query rechecks the selected relationship. The backend should not return every child's information and depend on a client filter. When a relationship changes, the app cancels obsolete subscriptions and clears known restricted state. Offline caches remain subject to limited lifetime because they cannot detect new remote changes immediately.

## 6. Trip check-in at the bus

The driver opens D16 while safely stopped during an authorized active run. The device requests or displays an authorized temporary challenge with `expiresAtMs`. It visibly refreshes according to the configured policy, and becomes unusable when expired or when the run ends.

The same displayed challenge must support several legitimate students. Do not consume it globally after the first scan. The backend deduplicates each student's record for the run and applicable boarding phase.

The phone flow is:

1. Open I17 from the eligible active trip.
2. Request camera access if needed.
3. Read and parse one expected challenge.
4. Stop/debounce repeated frames while submitting.
5. Call the proposed `checkIns:record` with a stable `requestId`, `runId`, and challenge token.
6. Show I18 only after interpreting the actual result.

The server derives student identity from the authenticated session. It validates the approved assignment, run state, challenge purpose, expiration/revocation, and duplicate record. It must not accept a submitted `studentId` as permission to check someone else in.

An accepted result creates a check-in with provenance. An already-recorded result refers to the existing logical record. A rejected request explains a safe recovery action, such as scanning the current trip code. A timeout after submission leaves the outcome uncertain until the same request is reconciled; it does not justify an automatic second check-in.

## 7. What a check-in proves

A scan proves that an authenticated account submitted a valid challenge under the implemented rules. A screenshot can still be shared while valid. GPS near the stop, phone location, or a short token lifetime do not independently establish that a particular child boarded the bus.

Use explicit source labels such as **student QR claim**, **staff recorded**, and **staff correction** in the data model and audit view. The precise stored enum names are an implementation detail to keep consistent with the contract. Public-facing wording should avoid implying more certainty than the record supports.

The system has no purchased door, seat, or passenger-count sensor. A roster count, assigned seat, bus-stop arrival, and trip completion are different facts. If the school requires staff verification, model that as its own recorded step instead of renaming a student scan “verified boarding.”

## 8. No-phone and offline workflows

Students without phones remain supported. An authorized driver/staff member can record the applicable attendance action while safely stopped, using the intended student and run. That action records who performed it and when.

V1 supports continued operation of an already authorized active run during a bus-network outage. Staff-recorded actions can be saved locally and queued, with **Pending sync** clearly visible. The backend rechecks applicable authority when reconciling them; it does not accept any historical claim merely because it came from a device queue.

An iPhone that cannot reach the backend cannot truthfully display an accepted check-in. The simplest first version asks the student to use staff assistance rather than building a separate offline phone challenge-verification system. If a request was already sent when the response was lost, reconcile it using the same request identity when connectivity returns.

If the Pi is offline, only an unexpired, appropriately authorized cached challenge can be displayed under an explicitly implemented policy. Do not mint unlimited new cloud-authorized challenges locally. The conservative fallback is staff-recorded attendance, with clear synchronization state.

## 9. Corrections, seat notes, and removal

D17 and D18 preserve the requested student-management features. The authorized driver can review relevant students, assign or update permitted seat information, and record appropriate operational notes. Keep notes scoped to their route/student context and visible only to the authorized staff or expressly permitted family fields.

A correction identifies the original record, intended student/run, new status, reason, author, and time. Preserve the history. Do not silently erase a scan to make the final counts look cleaner. If two users edit the same record, apply the defined revision/conflict behavior.

**Remove from route** revokes one assignment through the proposed `routes:removeAssignment` operation. Before confirming, show the affected student, route/direction, and effect. Require a reason and verify current driver or administrator authorization. The action does not delete the student's global account, unrelated assignments, guardian relationships, or historical attendance.

An offline removal may hide the student locally and queue a request, but it remains **Removal pending sync**. It does not instantly revoke cloud tracking. If authorization changed during the outage, the server may reject or route the request for review. The Pi must show that result rather than continuing to claim success.

## 10. Audit and practical acceptance cases

The audit record should support answering who requested or changed what, under which route/run, at what capture and receipt times, and with what result. Use the canonical `*AtMs` timestamps and preserve source references. Do not put raw QR secrets or unrestricted private address data in broadly accessible audit streams.

Before pilot use, demonstrate these cases with fictional records:

| Case | Required result |
|---|---|
| Expired enrollment QR | Rejected; rescan/manual-entry recovery; no tracking access. |
| Enrollment QR used as check-in | Wrong purpose rejected. |
| Check-in QR used as enrollment | Wrong purpose rejected. |
| Address geocoding fails | Correction/manual review available; no fabricated approved stop. |
| Client changes chosen stop ID | Backend eligibility validation rejects it. |
| Guardian knows a student's name | No relationship/access is granted from the name alone. |
| Two students scan one valid run challenge | Both eligible students can record their own check-in. |
| One student scans repeatedly | One logical check-in; existing result returned. |
| Screenshot shared | System does not claim physical verification from the scan alone. |
| Phone loses response after acceptance | Retry with same request identity returns the existing result. |
| Student has no phone | Authorized staff workflow remains available. |
| Driver removes another route's student | Server rejects unauthorized scope. |
| Removal queued offline | Clearly pending until acceptance; history/account preserved. |
| Run ends while a challenge is visible | Backend rejects new invalid check-ins; display expires/updates. |

## Sources and related documents

- Apple, Universal Links and incoming-link validation: https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app
- Convex, authenticated identity in functions: https://docs.convex.dev/auth/functions-auth
- Apple, QR/camera metadata output: https://developer.apple.com/documentation/avfoundation/avcapturemetadataoutput

The workflow, permission scope, invitation lifetime, review policy, and attendance semantics are I.T.S.S.B. design choices that require implementation. Continue with [backend](07_BACKEND_AND_DATABASE.md), [access control](11_SECURITY_PRIVACY_AND_ACCESS.md), and [acceptance tests](13_TESTING_AND_ACCEPTANCE.md).
