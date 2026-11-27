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

export default defineSchema({
  /** People. Linked to the identity provider by `tokenIdentifier`. */
  users: defineTable({
    tokenIdentifier: v.string(),
    role,
    displayName: v.string(),
  }).index("by_token", ["tokenIdentifier"]),

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
  })
    .index("by_device_state", ["deviceId", "state"])
    .index("by_route_version_state", ["routeVersionId", "state"])
    .index("by_device_start_request", ["deviceId", "startRequestId"])
    .index("by_device_end_request", ["deviceId", "endRequestId"]),

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
  }).index("by_token_hash", ["tokenHash"]),

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
   * An immutable approved route version: label, bounded path, and stops.
   * `runs.routeVersionId` stores this table's ID as a string.
   */
  routeVersions: defineTable({
    label: v.string(),
    path: v.array(v.object({ latitude: v.number(), longitude: v.number() })),
  }),

  stops: defineTable({
    routeVersionId: v.id("routeVersions"),
    label: v.string(),
    latitude: v.number(),
    longitude: v.number(),
  }).index("by_route_version", ["routeVersionId"]),

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
  }).index("by_student", ["studentId"]),

  /** A school-approved guardian → student link. Never created by a name search. */
  guardianLinks: defineTable({
    guardianUserId: v.id("users"),
    studentId: v.id("students"),
    status: v.union(v.literal("approved"), v.literal("revoked")),
  })
    .index("by_guardian", ["guardianUserId"])
    .index("by_guardian_student", ["guardianUserId", "studentId"]),

  /** Append-only record of sensitive actions. Never update or delete rows. */
  auditLog: defineTable({
    actor: v.union(
      v.object({ kind: v.literal("user"), userId: v.id("users") }),
      v.object({ kind: v.literal("device"), deviceId: v.id("devices") }),
      v.object({ kind: v.literal("system") }),
    ),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.optional(v.string()),
    result: v.union(v.literal("allowed"), v.literal("denied")),
    atMs: v.number(),
  }).index("by_resource", ["resourceType", "resourceId"]),
});
