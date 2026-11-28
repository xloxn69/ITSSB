import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * V1 schema for the first milestone: one authorized device reports one run,
 * and authorized people read its live state. See docs/07 and docs/08.
 *
 * Times are UTC epoch milliseconds with an `Ms` suffix.
 */

export const runState = v.union(
  v.literal("scheduled"),
  v.literal("active"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const role = v.union(v.literal("staff"), v.literal("driver"), v.literal("family"));

export const routeDirection = v.union(v.literal("to_school"), v.literal("from_school"));

/** One stop in a recorded draft, in travel order. */
export const draftStop = v.object({
  label: v.string(),
  latitude: v.number(),
  longitude: v.number(),
  instructions: v.optional(v.string()),
});

export default defineSchema({
  /** People. Linked to the identity provider by `tokenIdentifier`. */
  users: defineTable({
    tokenIdentifier: v.string(),
    role,
    displayName: v.string(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_role", ["role"]),

  /**
   * An enrolled Pi. The bearer credential is never stored, only its SHA-256
   * hash, so a database read cannot be replayed as a device.
   */
  devices: defineTable({
    label: v.string(),
    credentialHash: v.string(),
    revoked: v.boolean(),
    /** Family-facing name of the bus this Pi is installed in ("Bus 12"). */
    busLabel: v.optional(v.string()),
  }).index("by_credential_hash", ["credentialHash"]),

  /**
   * One execution of an approved route version. Started and ended only by
   * `POST /device/v1/trip-events` with a driver operating grant. The start and
   * end request fields are the idempotency receipts: a retry with the same
   * `requestId` and content returns the stored result.
   */
  runs: defineTable({
    deviceId: v.id("devices"),
    routeVersionId: v.string(),
    state: runState,
    startRequestId: v.string(),
    startedAtMs: v.optional(v.number()),
    endedAtMs: v.optional(v.number()),
    // Optional so runs written before trip events existed stay valid.
    driverUserId: v.optional(v.id("users")),
    /** Grant that started / ended the run; an exact retry must present it again. */
    startGrantId: v.optional(v.id("driverGrants")),
    endGrantId: v.optional(v.id("driverGrants")),
    serviceDate: v.optional(v.string()),
    serviceTimezone: v.optional(v.string()),
    startCapturedAtMs: v.optional(v.number()),
    endRequestId: v.optional(v.string()),
    endCapturedAtMs: v.optional(v.number()),
    endedByDriverUserId: v.optional(v.id("users")),
    /** Final `runSequence` boundary from the end request; bounds late history. */
    lastRunSequence: v.optional(v.union(v.number(), v.null())),
    /** Staff cancellation (docs/12 §7): who, when, and why. `endedAtMs` is set too. */
    cancelledAtMs: v.optional(v.number()),
    cancelledByUserId: v.optional(v.id("users")),
    cancelReason: v.optional(v.string()),
    /** The bus staff sent to take over this cancelled run's route. */
    replacementDeviceId: v.optional(v.id("devices")),
    /** The replacement bus's run that took over, and on it, the run it replaced. */
    replacedByRunId: v.optional(v.id("runs")),
    replacesRunId: v.optional(v.id("runs")),
  })
    .index("by_device_state", ["deviceId", "state"])
    .index("by_route_version_state", ["routeVersionId", "state"])
    .index("by_device_start_request", ["deviceId", "startRequestId"])
    .index("by_device_end_request", ["deviceId", "endRequestId"])
    .index("by_replacement_device", ["replacementDeviceId"]),

  /**
   * A driver's delay or issue report on a run (docs/08 §9.3, docs/05 D20),
   * sent from the Pi with the driver operating grant. A fixed category and
   * optional minutes only: no free text is stored. One row per device and
   * `requestId`; a retry returns it.
   */
  runReports: defineTable({
    runId: v.id("runs"),
    deviceId: v.id("devices"),
    driverUserId: v.id("users"),
    grantId: v.id("driverGrants"),
    requestId: v.string(),
    category: v.union(
      v.literal("traffic"),
      v.literal("mechanical"),
      v.literal("weather"),
      v.literal("student_incident"),
      v.literal("other"),
    ),
    expectedDelayMinutes: v.union(v.number(), v.null()),
    /** On the bus (Pi clock). */
    capturedAtMs: v.number(),
    receivedAtMs: v.number(),
  })
    .index("by_device_request", ["deviceId", "requestId"])
    .index("by_run", ["runId"]),

  /**
   * A server-issued driver operating grant (docs/07 §6, docs/08 §6): proof
   * that an authorized driver may operate this device on these route
   * versions until `expiresAtMs`. Only the SHA-256 hash is stored. A device
   * credential alone never starts or ends a run.
   */
  driverGrants: defineTable({
    tokenHash: v.string(),
    deviceId: v.id("devices"),
    driverUserId: v.id("users"),
    routeVersionIds: v.array(v.id("routeVersions")),
    issuedAtMs: v.number(),
    expiresAtMs: v.number(),
    revoked: v.boolean(),
    /** Staff member who issued it from the console; absent for command-line and seed grants. */
    issuedByUserId: v.optional(v.id("users")),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_expires", ["expiresAtMs"]),

  /** Accepted telemetry history. `eventId` makes delivery idempotent. */
  telemetryEvents: defineTable({
    eventId: v.string(),
    runId: v.id("runs"),
    deviceId: v.id("devices"),
    bootId: v.string(),
    sequence: v.number(),
    runSequence: v.number(),
    capturedAtMs: v.number(),
    receivedAtMs: v.number(),
    latitude: v.number(),
    longitude: v.number(),
    speedMps: v.union(v.number(), v.null()),
    headingDegrees: v.union(v.number(), v.null()),
    horizontalAccuracyM: v.union(v.number(), v.null()),
    fixMode: v.union(v.literal(2), v.literal(3)),
  })
    .index("by_event_id", ["eventId"])
    .index("by_run_captured", ["runId", "capturedAtMs"])
    .index("by_run_sequence", ["runId", "runSequence"]),

  /**
   * Latest health heartbeat per device (docs/08 §7). One row per device,
   * replaced by each newer report; `receivedAtMs` is server time. Holds no
   * coordinates. Lets families tell "connected, no GPS fix" from "no contact".
   */
  deviceHealth: defineTable({
    deviceId: v.id("devices"),
    bootId: v.string(),
    capturedAtMs: v.number(),
    receivedAtMs: v.number(),
    appVersion: v.string(),
    /** As reported by the Pi; informational, never used for access. */
    reportedRunId: v.union(v.string(), v.null()),
    gpsStatus: v.union(v.literal("valid"), v.literal("no_fix"), v.literal("receiver_missing"), v.literal("unknown")),
    lastValidFixAtMs: v.union(v.number(), v.null()),
    pendingCount: v.number(),
    oldestPendingCapturedAtMs: v.union(v.number(), v.null()),
    /**
     * Receipt of the report these values came from. `receivedAtMs` also moves
     * on a delayed report that replaces nothing. Absent on rows from before.
     */
    statusReceivedAtMs: v.optional(v.number()),
    // Measurements (docs/13 §10); absent when the Pi's software predates them,
    // null when the Pi cannot measure them. Staff diagnostics only.
    uploadConsecutiveFailures: v.optional(v.number()),
    uploadRetriesSinceStart: v.optional(v.number()),
    lastUploadErrorClass: v.optional(v.union(v.string(), v.null())),
    processRssBytes: v.optional(v.union(v.number(), v.null())),
    memAvailableBytes: v.optional(v.union(v.number(), v.null())),
    cpuTemperatureC: v.optional(v.union(v.number(), v.null())),
    databaseBytes: v.optional(v.union(v.number(), v.null())),
  }).index("by_device", ["deviceId"]),

  /** Compact current position per run; what clients subscribe to. */
  liveState: defineTable({
    runId: v.id("runs"),
    eventId: v.string(),
    capturedAtMs: v.number(),
    receivedAtMs: v.number(),
    latitude: v.number(),
    longitude: v.number(),
    speedMps: v.union(v.number(), v.null()),
    headingDegrees: v.union(v.number(), v.null()),
    // Optional so rows written before these fields existed stay valid.
    horizontalAccuracyM: v.optional(v.union(v.number(), v.null())),
    /** Increments each time the live position is replaced (docs/08 `liveRevision`). */
    revision: v.optional(v.number()),
  }).index("by_run", ["runId"]),

  /**
   * Route progress per run (docs/10 §2), updated from live-applied telemetry
   * in the same transaction. `alongM` is distance along the approved path and
   * never decreases; `stops` is in travel order. Arrival and departure times
   * here are inferred from GPS, never a staff-confirmed action.
   */
  runProgress: defineTable({
    runId: v.id("runs"),
    routeVersionId: v.string(),
    alongM: v.number(),
    atMs: v.number(),
    lastStatus: v.union(v.literal("on_route"), v.literal("off_route"), v.literal("ambiguous")),
    /** The newest matched fix's own distance along the path; confirms departures. */
    lastFixAlongM: v.optional(v.number()),
    /** Telemetry event most recently matched (or not) against the route. */
    lastEventId: v.string(),
    stops: v.array(
      v.object({
        stopId: v.string(),
        arrivedAtMs: v.union(v.number(), v.null()),
        departedAtMs: v.union(v.number(), v.null()),
      }),
    ),
  }).index("by_run", ["runId"]),

  /**
   * Every arrival estimate as it was made (docs/10 §4), kept for evaluation
   * against later arrival outcomes. Never rewritten after the fact.
   */
  etaPredictions: defineTable({
    runId: v.id("runs"),
    routeVersionId: v.string(),
    stopId: v.string(),
    sourceEventId: v.string(),
    sourceCapturedAtMs: v.number(),
    liveRevision: v.number(),
    generatedAtMs: v.number(),
    arrivalAtMs: v.number(),
    validUntilMs: v.number(),
    algorithmVersion: v.string(),
  }).index("by_run_stop_generated", ["runId", "stopId", "generatedAtMs"]),

  /**
   * An immutable approved route version: label, bounded path, and stops.
   * `runs.routeVersionId` stores this table's ID as a string.
   */
  routeVersions: defineTable({
    label: v.string(),
    path: v.array(v.object({ latitude: v.number(), longitude: v.number() })),
    // Approval metadata. Optional so versions created before route review existed stay valid.
    routeId: v.optional(v.id("routes")),
    versionNumber: v.optional(v.number()),
    sourceDraftId: v.optional(v.id("routeDrafts")),
    approvedByUserId: v.optional(v.id("users")),
    approvedAtMs: v.optional(v.number()),
    effectiveFromMs: v.optional(v.number()),
  }).index("by_route", ["routeId"]),

  stops: defineTable({
    routeVersionId: v.id("routeVersions"),
    label: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    /** Travel order within the version, from 0. */
    sequence: v.optional(v.number()),
    instructions: v.optional(v.string()),
  }).index("by_route_version", ["routeVersionId"]),

  /**
   * A stable route (docs/07 `routes`). Its approved versions are immutable;
   * `currentVersionId` is the one a new run pins (lib/routeVersions.ts).
   */
  routes: defineTable({
    label: v.string(),
    direction: routeDirection,
    currentVersionId: v.optional(v.id("routeVersions")),
    createdAtMs: v.number(),
  }),

  /**
   * A driver-recorded route awaiting staff review (docs/12 §4). Approval
   * copies it into a new immutable `routeVersions` row; the draft is never
   * shown to families.
   */
  routeDrafts: defineTable({
    /** The route this revises, or absent for a new route. */
    routeId: v.optional(v.id("routes")),
    label: v.string(),
    direction: routeDirection,
    path: v.array(v.object({ latitude: v.number(), longitude: v.number() })),
    stops: v.array(draftStop),
    status: v.union(v.literal("submitted"), v.literal("approved"), v.literal("rejected")),
    recordedByDeviceId: v.optional(v.id("devices")),
    submittedAtMs: v.number(),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAtMs: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    approvedVersionId: v.optional(v.id("routeVersions")),
    // Set when a driver submitted it from the Pi (docs/08 §7.1); optional so
    // drafts written before device submission existed stay valid.
    /** The Pi's own draft id: one server draft per device draft. */
    deviceDraftId: v.optional(v.string()),
    /** The requestId of the submission that stored it. */
    submitRequestId: v.optional(v.string()),
    /** SHA-256 of the recording's content; a retry must match it. */
    contentHash: v.optional(v.string()),
    /** The driver whose operating grant carried the submission. */
    recordedByUserId: v.optional(v.id("users")),
    recordingStartedAtMs: v.optional(v.number()),
    recordingFinishedAtMs: v.optional(v.number()),
    /** Path indexes where the receiver lost the fix before the point: not measured travel. */
    gapBeforeIndexes: v.optional(v.array(v.number())),
  })
    .index("by_status", ["status", "submittedAtMs"])
    .index("by_device_draft", ["recordedByDeviceId", "deviceDraftId"])
    .index("by_device_request", ["recordedByDeviceId", "submitRequestId"]),

  /** A student record. `userId` is the student's own account, if they have one. */
  students: defineTable({
    displayName: v.string(),
    userId: v.optional(v.id("users")),
  }).index("by_user", ["userId"]),

  /** A staff-approved student → route version → stop relationship (docs/07). */
  assignments: defineTable({
    studentId: v.id("students"),
    routeVersionId: v.id("routeVersions"),
    stopId: v.id("stops"),
    status: v.union(v.literal("approved"), v.literal("revoked")),
    // Optional so assignments created before enrollment existed stay valid.
    approvedByUserId: v.optional(v.id("users")),
    approvedAtMs: v.optional(v.number()),
    enrollmentRequestId: v.optional(v.id("enrollmentRequests")),
    revokedAtMs: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    revokeReason: v.optional(v.string()),
    /** Driver-maintained seat and operational note (docs/09 §9). Staff data; never sent to families. */
    seatLabel: v.optional(v.string()),
    driverNote: v.optional(v.string()),
    /** Capture time of the change that set them; an older queued change is superseded. */
    seatNoteCapturedAtMs: v.optional(v.number()),
  })
    .index("by_student", ["studentId"])
    .index("by_route_version", ["routeVersionId"]),

  /** A school-approved guardian → student link. Never created by a name search. */
  guardianLinks: defineTable({
    guardianUserId: v.id("users"),
    studentId: v.id("students"),
    status: v.union(v.literal("approved"), v.literal("revoked")),
    // Optional so links created before guardian linking existed stay valid.
    approvedByUserId: v.optional(v.id("users")),
    approvedAtMs: v.optional(v.number()),
    revokedAtMs: v.optional(v.number()),
    revokedByUserId: v.optional(v.id("users")),
    revokeReason: v.optional(v.string()),
  })
    .index("by_guardian", ["guardianUserId"])
    .index("by_guardian_student", ["guardianUserId", "studentId"])
    .index("by_student", ["studentId"]),

  /**
   * A scoped opaque token (docs/09 §2–§3): a route enrollment invitation, a
   * guardian link invitation, or a trip check-in challenge. Only the SHA-256
   * hash of the token is stored. A token is checked for its own purpose,
   * expiry, revocation, and scope; it never grants anything by decoding.
   */
  scopedTokens: defineTable({
    tokenHash: v.string(),
    purpose: v.union(
      v.literal("route_enrollment"),
      v.literal("guardian_link"),
      v.literal("trip_check_in"),
      // Staff web only (docs/12 §1); never offered to families or the Pi.
      v.literal("staff_invitation"),
    ),
    /** route_enrollment: the route whose current approved stops are offered. */
    routeId: v.optional(v.id("routes")),
    /** guardian_link: the one student this invitation may link. */
    studentId: v.optional(v.id("students")),
    /** trip_check_in: the one run this challenge belongs to. */
    runId: v.optional(v.id("runs")),
    /** staff_invitation: the name the new staff account gets. */
    displayName: v.optional(v.string()),
    issuedByUserId: v.optional(v.id("users")),
    issuedByDeviceId: v.optional(v.id("devices")),
    issuedAtMs: v.number(),
    expiresAtMs: v.number(),
    revoked: v.boolean(),
    /** Single-use tokens (guardian_link, staff_invitation) record their first use. */
    singleUse: v.boolean(),
    usedAtMs: v.optional(v.number()),
    usedByTokenIdentifier: v.optional(v.string()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_purpose", ["purpose", "issuedAtMs"])
    .index("by_run", ["runId"]),

  /**
   * Attendance records (docs/09 §6–§9). Append-only: a correction is a new
   * row naming the one it corrects, so history is never erased. The current
   * status for a student, run and phase is the newest row.
   */
  checkIns: defineTable({
    runId: v.id("runs"),
    studentId: v.id("students"),
    assignmentId: v.id("assignments"),
    phase: v.literal("boarding"),
    status: v.union(v.literal("boarded"), v.literal("not_boarded")),
    source: v.union(v.literal("student_qr_claim"), v.literal("staff_recorded"), v.literal("staff_correction")),
    /** Student for a QR claim; the driver or staff member otherwise. */
    recordedByUserId: v.id("users"),
    viaDeviceId: v.optional(v.id("devices")),
    challengeId: v.optional(v.id("scopedTokens")),
    correctsCheckInId: v.optional(v.id("checkIns")),
    reason: v.optional(v.string()),
    /** When it happened (device capture time for a queued action). */
    recordedAtMs: v.number(),
    receivedAtMs: v.number(),
  })
    .index("by_run_student_phase", ["runId", "studentId", "phase"])
    .index("by_run", ["runId"]),

  /**
   * Idempotency receipts for check-ins and driver roster actions. `scope` is
   * `user:<id>` or `device:<id>`; the same scope and `requestId` with the
   * same `fingerprint` returns the stored outcome, a different one conflicts.
   */
  requestReceipts: defineTable({
    scope: v.string(),
    requestId: v.string(),
    fingerprint: v.string(),
    status: v.union(v.literal("accepted"), v.literal("already_recorded"), v.literal("superseded"), v.literal("rejected")),
    checkInId: v.optional(v.id("checkIns")),
    code: v.optional(v.string()),
    message: v.optional(v.string()),
    atMs: v.number(),
  }).index("by_scope_request", ["scope", "requestId"]),

  /**
   * A private enrollment request (docs/09 §4). Keyed by the applicant's
   * verified sign-in identity, because a new applicant has no approved
   * `users` row. Staff approval creates the account link, the student, and
   * the assignment; until then the applicant can track nothing.
   */
  enrollmentRequests: defineTable({
    applicantTokenIdentifier: v.string(),
    requestId: v.string(),
    invitationId: v.id("scopedTokens"),
    routeId: v.id("routes"),
    /** The route version whose stops were offered. */
    routeVersionId: v.id("routeVersions"),
    studentName: v.string(),
    /** Private. Returned only to staff review, never to drivers or other families. */
    address: v.string(),
    note: v.optional(v.string()),
    requestedStopId: v.optional(v.id("stops")),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    submittedAtMs: v.number(),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAtMs: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    assignmentId: v.optional(v.id("assignments")),
  })
    .index("by_applicant_request", ["applicantTokenIdentifier", "requestId"])
    .index("by_applicant", ["applicantTokenIdentifier"])
    .index("by_status", ["status", "submittedAtMs"]),

  /**
   * A guardian's request to link one student, made with a school-issued
   * single-use invitation (docs/09 §5). Approval creates the `guardianLinks`
   * row; a name alone never does.
   */
  guardianLinkRequests: defineTable({
    guardianTokenIdentifier: v.string(),
    requestId: v.string(),
    invitationId: v.id("scopedTokens"),
    studentId: v.id("students"),
    guardianName: v.string(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    submittedAtMs: v.number(),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAtMs: v.optional(v.number()),
    decisionReason: v.optional(v.string()),
    guardianLinkId: v.optional(v.id("guardianLinks")),
  })
    .index("by_guardian_request", ["guardianTokenIdentifier", "requestId"])
    .index("by_guardian", ["guardianTokenIdentifier"])
    .index("by_status", ["status", "submittedAtMs"]),

  /**
   * A person's alert preference for one assignment (docs/10 §8). Separate
   * from the phone's notification permission, which `pushTokens` records.
   */
  notificationPreferences: defineTable({
    userId: v.id("users"),
    assignmentId: v.id("assignments"),
    approachingEnabled: v.boolean(),
    approachingMinutes: v.number(),
    updatedAtMs: v.number(),
    lastRequestId: v.string(),
    /** Recent save requestIds, newest first; a retry of any of them changes nothing. */
    recentRequestIds: v.optional(v.array(v.string())),
  }).index("by_user_assignment", ["userId", "assignmentId"]),

  /**
   * One app installation's APNs token for the signed-in account. A token
   * belongs to at most one active account; registering it for another
   * account deactivates the old association.
   */
  pushTokens: defineTable({
    userId: v.id("users"),
    installationId: v.string(),
    token: v.union(v.string(), v.null()),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    permission: v.union(
      v.literal("authorized"),
      v.literal("provisional"),
      v.literal("denied"),
      v.literal("not_determined"),
    ),
    /** False once the token moved, was replaced, or APNs rejected it permanently. */
    active: v.boolean(),
    updatedAtMs: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_installation", ["installationId"])
    .index("by_token", ["token"]),

  /**
   * One logical alert: recipient, run, assigned stop, and type
   * (`logicalKey`). Created at most once, so a fluctuating estimate never
   * repeats it. Also the in-app inbox entry.
   */
  alerts: defineTable({
    logicalKey: v.string(),
    type: v.literal("approaching"),
    userId: v.id("users"),
    assignmentId: v.id("assignments"),
    runId: v.id("runs"),
    stopId: v.id("stops"),
    createdAtMs: v.number(),
    predictedArrivalAtMs: v.number(),
    predictionGeneratedAtMs: v.number(),
    sourceEventId: v.string(),
  })
    .index("by_logical_key", ["logicalKey"])
    .index("by_user_created", ["userId", "createdAtMs"]),

  /**
   * The delivery outbox (docs/10 §9): one job per alert and push token,
   * written in the same transaction as the alert, before any send. A worker
   * claims it under a lease; every claim rechecks the run, access,
   * preference, and token.
   */
  notificationJobs: defineTable({
    alertId: v.id("alerts"),
    userId: v.id("users"),
    runId: v.id("runs"),
    pushTokenId: v.id("pushTokens"),
    state: v.union(
      v.literal("pending"),
      v.literal("in_progress"),
      v.literal("provider_accepted"),
      v.literal("retryable_failure"),
      v.literal("permanent_failure"),
      v.literal("expired"),
      v.literal("cancelled"),
    ),
    attempts: v.number(),
    nextAttemptAtMs: v.number(),
    /** After this the alert is useless; never send it. */
    expiresAtMs: v.number(),
    leaseId: v.optional(v.string()),
    leaseExpiresAtMs: v.optional(v.number()),
    /** The token the current or last attempt was sent to. */
    sentToken: v.optional(v.string()),
    endReason: v.optional(v.string()),
    updatedAtMs: v.number(),
  })
    .index("by_state_next", ["state", "nextAttemptAtMs"])
    .index("by_run_state", ["runId", "state"])
    // Convex orders every index by _creationTime last: oldest job per state.
    .index("by_state_created", ["state"]),

  /**
   * Service calendar exceptions (docs/12 §3, §7): one row per date with no
   * service or a late start, and the family-facing notice. Days without a
   * row are normal operating days.
   */
  serviceDays: defineTable({
    serviceDate: v.string(),
    timezone: v.string(),
    status: v.union(v.literal("no_service"), v.literal("late_start")),
    lateStartMinutes: v.optional(v.number()),
    notice: v.string(),
    setByUserId: v.id("users"),
    setAtMs: v.number(),
  }).index("by_date", ["serviceDate"]),

  /**
   * A planned maintenance period for one device (docs/14 §5): when its
   * software may be updated. Cancelled windows are kept for history.
   */
  maintenanceWindows: defineTable({
    deviceId: v.id("devices"),
    startsAtMs: v.number(),
    endsAtMs: v.number(),
    reason: v.string(),
    scheduledByUserId: v.id("users"),
    scheduledAtMs: v.number(),
    cancelledAtMs: v.optional(v.number()),
    cancelledByUserId: v.optional(v.id("users")),
  }).index("by_device", ["deviceId", "startsAtMs"]),

  /** Append-only record of sensitive actions. Never update or delete rows. */
  auditLog: defineTable({
    actor: v.union(
      v.object({ kind: v.literal("user"), userId: v.id("users") }),
      v.object({ kind: v.literal("device"), deviceId: v.id("devices") }),
      v.object({ kind: v.literal("system") }),
      /** A signed-in applicant who has no approved `users` row yet. */
      v.object({ kind: v.literal("identity"), tokenIdentifier: v.string() }),
    ),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.optional(v.string()),
    result: v.union(v.literal("allowed"), v.literal("denied")),
    atMs: v.number(),
    // Optional so rows written before enrollment existed stay valid.
    /** Why, for removals, rejections, corrections. Never a token or an address. */
    reason: v.optional(v.string()),
    /** `staff_web`, `family_app`, or `driver_device`. */
    source: v.optional(v.string()),
    /** Device that carried a driver's action. */
    viaDeviceId: v.optional(v.id("devices")),
    /** Device capture time of a queued action; `atMs` is the receipt time. */
    capturedAtMs: v.optional(v.number()),
  })
    .index("by_resource", ["resourceType", "resourceId"])
    .index("by_at", ["atMs"]),
});
