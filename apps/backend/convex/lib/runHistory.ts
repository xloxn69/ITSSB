import type { LinkedRun, RunHistoryEvent } from "@itssb/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * A run's history for staff (docs/08 §11, docs/13 D14), oldest first: who
 * started it on which bus, who cancelled it and why, the run it replaced or
 * that replaced it, how it ended, and the students removed from its route
 * while it was going. Staff-only: the caller must already be checked.
 */
export async function runHistory(ctx: QueryCtx, run: Doc<"runs">): Promise<RunHistoryEvent[]> {
  const names = new Map<Id<"users">, string | null>();
  const nameOf = async (id: Id<"users"> | undefined) => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.displayName ?? null);
    return names.get(id) ?? null;
  };
  const busOf = async (id: Id<"devices"> | undefined) => (id ? ((await ctx.db.get(id))?.busLabel ?? null) : null);
  const linked = async (id: Id<"runs">): Promise<{ run: LinkedRun; startedAtMs: number | null } | null> => {
    const other = await ctx.db.get(id);
    if (!other) return null;
    return { run: { runId: other._id, busLabel: await busOf(other.deviceId), state: other.state }, startedAtMs: other.startedAtMs ?? null };
  };

  const events: RunHistoryEvent[] = [];
  const bus = await busOf(run.deviceId);
  if (run.startedAtMs !== undefined) {
    events.push({ kind: "started", atMs: run.startedAtMs, driverName: await nameOf(run.driverUserId), busLabel: bus });
  }
  if (run.replacesRunId) {
    const prior = await linked(run.replacesRunId);
    if (prior) events.push({ kind: "replaces", atMs: run.startedAtMs ?? run._creationTime, run: prior.run });
  }
  if (run.state === "cancelled" && run.cancelledAtMs !== undefined) {
    events.push({
      kind: "cancelled",
      atMs: run.cancelledAtMs,
      byName: await nameOf(run.cancelledByUserId),
      reason: run.cancelReason ?? null,
      replacementBusLabel: await busOf(run.replacementDeviceId),
    });
  }
  if (run.replacedByRunId) {
    const next = await linked(run.replacedByRunId);
    if (next) events.push({ kind: "replaced_by", atMs: next.startedAtMs ?? run.cancelledAtMs ?? run._creationTime, run: next.run });
  }
  if (run.state === "completed" && run.endedAtMs !== undefined) {
    events.push({ kind: "ended", atMs: run.endedAtMs, driverName: await nameOf(run.endedByDriverUserId), busLabel: bus });
  }
  events.push(...(await removalsDuring(ctx, run, nameOf)));
  // Stable: same-millisecond events keep the order above (a start before what follows it).
  return events.toSorted((a, b) => a.atMs - b.atMs);
}

/**
 * Removals from this run's route version made while the run was going,
 * from the audit log. A driver's removal queued offline counts by when it
 * was made on the bus, not when it reached the server.
 */
async function removalsDuring(
  ctx: QueryCtx,
  run: Doc<"runs">,
  nameOf: (id: Id<"users"> | undefined) => Promise<string | null>,
): Promise<RunHistoryEvent[]> {
  const versionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
  if (!versionId) return [];
  const from = run.startedAtMs ?? run._creationTime;
  const until = run.endedAtMs ?? Number.POSITIVE_INFINITY;
  const assignments = await ctx.db
    .query("assignments")
    .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
    .collect();
  const out: RunHistoryEvent[] = [];
  for (const a of assignments) {
    const rows = await ctx.db
      .query("auditLog")
      .withIndex("by_resource", (q) => q.eq("resourceType", "assignments").eq("resourceId", a._id))
      .collect();
    for (const row of rows) {
      if (row.action !== "assignment.remove" || row.result !== "allowed") continue;
      const madeAtMs = row.capturedAtMs ?? row.atMs;
      if (madeAtMs < from || madeAtMs > until) continue;
      const student = await ctx.db.get(a.studentId);
      out.push({
        kind: "assignment_removed",
        atMs: madeAtMs,
        receivedAtMs: row.atMs,
        studentDisplayName: student?.displayName ?? "Student",
        byName: row.actor.kind === "user" ? await nameOf(row.actor.userId) : null,
        reason: row.reason ?? null,
        source: row.source === "staff_web" || row.source === "driver_device" ? row.source : null,
      });
    }
  }
  return out;
}
