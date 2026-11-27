import {
  type CreateInvitationResult,
  type DecisionRefusalCode,
  type DecisionResult,
  type EligibleStop,
  type EnrollmentRefusalCode,
  type EnrollmentRequestForReview,
  type EnrollmentRequestResult,
  type InvitationSummary,
  type ListEnrollmentRequestsResult,
  type ListInvitationsResult,
  MAX_ADDRESS_LENGTH,
  MAX_ENROLLMENT_INVITATION_TTL_MS,
  MAX_GUARDIAN_INVITATION_TTL_MS,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_STUDENT_NAME_LENGTH,
  MIN_INVITATION_TTL_MS,
  type MyEnrollmentRequestsResult,
  type PreviewInvitationResult,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { approvedFamilyUser, boundedText, callerIdentity, isRequestId, stopLabel, tokenProblem } from "./lib/family";
import { audit, denied, insertAudit, staffCaller } from "./lib/staff";
import { generateToken, resolveToken, tokenHash } from "./lib/tokens";

/**
 * Route enrollment (docs/09 §4, docs/08 §9). A family scans or types a
 * route invitation, enters the student's name and address privately,
 * chooses one of the route's approved stops (or none, for manual review),
 * and submits once. Staff approve or reject. Only approval creates the
 * account link, student, and assignment, so a pending applicant can track
 * nothing.
 */

const now = () => Date.now();

function refusedRequest(code: EnrollmentRefusalCode, message: string): EnrollmentRequestResult {
  return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code, message };
}

export function refusedDecision(code: DecisionRefusalCode, message: string): DecisionResult {
  return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code, message };
}

/** The approved stops of a route's current version, in travel order. */
export async function eligibleStops(ctx: QueryCtx, versionId: Id<"routeVersions">): Promise<EligibleStop[]> {
  const stops = await ctx.db
    .query("stops")
    .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
    .collect();
  return stops
    .map((s, i) => ({ stopId: s._id as string, label: s.label, sequence: s.sequence ?? i, instructions: s.instructions ?? null }))
    .sort((a, b) => a.sequence - b.sequence);
}

/** A stop only if it belongs to `versionId`; any other ID, valid or not, is ineligible. */
async function stopInVersion(ctx: QueryCtx, rawStopId: string, versionId: Id<"routeVersions">) {
  const id = ctx.db.normalizeId("stops", rawStopId);
  const stop = id ? await ctx.db.get(id) : null;
  return stop && stop.routeVersionId === versionId ? stop : null;
}

export const previewInvitation = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<PreviewInvitationResult> => {
    if (!(await callerIdentity(ctx))) return denied("unauthenticated");
    const resolved = await resolveToken(ctx, token, "route_enrollment", now());
    if (!resolved.ok) return tokenProblem(resolved.problem);
    const route = resolved.token.routeId ? await ctx.db.get(resolved.token.routeId) : null;
    if (!route?.currentVersionId) return tokenProblem("unavailable");
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: now(),
      routeLabel: route.label,
      direction: route.direction,
      expiresAtMs: resolved.token.expiresAtMs,
      stops: await eligibleStops(ctx, route.currentVersionId),
    };
  },
});

