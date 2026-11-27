import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { evaluateApproachingPage } from "./lib/alertRules";

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
 * upload. `nowMs` is the ingest time: freshness is judged when the position
 * arrived, and the logical-key check keeps every page idempotent.
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
