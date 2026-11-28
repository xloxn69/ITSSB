import {
  ALERT_MAX_INPUT_AGE_MS,
  MAX_DELIVERY_ATTEMPTS,
  NOTIFICATION_JOB_STATES,
  type NotificationJobAge,
  type NotificationJobState,
} from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { getTrackableAssignment } from "./lib/authz";
import { getRunProgress } from "./lib/progressStore";
import { pushResult } from "./lib/push";

/**
 * The notification outbox worker's database side (docs/10 §9–10). The
 * delivery action (pushDelivery.ts) claims a job, sends it, and records the
 * result. Every claim rechecks current state, because scheduled functions do
 * not carry the original caller and the world may have changed since the
 * alert was created.
 */

/** How long one claimed send may take before another worker may reclaim it. */
export const LEASE_MS = 30_000;
/** First retry delay; doubles per attempt, capped, plus up to 20% jitter. */
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 5 * 60_000;
/** Lock Screen text: no student, stop, or route details (docs/10 §9). */
const TITLE = "School bus approaching";
const BODY = "Open ITSSB for the current estimate.";

const OPEN_STATES = ["pending", "retryable_failure", "in_progress"] as const;

/** Window for the by-state job counts in staff diagnostics. */
export const JOB_AGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Rows read per scan; beyond it the counts are marked as lower bounds. */
export const JOB_SCAN_LIMIT = 2000;
const WAITING_STATES = ["pending", "retryable_failure"] as const;

/**
 * How long push jobs wait and how recent ones ended (docs/13 §10). For staff
 * diagnostics only: counts and ages, never a user, token or alert.
 */
export async function jobAgeSummary(ctx: QueryCtx, nowMs: number): Promise<NotificationJobAge> {
  let truncated = false;
  let oldest: number | null = null;
  let waitingCount = 0;
  for (const state of WAITING_STATES) {
    // The oldest by creation, read directly: never limited by the count cap.
    const first = await ctx.db
      .query("notificationJobs")
      .withIndex("by_state_created", (q) => q.eq("state", state))
      .order("asc")
      .first();
    if (first && (oldest === null || first._creationTime < oldest)) oldest = first._creationTime;
    const rows = await ctx.db
      .query("notificationJobs")
      .withIndex("by_state_created", (q) => q.eq("state", state))
      .take(JOB_SCAN_LIMIT + 1);
    if (rows.length > JOB_SCAN_LIMIT) truncated = true;
    waitingCount += Math.min(rows.length, JOB_SCAN_LIMIT);
  }
  const countsByState = Object.fromEntries(NOTIFICATION_JOB_STATES.map((s) => [s, 0])) as Record<
    NotificationJobState,
    number
  >;
  const recent = await ctx.db
    .query("notificationJobs")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", nowMs - JOB_AGE_WINDOW_MS))
    .take(JOB_SCAN_LIMIT + 1);
  if (recent.length > JOB_SCAN_LIMIT) truncated = true;
  for (const job of recent.slice(0, JOB_SCAN_LIMIT)) countsByState[job.state] += 1;
  return {
    oldestWaitingCreatedAtMs: oldest === null ? null : Math.floor(oldest),
    waitingCount,
    windowMs: JOB_AGE_WINDOW_MS,
    countsByState,
    truncated,
  };
}