export const request = mutation({
  args: {
    requestId: v.string(),
    token: v.string(),
    studentName: v.string(),
    address: v.string(),
    stopId: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<EnrollmentRequestResult> => {
    const applicant = await callerIdentity(ctx);
    if (!applicant) return denied("unauthenticated");

    const studentName = boundedText(args.studentName, MAX_STUDENT_NAME_LENGTH);
    const address = boundedText(args.address, MAX_ADDRESS_LENGTH);
    const note = args.note === null || args.note.trim() === "" ? null : boundedText(args.note, MAX_NOTE_LENGTH);
    if (!isRequestId(args.requestId) || !studentName || !address || (args.note !== null && args.note.trim() !== "" && !note)) {
      return refusedRequest("invalid_details", "Check the student's name and address, then try again.");
    }

    // A retry of an earlier submission returns the stored result, even if
    // the invitation has expired since; the same requestId with different
    // content is a conflict.
    const prior = await ctx.db
      .query("enrollmentRequests")
      .withIndex("by_applicant_request", (q) => q.eq("applicantTokenIdentifier", applicant).eq("requestId", args.requestId))
      .unique();
    if (prior) {
      const invitation = await ctx.db.get(prior.invitationId);
      const same =
        invitation?.tokenHash === (await tokenHash(args.token)) &&
        prior.studentName === studentName &&
        prior.address === address &&
        (prior.note ?? null) === note &&
        ((prior.requestedStopId as string | undefined) ?? null) === args.stopId;
      if (!same) return refusedRequest("request_id_conflict", "This request was already sent with different details.");
      return { schemaVersion: SCHEMA_VERSION, status: "submitted", serverNowMs: now(), enrollmentRequestId: prior._id, requestStatus: prior.status };
    }

    const resolved = await resolveToken(ctx, args.token, "route_enrollment", now());
    if (!resolved.ok) return tokenProblem(resolved.problem);
    const route = resolved.token.routeId ? await ctx.db.get(resolved.token.routeId) : null;
    if (!route?.currentVersionId) return tokenProblem("unavailable");
    const versionId = route.currentVersionId;

    let stopId: Id<"stops"> | undefined;
    if (args.stopId !== null) {
      const stop = await stopInVersion(ctx, args.stopId, versionId);
      if (!stop) return refusedRequest("stop_not_eligible", "That stop isn't one of this route's approved stops.");
      stopId = stop._id;
    }

    if (await isEnrolledOn(ctx, applicant, versionId)) {
      return refusedRequest("already_enrolled", "This account is already approved for this route.");
    }
    const mine = await ctx.db
      .query("enrollmentRequests")
      .withIndex("by_applicant", (q) => q.eq("applicantTokenIdentifier", applicant))
      .collect();
    if (mine.some((r) => r.status === "pending" && r.routeId === route._id)) {
      return refusedRequest("already_requested", "A request for this route is already waiting for the school.");
    }

    const id = await ctx.db.insert("enrollmentRequests", {
      applicantTokenIdentifier: applicant,
      requestId: args.requestId,
      invitationId: resolved.token._id,
      routeId: route._id,
      routeVersionId: versionId,
      studentName,
      address,
      ...(note ? { note } : {}),
      ...(stopId ? { requestedStopId: stopId } : {}),
      status: "pending",
      submittedAtMs: now(),
    });
    await insertAudit(ctx, { kind: "identity", tokenIdentifier: applicant }, "enrollment.request", "enrollmentRequests", id, "allowed", {
      source: "family_app",
    });
    return { schemaVersion: SCHEMA_VERSION, status: "submitted", serverNowMs: now(), enrollmentRequestId: id, requestStatus: "pending" };
  },
});

async function isEnrolledOn(ctx: QueryCtx, tokenIdentifier: string, versionId: Id<"routeVersions">) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  if (!user) return false;
  const students = await ctx.db
    .query("students")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const student of students) {
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .collect();
    if (assignments.some((a) => a.status === "approved" && a.routeVersionId === versionId)) return true;
  }
  return false;
}

