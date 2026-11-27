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
/** Runs examined per transaction; the next batch resumes after the last one. */
export const RUNS_SCANNED_PER_BATCH = 2000;

export interface PurgeResult {
  deletedTelemetry: number;
  deletedLive: number;
  done: boolean;
  /**
   * Resume point for the next batch: the creation time of the last run that
   * was fully handled. Null when done.
   */
  cursor: number | null;
}

function expired(run: Doc<"runs">, cutoffMs: number): boolean {
  return (
    (run.state === "completed" || run.state === "cancelled") && run.endedAtMs !== undefined && run.endedAtMs < cutoffMs
  );
}

async function purge(
  ctx: MutationCtx,
  nowMs: number,
  batchSize: number,
  scanLimit: number,
  cursor: number | undefined,
): Promise<PurgeResult> {
  const cutoffMs = nowMs - RAW_GPS_RETENTION_MS;
  let budget = batchSize;
  let deletedTelemetry = 0;
  let deletedLive = 0;
  let scanned = 0;
  // Creation time of the last run fully handled; the next batch starts after it.
  let resumeAt: number | null = cursor ?? null;
  let done = true;
  // Runs in creation order, after the cursor: each batch makes progress.
  const runs = ctx.db
    .query("runs")
    .withIndex("by_creation_time", (q) => (cursor === undefined ? q : q.gt("_creationTime", cursor)));
  for await (const run of runs) {
    if (scanned >= scanLimit || budget === 0) {
      done = false;
      break;
    }
    scanned += 1;
    if (expired(run, cutoffMs)) {
      const rows = await ctx.db
        .query("telemetryEvents")
        .withIndex("by_run_captured", (q) => q.eq("runId", run._id))
        .take(budget + 1);
      const batch = rows.slice(0, budget);
      for (const row of batch) await ctx.db.delete(row._id);
      deletedTelemetry += batch.length;
      budget -= batch.length;
      if (rows.length > batch.length) {
        // This run has more history: the next batch resumes at it, not after it.
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
    }
    resumeAt = run._creationTime;
  }
  if (deletedTelemetry + deletedLive > 0) {
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "retention.purgeRawGps",
      resourceType: "retention",
      // Fixed id, so the newest sweep is found by creation time.
      resourceId: "rawGps",
      reason: `telemetry:${deletedTelemetry},live:${deletedLive}`,
      result: "allowed",
      atMs: nowMs,
    });
  }
  return { deletedTelemetry, deletedLive, done, cursor: done ? null : resumeAt };
}

const purgeArgs = {
  nowMs: v.number(),
  batchSize: v.optional(v.number()),
  scanLimit: v.optional(v.number()),
  cursor: v.optional(v.number()),
};
const clamp = (x: number | undefined, dflt: number) => Math.max(1, Math.min(x ?? dflt, dflt));

/** One bounded batch. */
export const purgeRawGps = internalMutation({
  args: purgeArgs,
  handler: (ctx, { nowMs, batchSize, scanLimit, cursor }) =>
    purge(ctx, nowMs, clamp(batchSize, RETENTION_BATCH), clamp(scanLimit, RUNS_SCANNED_PER_BATCH), cursor),
});

/** Daily sweep (crons.ts): batches until done, each its own transaction, resuming at its cursor. */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const result = await purge(ctx, Date.now(), RETENTION_BATCH, RUNS_SCANNED_PER_BATCH, cursor);
    if (!result.done) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, result.cursor === null ? {} : { cursor: result.cursor });
    }
    return result;
  },
});
