import { MAX_DELIVERY_ATTEMPTS } from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { getTrackableAssignment } from "./lib/authz";
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

function retryDelayMs(attempts: number): number {
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + 0.2 * Math.random()));
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
async function stopReason(ctx: MutationCtx, job: Doc<"notificationJobs">): Promise<string | null> {
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
    const reason = await stopReason(ctx, job);
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
        await ctx.db.patch(job.pushTokenId, { active: false, updatedAtMs: nowMs });
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