export const myRequests = query({
  args: {},
  handler: async (ctx): Promise<MyEnrollmentRequestsResult> => {
    const applicant = await callerIdentity(ctx);
    if (!applicant) return denied("unauthenticated");
    const rows = await ctx.db
      .query("enrollmentRequests")
      .withIndex("by_applicant", (q) => q.eq("applicantTokenIdentifier", applicant))
      .order("desc")
      .take(50);
    const requests = [];
    for (const r of rows) {
      const route = await ctx.db.get(r.routeId);
      requests.push({
        enrollmentRequestId: r._id as string,
        routeLabel: route?.label ?? "Route",
        direction: route?.direction ?? "to_school",
        studentName: r.studentName,
        requestedStopLabel: await stopLabel(ctx, r.requestedStopId),
        status: r.status,
        submittedAtMs: r.submittedAtMs,
        decidedAtMs: r.reviewedAtMs ?? null,
        decisionReason: r.status === "rejected" ? (r.decisionReason ?? null) : null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), requests };
  },
});

// MARK: Staff

export const listRequests = query({
  args: {},
  handler: async (ctx): Promise<ListEnrollmentRequestsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const pending = await ctx.db
      .query("enrollmentRequests")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(200);
    const decided = [
      ...(await ctx.db.query("enrollmentRequests").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(50)),
      ...(await ctx.db.query("enrollmentRequests").withIndex("by_status", (q) => q.eq("status", "rejected")).order("desc").take(50)),
    ].sort((a, b) => (b.reviewedAtMs ?? 0) - (a.reviewedAtMs ?? 0));
    const requests: EnrollmentRequestForReview[] = [];
    for (const r of [...pending, ...decided]) {
      const route = await ctx.db.get(r.routeId);
      const reviewer = r.reviewedByUserId ? await ctx.db.get(r.reviewedByUserId) : null;
      requests.push({
        enrollmentRequestId: r._id,
        routeId: r.routeId,
        routeLabel: route?.label ?? "Route",
        direction: route?.direction ?? "to_school",
        studentName: r.studentName,
        address: r.address,
        note: r.note ?? null,
        requestedStopId: r.requestedStopId ?? null,
        requestedStopLabel: await stopLabel(ctx, r.requestedStopId),
        eligibleStops: route?.currentVersionId ? await eligibleStops(ctx, route.currentVersionId) : [],
        status: r.status,
        submittedAtMs: r.submittedAtMs,
        decidedAtMs: r.reviewedAtMs ?? null,
        reviewerName: reviewer?.displayName ?? null,
        decisionReason: r.decisionReason ?? null,
        assignmentId: r.assignmentId ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), requests };
  },
});

async function pendingRequest(ctx: MutationCtx, raw: string) {
  const id = ctx.db.normalizeId("enrollmentRequests", raw);
  return id ? await ctx.db.get(id) : null;
}

/**
 * Approves a request onto a stop of the route's *current* version. The stop
 * is chosen by staff (usually the one requested) and rechecked here.
 */
export const approve = mutation({
  args: { enrollmentRequestId: v.string(), stopId: v.string() },
  handler: async (ctx, { enrollmentRequestId, stopId }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "enrollment.approve", "enrollmentRequests", enrollmentRequestId, "denied");
      return denied(caller.reason);
    }
    const r = await pendingRequest(ctx, enrollmentRequestId);
    if (!r) return refusedDecision("not_found", "That request doesn't exist.");
    if (r.status !== "pending") return refusedDecision("already_decided", "This request has already been decided.");
    const route = await ctx.db.get(r.routeId);
    if (!route?.currentVersionId) return refusedDecision("route_unavailable", "This route has no approved version.");
    const stop = await stopInVersion(ctx, stopId, route.currentVersionId);
    if (!stop) return refusedDecision("stop_not_eligible", "Choose one of the route's current approved stops.");

    const account = await approvedFamilyUser(ctx, r.applicantTokenIdentifier, r.studentName);
    if (!account) {
      return refusedDecision("account_conflict", "This sign-in belongs to a staff or driver account.");
    }
    const existingStudent = await ctx.db
      .query("students")
      .withIndex("by_user", (q) => q.eq("userId", account._id))
      .first();
    const studentId = existingStudent?._id ?? (await ctx.db.insert("students", { displayName: r.studentName, userId: account._id }));

    const t = now();
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId: route.currentVersionId,
      stopId: stop._id,
      status: "approved",
      approvedByUserId: caller.user._id,
      approvedAtMs: t,
      enrollmentRequestId: r._id,
    });
    await ctx.db.patch(r._id, { status: "approved", reviewedByUserId: caller.user._id, reviewedAtMs: t, assignmentId });
    await audit(ctx, caller.user, "enrollment.approve", "enrollmentRequests", r._id, "allowed", { source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "approved", serverNowMs: t, assignmentId, guardianLinkId: null };
  },
});

export const reject = mutation({
  args: { enrollmentRequestId: v.string(), reason: v.string() },
  handler: async (ctx, { enrollmentRequestId, reason }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "enrollment.reject", "enrollmentRequests", enrollmentRequestId, "denied");
      return denied(caller.reason);
    }
    const r = await pendingRequest(ctx, enrollmentRequestId);
    if (!r) return refusedDecision("not_found", "That request doesn't exist.");
    if (r.status !== "pending") return refusedDecision("already_decided", "This request has already been decided.");
    const why = boundedText(reason, MAX_REASON_LENGTH);
    if (!why) return refusedDecision("reason_required", "Give the family a reason.");
    await ctx.db.patch(r._id, { status: "rejected", reviewedByUserId: caller.user._id, reviewedAtMs: now(), decisionReason: why });
    await audit(ctx, caller.user, "enrollment.reject", "enrollmentRequests", r._id, "allowed", { reason: why, source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "rejected", serverNowMs: now() };
  },
});

// MARK: Staff: invitations

/**
 * Creates a route enrollment invitation. An action, so the token comes from
 * real randomness; the inner mutation checks staff access (the caller's
 * identity carries through `runMutation`) and stores only the hash.
 */
export const createRouteInvitation = action({
  args: { routeId: v.string(), ttlMs: v.number() },
  handler: async (ctx, { routeId, ttlMs }): Promise<CreateInvitationResult> => {
    const token = generateToken();
    const result: CreateInvitationResult = await ctx.runMutation(internal.enrollment.insertInvitation, {
      tokenHash: (await tokenHash(token)) as string,
      purpose: "route_enrollment",
      scopeId: routeId,
      ttlMs,
    });
    return result.status === "created" ? { ...result, token } : result;
  },
});

