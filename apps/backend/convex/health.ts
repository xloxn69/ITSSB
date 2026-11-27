import { type DeviceHealthReport, validateDeviceHealthReport } from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";

export type HealthOutcome =
  | { ok: true; receivedAtMs: number }
  | { ok: false; code: "INVALID_REQUEST" | "UNSUPPORTED_SCHEMA_VERSION"; message: string };

/**
 * Stores one health report for an authenticated device (docs/08 §7). The
 * device comes from the credential; the body's `runId` is kept for
 * diagnostics only. A report older than the stored one from the same boot
 * (a delayed retry) is accepted but does not replace it.
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
      return { ok: true, receivedAtMs: nowMs };
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
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("deviceHealth", row);
    return { ok: true, receivedAtMs: nowMs };
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
