import { ALERT_MAX_INPUT_AGE_MS } from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { evaluateApproachingPage } from "./lib/alertRules";
import { getRunProgress } from "./lib/progressStore";

const estimate = v.object({
  stopId: v.string(),
  arrivalAtMs: v.number(),
  validUntilMs: v.number(),
  generatedAtMs: v.number(),
});

/**
 * Evaluates approaching alerts for one source position, a page of
 * assignments at a time, continuing itself until every recipient is
 * considered. Scheduled by telemetry ingest so its size never affects an
 * upload. The logical-key check keeps every page idempotent.
 */
export const evaluate = internalMutation({
  args: {
    runId: v.id("runs"),
    sourceEventId: v.string(),
    sourceCapturedAtMs: v.number(),
    estimates: v.array(estimate),
    nowMs: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return;
    // Each page rechecks that its source is still the run's newest matched
    // position and still fresh now, not just when it arrived: a newer
    // off-route fix or a delayed scheduler makes the estimate obsolete.
    const progress = await getRunProgress(ctx, run._id);
    if (!progress || progress.lastEventId !== args.sourceEventId || progress.lastStatus !== "on_route") return;
    if (Date.now() - args.sourceCapturedAtMs >= ALERT_MAX_INPUT_AGE_MS) return;
    const next = await evaluateApproachingPage(
      ctx,
      run,
      { eventId: args.sourceEventId, capturedAtMs: args.sourceCapturedAtMs },
      args.estimates,
      args.nowMs,
      args.cursor,
    );
    if (next !== null) await ctx.scheduler.runAfter(0, internal.alerts.evaluate, { ...args, cursor: next });
  },
});
