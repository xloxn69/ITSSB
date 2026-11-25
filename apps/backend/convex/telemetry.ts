import {
  type EventResult,
  type TelemetryEvent,
  validateTelemetryEvent,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

/** Fields that must match for a re-sent eventId to count as a duplicate. */
const IDENTITY_FIELDS = [
  "bootId",
  "sequence",
  "runSequence",
  "capturedAtMs",
  "latitude",
  "longitude",
] as const satisfies readonly (keyof TelemetryEvent)[];

/**
 * Ingests one batch from an authenticated device and returns one result per
 * submitted event (docs/08 §4). Runs as a single transaction.
 *
 * - Retrying the same eventId returns `duplicate` with the original receipt.
 * - Reusing an eventId for different content is rejected, not overwritten.
 * - Late (older) observations are stored as history but do not replace the
 *   live position (`liveStateApplied: false`).
 */
export const ingestBatch = internalMutation({
  args: {
    deviceId: v.id("devices"),
    events: v.array(v.any()),
    nowMs: v.number(),
  },
  handler: async (ctx, { deviceId, events, nowMs }): Promise<EventResult[]> => {
    const results: EventResult[] = [];
    for (const raw of events) {
      results.push(await ingestOne(ctx, deviceId, raw, nowMs));
    }
    return results;
  },
});

async function ingestOne(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  raw: unknown,
  nowMs: number,
): Promise<EventResult> {
  const eventId =
    typeof raw === "object" && raw !== null && typeof (raw as { eventId?: unknown }).eventId === "string"
      ? (raw as { eventId: string }).eventId
      : "";

  const checked = validateTelemetryEvent(raw, nowMs);
  if (!checked.ok) {
    return { eventId, status: "rejected", code: checked.code, message: checked.message };
  }
  const e = checked.event;

  const existing = await ctx.db
    .query("telemetryEvents")
    .withIndex("by_event_id", (q) => q.eq("eventId", e.eventId))
    .unique();
  if (existing) {
    const same =
      existing.deviceId === deviceId &&
      existing.runId === e.runId &&
      IDENTITY_FIELDS.every((k) => existing[k] === e[k]);
    if (!same) {
      return {
        eventId,
        status: "rejected",
        code: "EVENT_CONTENT_CONFLICT",
        message: "This eventId was already used for different content.",
      };
    }
    const live = await ctx.db
      .query("liveState")
      .withIndex("by_run", (q) => q.eq("runId", existing.runId))
      .unique();
    return {
      eventId,
      status: "duplicate",
      receivedAtMs: existing.receivedAtMs,
      liveStateApplied: live?.eventId === e.eventId,
    };
  }

  // The run must exist, belong to this device, and be active. Don't reveal
  // which of those failed (docs/08 §5: no existence leaks).
  const runId = ctx.db.normalizeId("runs", e.runId);
  const run = runId ? await ctx.db.get(runId) : null;
  if (!run || run.deviceId !== deviceId || run.state !== "active") {
    return {
      eventId,
      status: "rejected",
      code: "RUN_NOT_AUTHORIZED",
      message: "This device is not authorized to report for that run.",
    };
  }

  await ctx.db.insert("telemetryEvents", {
    eventId: e.eventId,
    runId: run._id,
    deviceId,
    bootId: e.bootId,
    sequence: e.sequence,
    runSequence: e.runSequence,
    capturedAtMs: e.capturedAtMs,
    receivedAtMs: nowMs,
    latitude: e.latitude,
    longitude: e.longitude,
    speedMps: e.speedMps,
    headingDegrees: e.headingDegrees,
    horizontalAccuracyM: e.horizontalAccuracyM,
    fixMode: e.fixMode,
  });

  const live = await ctx.db
    .query("liveState")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .unique();
  const snapshot = {
    runId: run._id,
    eventId: e.eventId,
    capturedAtMs: e.capturedAtMs,
    receivedAtMs: nowMs,
    latitude: e.latitude,
    longitude: e.longitude,
    speedMps: e.speedMps,
    headingDegrees: e.headingDegrees,
  };
  let liveStateApplied = false;
  if (!live) {
    await ctx.db.insert("liveState", snapshot);
    liveStateApplied = true;
  } else if (e.capturedAtMs > live.capturedAtMs) {
    await ctx.db.replace(live._id, snapshot);
    liveStateApplied = true;
  }

  return { eventId, status: "accepted", receivedAtMs: nowMs, liveStateApplied };
}
