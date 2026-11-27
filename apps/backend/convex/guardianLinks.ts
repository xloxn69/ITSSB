import {
  type CreateInvitationResult,
  type DecisionResult,
  type GuardianLinkRequestForReview,
  type GuardianLinkRequestResult,
  type ListGuardianLinkRequestsResult,
  MAX_REASON_LENGTH,
  MAX_STUDENT_NAME_LENGTH,
  type MyGuardianLinkRequestsResult,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, mutation, query } from "./_generated/server";
import { refusedDecision } from "./enrollment";
import { approvedFamilyUser, boundedText, callerIdentity, isRequestId, tokenProblem } from "./lib/family";
import { audit, denied, insertAudit, staffCaller } from "./lib/staff";
import { generateToken, resolveToken, tokenHash } from "./lib/tokens";

/**
 * Guardian linking (docs/09 §5). The school gives a guardian a single-use
 * invitation for one student. Redeeming it makes a pending request that
 * reveals nothing about the student; staff approval creates the link.
 * Knowing a student's name grants nothing: no function takes one.
 */

const now = () => Date.now();

function submitted(row: Doc<"guardianLinkRequests">): GuardianLinkRequestResult {
  return { schemaVersion: SCHEMA_VERSION, status: "submitted", serverNowMs: now(), linkRequestId: row._id, requestStatus: row.status };
}

export const request = mutation({
  args: { requestId: v.string(), token: v.string(), guardianName: v.string() },
  handler: async (ctx, args): Promise<GuardianLinkRequestResult> => {
    const guardian = await callerIdentity(ctx);
    if (!guardian) return denied("unauthenticated");
    const guardianName = boundedText(args.guardianName, MAX_STUDENT_NAME_LENGTH);
    if (!isRequestId(args.requestId) || !guardianName) {
      return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code: "invalid_details", message: "Enter your name, then try again." };
    }

    const prior = await ctx.db
      .query("guardianLinkRequests")
      .withIndex("by_guardian_request", (q) => q.eq("guardianTokenIdentifier", guardian).eq("requestId", args.requestId))
      .unique();
    if (prior) {
      const invitation = await ctx.db.get(prior.invitationId);
      if (invitation?.tokenHash !== (await tokenHash(args.token)) || prior.guardianName !== guardianName) {
        return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code: "request_id_conflict", message: "This request was already sent with different details." };
      }
      return submitted(prior);
    }

    const resolved = await resolveToken(ctx, args.token, "guardian_link", now());
    if (!resolved.ok) return tokenProblem(resolved.problem);
    const invitation = resolved.token;
    if (invitation.usedByTokenIdentifier !== undefined) {
      if (invitation.usedByTokenIdentifier !== guardian) return tokenProblem("already_used");
      // The same person with a new requestId: return their existing request.
      const mine = await ctx.db
        .query("guardianLinkRequests")
        .withIndex("by_guardian", (q) => q.eq("guardianTokenIdentifier", guardian))
        .collect();
      const existing = mine.find((r) => r.invitationId === invitation._id);
      if (existing) return submitted(existing);
      return tokenProblem("already_used");
    }
    const student = invitation.studentId ? await ctx.db.get(invitation.studentId) : null;
    if (!student) return tokenProblem("unavailable");

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", guardian))
      .unique();
    if (user) {
      const link = await ctx.db
        .query("guardianLinks")
        .withIndex("by_guardian_student", (q) => q.eq("guardianUserId", user._id).eq("studentId", student._id))
        .first();
      if (link?.status === "approved") {
        return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code: "already_linked", message: "You're already linked to this student." };
      }
    }

    const t = now();
    const id = await ctx.db.insert("guardianLinkRequests", {
      guardianTokenIdentifier: guardian,
      requestId: args.requestId,
      invitationId: invitation._id,
      studentId: student._id,
      guardianName,
      status: "pending",
      submittedAtMs: t,
    });
    await ctx.db.patch(invitation._id, { usedAtMs: t, usedByTokenIdentifier: guardian });
    await insertAudit(ctx, { kind: "identity", tokenIdentifier: guardian }, "guardianLink.request", "guardianLinkRequests", id, "allowed", {
      source: "family_app",
    });
    return { schemaVersion: SCHEMA_VERSION, status: "submitted", serverNowMs: t, linkRequestId: id, requestStatus: "pending" };
  },
});