/** Wait before the next attempt; `random` returns [0, 1) and is injectable for tests. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + 0.2 * random()));
}

async function end(
  ctx: MutationCtx,
  job: Doc<"notificationJobs">,
  state: "cancelled" | "expired" | "permanent_failure" | "provider_accepted",
  nowMs: number,
  endReason?: string,
) {
  await ctx.db.patch(job._id, {
    state,
    updatedAtMs: nowMs,
    leaseId: undefined,
    leaseExpiresAtMs: undefined,
    ...(endReason ? { endReason } : {}),
  });
}

/** Why this job must not be sent now, or null if it still may be. */
async function stopReason(ctx: MutationCtx, job: Doc<"notificationJobs">, nowMs: number): Promise<string | null> {
  const [run, alert, user, token] = await Promise.all([
    ctx.db.get(job.runId),
    ctx.db.get(job.alertId),
    ctx.db.get(job.userId),
    ctx.db.get(job.pushTokenId),
  ]);
  if (!run || run.state !== "active") return "run_not_active";
  if (!alert || !user) return "access_revoked";
  const access = await getTrackableAssignment(ctx, user, alert.assignmentId);
  if (
    !access ||
    access.assignment.stopId !== alert.stopId ||
    access.assignment.routeVersionId !== run.routeVersionId
  ) {
    return "access_revoked";
  }
  // The bus already reached or passed the stop: "approaching" is obsolete.
  const progress = await getRunProgress(ctx, run._id);
  const outcome = progress?.stops.find((o) => o.stopId === alert.stopId);
  if (outcome && (outcome.arrivedAtMs !== null || outcome.departedAtMs !== null)) return "stop_reached";
  // "Approaching" must still be true now: the newest position is fresh and on
  // the route, and a still-valid estimate made from it exists for this stop.
  const live = await ctx.db
    .query("liveState")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .unique();
  if (
    !live ||
    !progress ||
    progress.lastStatus !== "on_route" ||
    progress.lastEventId !== live.eventId ||
    nowMs - live.capturedAtMs >= ALERT_MAX_INPUT_AGE_MS
  ) {
    return "estimate_unavailable";
  }
  const estimate = await ctx.db
    .query("etaPredictions")
    .withIndex("by_run_stop_generated", (q) => q.eq("runId", run._id).eq("stopId", alert.stopId))
    .order("desc")
    .first();
  if (!estimate || estimate.sourceEventId !== live.eventId || nowMs >= estimate.validUntilMs) {
    return "estimate_unavailable";
  }
  const pref = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_user_assignment", (q) => q.eq("userId", user._id).eq("assignmentId", alert.assignmentId))
    .unique();
  if (!pref?.approachingEnabled) return "preference_off";
  if (
    !token ||
    !token.active ||
    !token.token ||
    token.userId !== job.userId ||
    (token.permission !== "authorized" && token.permission !== "provisional")
  ) {
    return "token_inactive";
  }
  return null;
}

/**
 * Claims a due job under a new lease, after rechecking run, access,
 * preference, token, attempts, and expiry. Returns the message to send, or
 * null (not due, already claimed, finished, or stopped).
 */
export const claim = internalMutation({
  args: { jobId: v.id("notificationJobs"), leaseId: v.string(), nowMs: v.number() },
  handler: async (ctx, { jobId, leaseId, nowMs }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    const due =
      ((job.state === "pending" || job.state === "retryable_failure") && job.nextAttemptAtMs <= nowMs) ||
      (job.state === "in_progress" && (job.leaseExpiresAtMs ?? 0) <= nowMs);
    if (!due) return null;
    if (nowMs >= job.expiresAtMs) {
      await end(ctx, job, "expired", nowMs);
      return null;
    }
    if (job.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await end(ctx, job, "permanent_failure", nowMs, "attempts_exhausted");
      return null;
    }
    const reason = await stopReason(ctx, job, nowMs);
    if (reason) {
      await end(ctx, job, "cancelled", nowMs, reason);
      return null;
    }
    const token = (await ctx.db.get(job.pushTokenId))!;
    const alert = (await ctx.db.get(job.alertId))!;
    const attempt = job.attempts + 1;
    await ctx.db.patch(job._id, {
      state: "in_progress",
      attempts: attempt,
      leaseId,
      leaseExpiresAtMs: nowMs + LEASE_MS,
      sentToken: token.token!,
      updatedAtMs: nowMs,
    });
    return {
      jobId: job._id,
      attempt,
      token: token.token!,
      environment: token.environment,
      title: TITLE,
      body: BODY,
      expiresAtMs: job.expiresAtMs,
      // Same for every attempt, so a resend after an ambiguous timeout
      // replaces rather than adds a notification.
      collapseId: alert._id,
      assignmentId: alert.assignmentId,
    };
  },
});

