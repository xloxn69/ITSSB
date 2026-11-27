import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";

/**
 * Raw GPS retention (docs/11 §9, docs/14 §8). The proposed prototype policy
 * keeps raw positions for 30 days after a run ends; the school must approve
 * or change it before real records exist.
 *
 * What is deleted: `telemetryEvents` and the `liveState` row of runs that are
 * `completed` or `cancelled` and ended before the cutoff. What is kept: the
 * run record (state, times, route version, driver), the audit log, and every
 * active run or run without a recorded end. Each batch that deletes something
 * appends a system audit row, so cleanup is observable.
 */
export const RAW_GPS_RETENTION_DAYS = 30;
export const RAW_GPS_RETENTION_MS = RAW_GPS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Rows deleted per transaction, well inside Convex's per-mutation limits. */
export const RETENTION_BATCH = 500;
/** Runs examined per transaction. Prototype scale: a few runs per bus per day. */
const MAX_RUNS_SCANNED = 5000;

export interface PurgeResult {
  deletedTelemetry: number;
  deletedLive: number;
  done: boolean;
}

function expired(run: Doc<"runs">, cutoffMs: number): boolean {
  return (run.state === "completed" || run.state === "cancelled") && run.endedAtMs !== undefined && run.endedAtMs < cutoffMs;
}

async function purge(ctx: MutationCtx, nowMs: number, batchSize: number): Promise<PurgeResult> {
  const cutoffMs = nowMs - RAW_GPS_RETENTION_MS;
  let budget = batchSize;
  let deletedTelemetry = 0;
  let deletedLive = 0;
  let scanned = 0;
  let done = true;
  for await (const run of ctx.db.query("runs")) {
    if (++scanned > MAX_RUNS_SCANNED) {
      done = false;
      break;
    }
    if (!expired(run, cutoffMs)) continue;
    const rows = await ctx.db
      .query("telemetryEvents")
      .withIndex("by_run_captured", (q) => q.eq("runId", run._id))
      .take(budget + 1);
    const batch = rows.slice(0, budget);
    for (const row of batch) await ctx.db.delete(row._id);
    deletedTelemetry += batch.length;
    budget -= batch.length;
    if (rows.length > batch.length) {
      // More history for this run: finish it next batch, live row last.
      done = false;
      break;
    }
    const live = await ctx.db
      .query("liveState")
      .withIndex("by_run", (q) => q.eq("runId", run._id))
      .unique();
    if (live) {
      await ctx.db.delete(live._id);
      deletedLive += 1;
    }
    if (budget === 0) {
      done = false;
      break;
    }
  }
  if (deletedTelemetry + deletedLive > 0) {
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "retention.purgeRawGps",
      resourceType: "retention",
      resourceId: `telemetry:${deletedTelemetry},live:${deletedLive}`,
      result: "allowed",
      atMs: nowMs,
    });
  }
  return { deletedTelemetry, deletedLive, done };
}

/** One bounded batch. */
export const purgeRawGps = internalMutation({
  args: { nowMs: v.number(), batchSize: v.optional(v.number()) },
  handler: (ctx, { nowMs, batchSize }) =>
    purge(ctx, nowMs, Math.max(1, Math.min(batchSize ?? RETENTION_BATCH, RETENTION_BATCH))),
});

/** Daily sweep (crons.ts): batches until done, each in its own transaction. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await purge(ctx, Date.now(), RETENTION_BATCH);
    if (!result.done) await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
    return result;
  },
});
