import { ALERT_MAX_INPUT_AGE_MS, APPROACHING_MINUTES_DEFAULT } from "@itssb/contracts";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Server-side approaching-alert rule (docs/10 §8). Telemetry ingest only
 * schedules it (`alerts:evaluate`), so a route with many recipients can never
 * make a telemetry upload fail; it runs a page of assignments at a time.
 *
 * "Notify me at 5 minutes" means once, when a reliable, fresh estimate first
 * enters the condition, not on every update. The logical key (recipient,
 * run, stop, type) is checked before insert inside the same transaction, so
 * an estimate wandering across the threshold creates exactly one alert.
 */

export interface StopEstimate {
  stopId: string;
  arrivalAtMs: number;
  validUntilMs: number;
  generatedAtMs: number;
}

export function alertKey(userId: Id<"users">, runId: Id<"runs">, stopId: string, type: "approaching") {
  return `${userId}:${runId}:${stopId}:${type}`;
}

/** Approved recipients of an assignment: the student's own account and approved guardians. */
async function recipients(ctx: MutationCtx, assignment: Doc<"assignments">): Promise<Id<"users">[]> {
  const student = await ctx.db.get(assignment.studentId);
  if (!student) return [];
  const links = await ctx.db
    .query("guardianLinks")
    .withIndex("by_student", (q) => q.eq("studentId", student._id))
    .collect();
  const users = links.filter((l) => l.status === "approved").map((l) => l.guardianUserId);
  if (student.userId) users.unshift(student.userId);
  return [...new Set(users)];
}

/** Assignments evaluated per scheduled page. */
export const ASSIGNMENTS_PER_PAGE = 20;

/** Whether this source position may create alerts at all. */
export function alertable(source: { capturedAtMs: number }, estimates: StopEstimate[], nowMs: number) {
  // Stale input never alerts, even if an estimate exists for evaluation.
  if (nowMs - source.capturedAtMs >= ALERT_MAX_INPUT_AGE_MS) return [];
  return estimates.filter((e) => nowMs < e.validUntilMs);
}

/** One page of assignments; returns the cursor to continue from, or null when done. */
export async function evaluateApproachingPage(
  ctx: MutationCtx,
  run: Doc<"runs">,
  source: { eventId: string; capturedAtMs: number },
  estimates: StopEstimate[],
  nowMs: number,
  cursor: string | null,
): Promise<string | null> {
  if (run.state !== "active") return null;
  const byStop = new Map(alertable(source, estimates, nowMs).map((e) => [e.stopId, e]));
  if (byStop.size === 0) return null;

  const routeVersionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
  if (!routeVersionId) return null;
  const page = await ctx.db
    .query("assignments")
    .withIndex("by_route_version", (q) => q.eq("routeVersionId", routeVersionId))
    .paginate({ numItems: ASSIGNMENTS_PER_PAGE, cursor });

  for (const assignment of page.page) {
    if (assignment.status !== "approved") continue;
    const estimate = byStop.get(assignment.stopId);
    if (!estimate) continue;
    for (const userId of await recipients(ctx, assignment)) {
      const pref = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_user_assignment", (q) => q.eq("userId", userId).eq("assignmentId", assignment._id))
        .unique();
      if (!pref?.approachingEnabled) continue;
      const minutes = pref.approachingMinutes ?? APPROACHING_MINUTES_DEFAULT;
      if (estimate.arrivalAtMs - nowMs > minutes * 60_000) continue;

      const logicalKey = alertKey(userId, run._id, assignment.stopId, "approaching");
      const existing = await ctx.db
        .query("alerts")
        .withIndex("by_logical_key", (q) => q.eq("logicalKey", logicalKey))
        .first();
      if (existing) continue;
      const alertId = await ctx.db.insert("alerts", {
        logicalKey,
        type: "approaching",
        userId,
        assignmentId: assignment._id,
        runId: run._id,
        stopId: assignment.stopId,
        createdAtMs: nowMs,
        predictedArrivalAtMs: estimate.arrivalAtMs,
        predictionGeneratedAtMs: estimate.generatedAtMs,
        sourceEventId: source.eventId,
      });
      // Outbox first: a job per active token, written before any send.
      const tokens = await ctx.db
        .query("pushTokens")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      // Nothing to send once the bus is predicted to be there; the inbox keeps the alert.
      if (estimate.arrivalAtMs <= nowMs) continue;
      for (const token of tokens) {
        if (!token.active || !token.token) continue;
        if (token.permission !== "authorized" && token.permission !== "provisional") continue;
        const jobId = await ctx.db.insert("notificationJobs", {
          alertId,
          userId,
          runId: run._id,
          pushTokenId: token._id,
          state: "pending",
          attempts: 0,
          nextAttemptAtMs: nowMs,
          // An approaching alert is useless once the bus is predicted to be there.
          expiresAtMs: estimate.arrivalAtMs,
          updatedAtMs: nowMs,
        });
        await ctx.scheduler.runAfter(0, internal.pushDelivery.deliver, { jobId });
      }
    }
  }
  return page.isDone ? null : page.continueCursor;
}