/** Records a send result for the lease that made it; a stale lease is ignored. */
export const record = internalMutation({
  args: { jobId: v.id("notificationJobs"), leaseId: v.string(), result: pushResult, nowMs: v.number() },
  handler: async (ctx, { jobId, leaseId, result, nowMs }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.state !== "in_progress" || job.leaseId !== leaseId) return;
    switch (result.kind) {
      case "accepted":
        await end(ctx, job, "provider_accepted", nowMs);
        return;
      case "permanent_token":
        await end(ctx, job, "permanent_failure", nowMs, result.reason);
        // Only the token that was rejected: the phone may have rotated to a new one since.
        const token = await ctx.db.get(job.pushTokenId);
        if (token && token.token === job.sentToken) {
          await ctx.db.patch(token._id, { active: false, updatedAtMs: nowMs });
        }
        return;
      case "permanent":
        await end(ctx, job, "permanent_failure", nowMs, result.reason);
        return;
      case "retryable": {
        if (job.attempts >= MAX_DELIVERY_ATTEMPTS) {
          await end(ctx, job, "permanent_failure", nowMs, `attempts_exhausted:${result.reason}`);
          return;
        }
        const nextAttemptAtMs = nowMs + retryDelayMs(job.attempts);
        if (nextAttemptAtMs >= job.expiresAtMs) {
          await end(ctx, job, "expired", nowMs, result.reason);
          return;
        }
        await ctx.db.patch(job._id, {
          state: "retryable_failure",
          nextAttemptAtMs,
          leaseId: undefined,
          leaseExpiresAtMs: undefined,
          endReason: result.reason,
          updatedAtMs: nowMs,
        });
        await ctx.scheduler.runAt(nextAttemptAtMs, internal.pushDelivery.deliver, { jobId });
        return;
      }
    }
  },
});

/** Most jobs one sweep touches; the next sweep continues. */
const SWEEP_LIMIT = 100;

/**
 * Recovery sweep (docs/10 §10), run by cron. Expires jobs past their
 * expiry and reschedules only jobs that are due or whose lease ran out. It
 * never touches a job that was accepted, failed permanently, or stopped, so
 * a backend outage never resends old alerts.
 */
export const sweep = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const candidates: Doc<"notificationJobs">[] = [];
    for (const state of ["pending", "retryable_failure"] as const) {
      candidates.push(
        ...(await ctx.db
          .query("notificationJobs")
          .withIndex("by_state_next", (q) => q.eq("state", state).lte("nextAttemptAtMs", nowMs))
          .take(SWEEP_LIMIT)),
      );
    }
    const inProgress = await ctx.db
      .query("notificationJobs")
      .withIndex("by_state_next", (q) => q.eq("state", "in_progress"))
      .take(SWEEP_LIMIT);
    candidates.push(...inProgress.filter((j) => (j.leaseExpiresAtMs ?? 0) <= nowMs));
    for (const job of candidates) {
      if (nowMs >= job.expiresAtMs) await end(ctx, job, "expired", nowMs);
      else await ctx.scheduler.runAfter(0, internal.pushDelivery.deliver, { jobId: job._id });
    }
  },
});

/** Stops every open job for a run that just ended (called from the end-run transaction). */
export async function stopJobsForRun(ctx: MutationCtx, runId: Id<"runs">, nowMs: number): Promise<void> {
  for (const state of OPEN_STATES) {
    const open = await ctx.db
      .query("notificationJobs")
      .withIndex("by_run_state", (q) => q.eq("runId", runId).eq("state", state))
      .collect();
    for (const job of open) await end(ctx, job, "cancelled", nowMs, "run_not_active");
  }
}