/** Shared by both invitation actions. Returns `created` without the token; the action adds it. */
export const insertInvitation = internalMutation({
  args: {
    tokenHash: v.string(),
    purpose: v.union(v.literal("route_enrollment"), v.literal("guardian_link")),
    scopeId: v.string(),
    ttlMs: v.number(),
  },
  handler: async (ctx, { tokenHash: hash, purpose, scopeId, ttlMs }): Promise<CreateInvitationResult> => {
    const auditAction = purpose === "route_enrollment" ? "invitation.createEnrollment" : "invitation.createGuardian";
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, auditAction, "scopedTokens", undefined, "denied");
      return denied(caller.reason);
    }
    const refuse = (code: "not_found" | "invalid_ttl" | "route_unavailable", message: string): CreateInvitationResult => ({
      schemaVersion: SCHEMA_VERSION,
      status: "refused",
      serverNowMs: now(),
      code,
      message,
    });
    const maxTtl = purpose === "route_enrollment" ? MAX_ENROLLMENT_INVITATION_TTL_MS : MAX_GUARDIAN_INVITATION_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_INVITATION_TTL_MS || ttlMs > maxTtl) {
      return refuse("invalid_ttl", "Choose a lifetime between one hour and the allowed maximum.");
    }
    let scope: { routeId: Id<"routes"> } | { studentId: Id<"students"> };
    if (purpose === "route_enrollment") {
      const id = ctx.db.normalizeId("routes", scopeId);
      const route = id ? await ctx.db.get(id) : null;
      if (!route) return refuse("not_found", "That route doesn't exist.");
      if (!route.currentVersionId) return refuse("route_unavailable", "Approve a route version before inviting families.");
      scope = { routeId: route._id };
    } else {
      const id = ctx.db.normalizeId("students", scopeId);
      const student = id ? await ctx.db.get(id) : null;
      if (!student) return refuse("not_found", "That student doesn't exist.");
      scope = { studentId: student._id };
    }
    const t = now();
    const invitationId = await ctx.db.insert("scopedTokens", {
      tokenHash: hash,
      purpose,
      ...scope,
      issuedByUserId: caller.user._id,
      issuedAtMs: t,
      expiresAtMs: t + ttlMs,
      revoked: false,
      singleUse: purpose === "guardian_link",
    });
    await audit(ctx, caller.user, auditAction, "scopedTokens", invitationId, "allowed", { source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "created", serverNowMs: t, invitationId, token: "", expiresAtMs: t + ttlMs };
  },
});

export const listInvitations = query({
  args: {},
  handler: async (ctx): Promise<ListInvitationsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const rows: Doc<"scopedTokens">[] = [];
    for (const purpose of ["route_enrollment", "guardian_link"] as const) {
      rows.push(...(await ctx.db.query("scopedTokens").withIndex("by_purpose", (q) => q.eq("purpose", purpose)).order("desc").take(100)));
    }
    rows.sort((a, b) => b.issuedAtMs - a.issuedAtMs);
    const invitations: InvitationSummary[] = [];
    for (const row of rows) {
      const route = row.routeId ? await ctx.db.get(row.routeId) : null;
      const student = row.studentId ? await ctx.db.get(row.studentId) : null;
      const issuer = row.issuedByUserId ? await ctx.db.get(row.issuedByUserId) : null;
      invitations.push({
        invitationId: row._id,
        purpose: row.purpose as "route_enrollment" | "guardian_link",
        routeLabel: route?.label ?? null,
        studentDisplayName: student?.displayName ?? null,
        issuedAtMs: row.issuedAtMs,
        issuedByName: issuer?.displayName ?? null,
        expiresAtMs: row.expiresAtMs,
        revoked: row.revoked,
        usedAtMs: row.usedAtMs ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), invitations };
  },
});

/** Revokes an enrollment or guardian invitation. Idempotent. Check-in challenges end with their run. */
export const revokeInvitation = mutation({
  args: { invitationId: v.string() },
  handler: async (ctx, { invitationId }): Promise<DecisionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "invitation.revoke", "scopedTokens", invitationId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("scopedTokens", invitationId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.purpose === "trip_check_in") return refusedDecision("not_found", "That invitation doesn't exist.");
    if (!row.revoked) {
      await ctx.db.patch(row._id, { revoked: true });
      await audit(ctx, caller.user, "invitation.revoke", "scopedTokens", row._id, "allowed", { source: "staff_web" });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "revoked", serverNowMs: now() };
  },
});
