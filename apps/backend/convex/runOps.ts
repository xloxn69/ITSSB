import {
  MAX_STAFF_REASON_LENGTH,
  RUN_OP_REFUSAL_CODES,
  type RunOpRefusalCode,
  type RunOpResult,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation } from "./_generated/server";
import { audit, denied, staffCaller } from "./lib/staff";
import { boundedText, okResult, refusedResult, staffActionResult } from "./lib/staffResults";

/**
 * Staff run operations (docs/12 §7). A cancelled run stops accepting
 * positions (telemetry accepts only active runs, plus bounded late history
 * of completed ones) and frees its route for another authorized bus. The
 * Pi learns about it when its next end request is answered `RUN_NOT_ACTIVE`.
 */

const result = staffActionResult(RUN_OP_REFUSAL_CODES);
const ok = okResult<RunOpRefusalCode>;
const refused = refusedResult<RunOpRefusalCode>;
const REASON_REQUIRED = () =>
  refused("reason_required", `Say why, in 1 to ${MAX_STAFF_REASON_LENGTH} characters. Families and drivers rely on it.`);

async function activeRun(ctx: MutationCtx, runId: string): Promise<Doc<"runs"> | RunOpResult> {
  const id = ctx.db.normalizeId("runs", runId);
  const run = id ? await ctx.db.get(id) : null;
  if (!run) return refused("not_found", "That run doesn't exist.");
  if (run.state !== "active" && run.state !== "scheduled") {
    return refused("not_active", "This run has already ended.");
  }
  return run;
}

function cancelPatch(user: Doc<"users">, reason: string, nowMs: number) {
  return {
    state: "cancelled" as const,
    endedAtMs: nowMs,
    cancelledAtMs: nowMs,
    cancelledByUserId: user._id,
    cancelReason: reason,
  };
}

/** Cancels a scheduled or active run, recording who and why. */
export const cancelRun = mutation({
  args: { runId: v.string(), reason: v.string() },
  returns: result,
  handler: async (ctx, { runId, reason }): Promise<RunOpResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "runs.cancel", "runs", runId, "denied");
      return denied(caller.reason);
    }
    const text = boundedText(reason, MAX_STAFF_REASON_LENGTH);
    if (!text) return REASON_REQUIRED();
    const run = await activeRun(ctx, runId);
    if (!("_id" in run)) return run;
    await ctx.db.patch(run._id, cancelPatch(caller.user, text, Date.now()));
    await audit(ctx, caller.user, "runs.cancel", "runs", run._id, "allowed");
    return ok();
  },
});

/**
 * Sends a replacement bus (docs/12 §7): cancels the run on the failed bus
 * and names the bus that takes over. The replacement driver then starts the
 * same approved route normally (grant, version and single-active-run checks
 * all apply); that start is linked to this run. A second device never takes
 * over a run just by naming it.
 */
export const replaceDevice = mutation({
  args: { runId: v.string(), replacementDeviceId: v.string(), reason: v.string() },
  returns: result,
  handler: async (ctx, { runId, replacementDeviceId, reason }): Promise<RunOpResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "runs.replaceDevice", "runs", runId, "denied");
      return denied(caller.reason);
    }
    const text = boundedText(reason, MAX_STAFF_REASON_LENGTH);
    if (!text) return REASON_REQUIRED();
    const run = await activeRun(ctx, runId);
    if (!("_id" in run)) return run;
    const deviceId = ctx.db.normalizeId("devices", replacementDeviceId);
    const device = deviceId ? await ctx.db.get(deviceId) : null;
    if (!device || device.revoked) return refused("device_unavailable", "That bus can't be used: it doesn't exist or is revoked.");
    if (device._id === run.deviceId) return refused("same_device", "Choose a different bus from the one on this run.");
    const busy = await ctx.db
      .query("runs")
      .withIndex("by_device_state", (q) => q.eq("deviceId", device._id).eq("state", "active"))
      .first();
    if (busy) return refused("device_busy", "That bus is already on another run.");
    await ctx.db.patch(run._id, { ...cancelPatch(caller.user, text, Date.now()), replacementDeviceId: device._id });
    await audit(ctx, caller.user, "runs.replaceDevice", "runs", run._id, "allowed");
    return ok();
  },
});

/**
 * Called by run start (tripEvents.ts) inside the same transaction: links a
 * new run to the cancelled run it replaces, when staff sent exactly this
 * device to take over this route version on this service date.
 */
export async function linkReplacement(ctx: MutationCtx, newRun: Doc<"runs">): Promise<void> {
  const candidates = await ctx.db
    .query("runs")
    .withIndex("by_replacement_device", (q) => q.eq("replacementDeviceId", newRun.deviceId))
    .order("desc")
    .take(20);
  const replaced = candidates.find(
    (r) =>
      r.state === "cancelled" &&
      r.replacedByRunId === undefined &&
      r.routeVersionId === newRun.routeVersionId &&
      r.serviceDate === newRun.serviceDate,
  );
  if (!replaced) return;
  await ctx.db.patch(replaced._id, { replacedByRunId: newRun._id });
  await ctx.db.patch(newRun._id, { replacesRunId: replaced._id });
}