export const myRequests = query({
  args: {},
  handler: async (ctx): Promise<MyGuardianLinkRequestsResult> => {
    const guardian = await callerIdentity(ctx);
    if (!guardian) return denied("unauthenticated");
    const rows = await ctx.db
      .query("guardianLinkRequests")
      .withIndex("by_guardian", (q) => q.eq("guardianTokenIdentifier", guardian))
      .order("desc")
      .take(50);
    const requests = [];
    for (const r of rows) {
      // The student's name is shown only while the link is approved.
      const link = r.guardianLinkId ? await ctx.db.get(r.guardianLinkId) : null;
      const student = r.status === "approved" && link?.status === "approved" ? await ctx.db.get(r.studentId) : null;
      requests.push({
        linkRequestId: r._id as string,
        status: r.status,
        submittedAtMs: r.submittedAtMs,
        decidedAtMs: r.reviewedAtMs ?? null,
        decisionReason: r.status === "rejected" ? (r.decisionReason ?? null) : null,
        studentDisplayName: student?.displayName ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), requests };
  },
});

// MARK: Staff

export const createInvitation = action({
  args: { studentId: v.string(), ttlMs: v.number() },
  handler: async (ctx, { studentId, ttlMs }): Promise<CreateInvitationResult> => {
    const token = generateToken();
    const result: CreateInvitationResult = await ctx.runMutation(internal.enrollment.insertInvitation, {
      tokenHash: (await tokenHash(token)) as string,
      purpose: "guardian_link",
      scopeId: studentId,
      ttlMs,
    });
    return result.status === "created" ? { ...result, token } : result;
  },
});

export const listRequests = query({
  args: {},
  handler: async (ctx): Promise<ListGuardianLinkRequestsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const rows = [
      ...(await ctx.db.query("guardianLinkRequests").withIndex("by_status", (q) => q.eq("status", "pending")).take(200)),
      ...(await ctx.db.query("guardianLinkRequests").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(50)),
      ...(await ctx.db.query("guardianLinkRequests").withIndex("by_status", (q) => q.eq("status", "rejected")).order("desc").take(50)),
    ];
    const requests: GuardianLinkRequestForReview[] = [];
    for (const r of rows) {
      const student = await ctx.db.get(r.studentId);
      const reviewer = r.reviewedByUserId ? await ctx.db.get(r.reviewedByUserId) : null;
      requests.push({
        linkRequestId: r._id,
        guardianName: r.guardianName,
        studentId: r.studentId,
        studentDisplayName: student?.displayName ?? "Student",
        status: r.status,
        submittedAtMs: r.submittedAtMs,
        decidedAtMs: r.reviewedAtMs ?? null,
        reviewerName: reviewer?.displayName ?? null,
        decisionReason: r.decisionReason ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), requests };
  },
});

export const approve = mutation({
  args: { linkRequestId: v.string() },
  handler: async (ctx, { linkRequestId }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "guardianLink.approve", "guardianLinkRequests", linkRequestId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("guardianLinkRequests", linkRequestId);
    const r = id ? await ctx.db.get(id) : null;
    if (!r) return refusedDecision("not_found", "That request doesn't exist.");
    if (r.status !== "pending") return refusedDecision("already_decided", "This request has already been decided.");
    if (!(await ctx.db.get(r.studentId))) return refusedDecision("not_found", "That student no longer exists.");
    const account = await approvedFamilyUser(ctx, r.guardianTokenIdentifier, r.guardianName);
    if (!account) return refusedDecision("account_conflict", "This sign-in belongs to a staff or driver account.");

    const t = now();
    // One row per guardian and student, so the access check's `.first()`
    // always sees the current status. A revoked link is re-approved in place;
    // its history stays in the audit log.
    const existing = await ctx.db
      .query("guardianLinks")
      .withIndex("by_guardian_student", (q) => q.eq("guardianUserId", account._id).eq("studentId", r.studentId))
      .first();
    const approval = { status: "approved" as const, approvedByUserId: caller.user._id, approvedAtMs: t };
    let guardianLinkId = existing?._id;
    if (existing) {
      await ctx.db.patch(existing._id, { ...approval, revokedAtMs: undefined, revokedByUserId: undefined, revokeReason: undefined });
    } else {
      guardianLinkId = await ctx.db.insert("guardianLinks", { guardianUserId: account._id, studentId: r.studentId, ...approval });
    }
    await ctx.db.patch(r._id, { status: "approved", reviewedByUserId: caller.user._id, reviewedAtMs: t, guardianLinkId });
    await audit(ctx, caller.user, "guardianLink.approve", "guardianLinkRequests", r._id, "allowed", { source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "approved", serverNowMs: t, assignmentId: null, guardianLinkId: guardianLinkId ?? null };
  },
});

export const reject = mutation({
  args: { linkRequestId: v.string(), reason: v.string() },
  handler: async (ctx, { linkRequestId, reason }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "guardianLink.reject", "guardianLinkRequests", linkRequestId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("guardianLinkRequests", linkRequestId);
    const r = id ? await ctx.db.get(id) : null;
    if (!r) return refusedDecision("not_found", "That request doesn't exist.");
    if (r.status !== "pending") return refusedDecision("already_decided", "This request has already been decided.");
    const why = boundedText(reason, MAX_REASON_LENGTH);
    if (!why) return refusedDecision("reason_required", "Give the guardian a reason.");
    await ctx.db.patch(r._id, { status: "rejected", reviewedByUserId: caller.user._id, reviewedAtMs: now(), decisionReason: why });
    // The free-text reason stays on the private request.
    await audit(ctx, caller.user, "guardianLink.reject", "guardianLinkRequests", r._id, "allowed", { source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "rejected", serverNowMs: now() };
  },
});

/** Revokes a guardian link. Future tracking reads stop at once; history is kept. Idempotent. */
export const revoke = mutation({
  args: { guardianLinkId: v.string(), reason: v.string() },
  handler: async (ctx, { guardianLinkId, reason }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "guardianLink.revoke", "guardianLinks", guardianLinkId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("guardianLinks", guardianLinkId);
    const link = id ? await ctx.db.get(id) : null;
    if (!link) return refusedDecision("not_found", "That link doesn't exist.");
    const why = boundedText(reason, MAX_REASON_LENGTH);
    if (!why) return refusedDecision("reason_required", "Give a reason for removing this link.");
    if (link.status !== "revoked") {
      await ctx.db.patch(link._id, { status: "revoked", revokedAtMs: now(), revokedByUserId: caller.user._id, revokeReason: why });
      await audit(ctx, caller.user, "guardianLink.revoke", "guardianLinks", link._id, "allowed", { reason: why, source: "staff_web" });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "revoked", serverNowMs: now() };
  },
});
