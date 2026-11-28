import {
  DEVICE_HEALTH_METRIC_KEYS,
  type DeviceHealthReport,
  type DeviceRunStatus,
  POSITION_STALE_AFTER_MS,
  validateDeviceHealthReport,
} from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { cancelledAt } from "./telemetry";

export type HealthOutcome =
  | { ok: true; receivedAtMs: number; run?: DeviceRunStatus }
  | { ok: false; code: "INVALID_REQUEST" | "UNSUPPORTED_SCHEMA_VERSION"; message: string };

/**
 * Stores one health report for an authenticated device (docs/08 §7). The
 * device comes from the credential; the body's `runId` is kept for
 * diagnostics only. A report older than the stored one from the same boot
 * (a delayed report, or the Pi clock stepping back) still counts as contact
 * but does not replace the stored status.
 *
 * Each stored status expires: if no later report arrives within
 * POSITION_STALE_AFTER_MS, `expire` marks it `unknown`, so no client
 * (including older apps without a contact-age check) keeps showing
 * "connected, no GPS" for a bus that went silent.
 */
export const record = internalMutation({
  args: { deviceId: v.id("devices"), report: v.any(), nowMs: v.number() },
  handler: async (ctx, { deviceId, report, nowMs }): Promise<HealthOutcome> => {
    // Recheck inside the committing transaction (docs/07 §6).
    const device = await ctx.db.get(deviceId);
    if (!device || device.revoked) throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
    const checked = validateDeviceHealthReport(report, nowMs);
    if (!checked.ok) return checked;
    const r: DeviceHealthReport = checked.report;

    const existing = await ctx.db
      .query("deviceHealth")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (existing && existing.bootId === r.bootId && r.capturedAtMs <= existing.capturedAtMs) {
      await ctx.db.patch(existing._id, { receivedAtMs: nowMs });
      await ctx.scheduler.runAfter(POSITION_STALE_AFTER_MS, internal.health.expire, { deviceId, receivedAtMs: nowMs });
      return { ok: true, receivedAtMs: nowMs, ...(await reportedRun(ctx, deviceId, r.runId)) };
    }
    const row = {
      deviceId,
      bootId: r.bootId,
      capturedAtMs: r.capturedAtMs,
      receivedAtMs: nowMs,
      appVersion: r.appVersion,
      reportedRunId: r.runId,
      gpsStatus: r.gpsStatus,
      lastValidFixAtMs: r.lastValidFixAtMs,
      pendingCount: r.pendingCount,
      oldestPendingCapturedAtMs: r.oldestPendingCapturedAtMs,
      statusReceivedAtMs: nowMs,
      // Only what this report carried: an older Pi's report clears them, so
      // staff never read a previous boot's measurements as current.
      ...(Object.fromEntries(
        DEVICE_HEALTH_METRIC_KEYS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]),
      ) as Partial<Pick<Doc<"deviceHealth">, (typeof DEVICE_HEALTH_METRIC_KEYS)[number]>>),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("deviceHealth", row);
    await ctx.scheduler.runAfter(POSITION_STALE_AFTER_MS, internal.health.expire, { deviceId, receivedAtMs: nowMs });
    return { ok: true, receivedAtMs: nowMs, ...(await reportedRun(ctx, deviceId, r.runId)) };
  },
});

/**
 * The server's state of the run the report named, only if it is this
 * device's own run: a Pi with no GPS fix uploads no telemetry, so this is how
 * it learns staff cancelled its run (docs/13 D14). Another device's run, or
 * an unknown one, gets nothing (no existence leak).
 */
async function reportedRun(
  ctx: MutationCtx,
  deviceId: Id<"devices">,
  reportedRunId: string | null,
): Promise<{ run?: DeviceRunStatus }> {
  const id = reportedRunId ? ctx.db.normalizeId("runs", reportedRunId) : null;
  const run = id ? await ctx.db.get(id) : null;
  if (!run || run.deviceId !== deviceId) return {};
  return {
    run: {
      runId: run._id,
      state: run.state,
      cancelledAtMs: run.state === "cancelled" ? cancelledAt(run) : null,
    },
  };
}

/** Marks a device's status `unknown` if nothing newer arrived since `receivedAtMs`. */
export const expire = internalMutation({
  args: { deviceId: v.id("devices"), receivedAtMs: v.number() },
  handler: async (ctx, { deviceId, receivedAtMs }) => {
    const health = await ctx.db
      .query("deviceHealth")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (health && health.receivedAtMs === receivedAtMs && health.gpsStatus !== "unknown") {
      await ctx.db.patch(health._id, { gpsStatus: "unknown" });
    }
  },
});

/**
 * The device's latest health, if it was received during this run. Health
 * from before the run started says nothing about it.
 */
export async function healthForRun(ctx: QueryCtx, run: Doc<"runs">): Promise<Doc<"deviceHealth"> | null> {
  const deviceId: Id<"devices"> = run.deviceId;
  const health = await ctx.db
    .query("deviceHealth")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
  return health && health.receivedAtMs >= (run.startedAtMs ?? run._creationTime) ? health : null;
}
