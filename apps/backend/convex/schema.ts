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
  }).index("by_credential_hash", ["credentialHash"]),

  /** One execution of an approved route version. */
  runs: defineTable({
    deviceId: v.id("devices"),
    routeVersionId: v.string(),
    state: runState,
    startRequestId: v.string(),
    startedAtMs: v.optional(v.number()),
    endedAtMs: v.optional(v.number()),
  })
    .index("by_device_state", ["deviceId", "state"])
    .index("by_start_request", ["startRequestId"]),

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
    .index("by_run_captured", ["runId", "capturedAtMs"]),

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
  }).index("by_run", ["runId"]),

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
