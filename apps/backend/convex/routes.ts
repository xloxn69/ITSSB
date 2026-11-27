import {
  MAX_REASON_LENGTH,
  type StaffActionResult,
  type ApproveDraftResult,
  type DraftDetail,
  type DraftSummary,
  type GetDraftResult,
  type ListDraftsResult,
  type ListRoutesResult,
  type RejectDraftResult,
  type ReviewRefusalCode,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { receiptFor, revokeAssignment, storeReceipt } from "./lib/attendance";
import { boundedText, isRequestId } from "./lib/family";
import { routeChecks } from "./lib/routeChecks";
import { accessUnavailable, audit, denied, staffCaller } from "./lib/staff";
import { draftStop, routeDirection } from "./schema";

/**
 * Staff route library and draft review (docs/12 §4, docs/08 §11).
 *
 * A recorded draft is reviewed, then approved into a new immutable
 * `routeVersions` row, or rejected with a reason. Saving, approving and
 * rejecting are separate actions; nothing here publishes as a side effect.
 */

const point = v.object({ latitude: v.number(), longitude: v.number() });
const nullable = <T extends Parameters<typeof v.union>[0]>(x: T) => v.union(x, v.null());

const versionSummary = v.object({
  routeVersionId: v.string(),
  versionNumber: nullable(v.number()),
  approvedAtMs: nullable(v.number()),
  approvedByName: nullable(v.string()),
  effectiveFromMs: nullable(v.number()),
  stopCount: v.number(),
});

const draftSummaryFields = {
  draftId: v.string(),
  routeId: nullable(v.string()),
  label: v.string(),
  direction: routeDirection,
  status: v.union(v.literal("submitted"), v.literal("approved"), v.literal("rejected")),
  submittedAtMs: v.number(),
  pointCount: v.number(),
  stopCount: v.number(),
  reviewedAtMs: nullable(v.number()),
  reviewerName: nullable(v.string()),
  decisionReason: nullable(v.string()),
  approvedVersionId: nullable(v.string()),
};

const refused = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("refused"),
  serverNowMs: v.number(),
  code: v.union(
    v.literal("not_found"),
    v.literal("already_decided"),
    v.literal("blocking_checks"),
    v.literal("route_has_assignments"),
    v.literal("direction_mismatch"),
    v.literal("reason_required"),
  ),
  message: v.string(),
});

function refuse(code: ReviewRefusalCode, message: string) {
  return { schemaVersion: SCHEMA_VERSION, status: "refused" as const, serverNowMs: Date.now(), code, message };
}

async function userName(ctx: QueryCtx, id: Id<"users"> | undefined): Promise<string | null> {
  if (!id) return null;
  return (await ctx.db.get(id))?.displayName ?? null;
}

function summarize(draft: Doc<"routeDrafts">, reviewerName: string | null): DraftSummary {
  return {
    draftId: draft._id,
    routeId: draft.routeId ?? null,
    label: draft.label,
    direction: draft.direction,
    status: draft.status,
    submittedAtMs: draft.submittedAtMs,
    pointCount: draft.path.length,
    stopCount: draft.stops.length,
    reviewedAtMs: draft.reviewedAtMs ?? null,
    reviewerName,
    decisionReason: draft.decisionReason ?? null,
    approvedVersionId: draft.approvedVersionId ?? null,
  };
}

export const list = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      routes: v.array(
        v.object({
          routeId: v.string(),
          label: v.string(),
          direction: routeDirection,
          currentVersion: nullable(versionSummary),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListRoutesResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const routes = await ctx.db.query("routes").take(500);
    const result = [];
    for (const route of routes) {
      const version = route.currentVersionId ? await ctx.db.get(route.currentVersionId) : null;
      const stops = version
        ? await ctx.db
            .query("stops")
            .withIndex("by_route_version", (q) => q.eq("routeVersionId", version._id))
            .collect()
        : [];
      result.push({
        routeId: route._id,
        label: route.label,
        direction: route.direction,
        currentVersion: version
          ? {
              routeVersionId: version._id,
              versionNumber: version.versionNumber ?? null,
              approvedAtMs: version.approvedAtMs ?? null,
              approvedByName: await userName(ctx, version.approvedByUserId),
              effectiveFromMs: version.effectiveFromMs ?? null,
              stopCount: stops.length,
            }
          : null,
      });
    }
    result.sort((a, b) => a.label.localeCompare(b.label));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), routes: result };
  },
});

export const listDrafts = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      drafts: v.array(v.object(draftSummaryFields)),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListDraftsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    // Waiting drafts first, then the most recent decisions.
    const waiting = await ctx.db
      .query("routeDrafts")
      .withIndex("by_status", (q) => q.eq("status", "submitted"))
      .order("desc")
      .take(100);
    const decided = [
      ...(await ctx.db
        .query("routeDrafts")
        .withIndex("by_status", (q) => q.eq("status", "approved"))
        .order("desc")
        .take(25)),
      ...(await ctx.db
        .query("routeDrafts")
        .withIndex("by_status", (q) => q.eq("status", "rejected"))
        .order("desc")
        .take(25)),
    ].toSorted((a, b) => (b.reviewedAtMs ?? 0) - (a.reviewedAtMs ?? 0));
    const drafts = [];
    for (const d of [...waiting, ...decided]) drafts.push(summarize(d, await userName(ctx, d.reviewedByUserId)));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), drafts };
  },
});

export const getDraft = query({
  args: { draftId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      draft: v.object({
        ...draftSummaryFields,
        path: v.array(point),
        stops: v.array(
          v.object({
            sequence: v.number(),
            label: v.string(),
            latitude: v.number(),
            longitude: v.number(),
            instructions: nullable(v.string()),
          }),
        ),
        checks: v.array(
          v.object({
            code: v.union(
              v.literal("too_few_points"),
              v.literal("too_many_points"),
              v.literal("invalid_coordinate"),
              v.literal("no_stops"),
              v.literal("path_gap"),
              v.literal("stop_off_path"),
            ),
            severity: v.union(v.literal("blocking"), v.literal("warning")),
            message: v.string(),
          }),
        ),
      }),
    }),
    v.object({ schemaVersion: v.literal(SCHEMA_VERSION), status: v.literal("not_found"), serverNowMs: v.number() }),
    accessUnavailable,
  ),
  handler: async (ctx, { draftId }): Promise<GetDraftResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const id = ctx.db.normalizeId("routeDrafts", draftId);
    const draft = id ? await ctx.db.get(id) : null;
    if (!draft) return { schemaVersion: SCHEMA_VERSION, status: "not_found", serverNowMs: Date.now() };
    const detail: DraftDetail = {
      ...summarize(draft, await userName(ctx, draft.reviewedByUserId)),
      path: draft.path,
      stops: draft.stops.map((s, sequence) => ({
        sequence,
        label: s.label,
        latitude: s.latitude,
        longitude: s.longitude,
        instructions: s.instructions ?? null,
      })),
      checks: routeChecks(draft.path, draft.stops),
    };
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), draft: detail };
  },
});

async function hasApprovedAssignments(ctx: MutationCtx, versionId: Id<"routeVersions">): Promise<boolean> {
  const rows = await ctx.db
    .query("assignments")
    .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
    .collect();
  return rows.some((a) => a.status === "approved");
}

/**
 * Approves a submitted draft into a new immutable route version and makes it
 * the version new runs pin. Runs already started keep their own version.
 * Idempotent: approving an approved draft returns the same version.
 */
export const approveDraft = mutation({
  args: { draftId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("approved"),
      serverNowMs: v.number(),
      routeId: v.string(),
      routeVersionId: v.string(),
      versionNumber: v.number(),
    }),
    refused,
    accessUnavailable,
  ),
  handler: async (ctx, { draftId }): Promise<ApproveDraftResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "route.approve", "routeDraft", draftId, "denied");
      return denied(caller.reason);
    }
    const { user } = caller;
    const id = ctx.db.normalizeId("routeDrafts", draftId);
    const draft = id ? await ctx.db.get(id) : null;
    if (!draft) return refuse("not_found", "That draft doesn't exist.");

    if (draft.status === "approved" && draft.approvedVersionId) {
      const version = await ctx.db.get(draft.approvedVersionId);
      if (version?.routeId) {
        return {
          schemaVersion: SCHEMA_VERSION,
          status: "approved",
          serverNowMs: Date.now(),
          routeId: version.routeId,
          routeVersionId: version._id,
          versionNumber: version.versionNumber ?? 1,
        };
      }
    }
    if (draft.status !== "submitted") return refuse("already_decided", "This draft has already been decided.");

    if (routeChecks(draft.path, draft.stops).some((c) => c.severity === "blocking")) {
      return refuse("blocking_checks", "Fix the blocking problems before approving.");
    }

    const now = Date.now();
    let routeId: Id<"routes">;
    let versionNumber = 1;
    if (draft.routeId) {
      const route = await ctx.db.get(draft.routeId);
      if (!route) return refuse("not_found", "The route this draft revises no longer exists.");
      if (route.direction !== draft.direction) {
        return refuse(
          "direction_mismatch",
          "This revision runs in the other direction from its route. Record it as a new route instead.",
        );
      }
      if (route.currentVersionId) {
        if (await hasApprovedAssignments(ctx, route.currentVersionId)) {
          return refuse(
            "route_has_assignments",
            "Students are assigned to the current version. Moving them to a new version isn't supported yet.",
          );
        }
        const current = await ctx.db.get(route.currentVersionId);
        versionNumber = (current?.versionNumber ?? 1) + 1;
      }
      routeId = route._id;
    } else {
      routeId = await ctx.db.insert("routes", { label: draft.label, direction: draft.direction, createdAtMs: now });
    }

    const routeVersionId = await ctx.db.insert("routeVersions", {
      label: draft.label,
      path: draft.path,
      routeId,
      versionNumber,
      sourceDraftId: draft._id,
      approvedByUserId: user._id,
      approvedAtMs: now,
      effectiveFromMs: now,
    });
    for (const [sequence, stop] of draft.stops.entries()) {
      await ctx.db.insert("stops", {
        routeVersionId,
        label: stop.label,
        latitude: stop.latitude,
        longitude: stop.longitude,
        sequence,
        ...(stop.instructions ? { instructions: stop.instructions } : {}),
      });
    }
    await ctx.db.patch(routeId, { label: draft.label, currentVersionId: routeVersionId });
    await ctx.db.patch(draft._id, {
      status: "approved",
      reviewedByUserId: user._id,
      reviewedAtMs: now,
      approvedVersionId: routeVersionId,
    });
    await audit(ctx, user, "route.approve", "routeDraft", draft._id, "allowed");
    return { schemaVersion: SCHEMA_VERSION, status: "approved", serverNowMs: now, routeId, routeVersionId, versionNumber };
  },
});

export const rejectDraft = mutation({
  args: { draftId: v.string(), reason: v.string() },
  returns: v.union(
    v.object({ schemaVersion: v.literal(SCHEMA_VERSION), status: v.literal("rejected"), serverNowMs: v.number() }),
    refused,
    accessUnavailable,
  ),
  handler: async (ctx, { draftId, reason }): Promise<RejectDraftResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "route.reject", "routeDraft", draftId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("routeDrafts", draftId);
    const draft = id ? await ctx.db.get(id) : null;
    if (!draft) return refuse("not_found", "That draft doesn't exist.");
    const trimmed = reason.trim().slice(0, 500);
    if (!trimmed) return refuse("reason_required", "Say why the draft is rejected, so the driver can fix it.");
    if (draft.status !== "submitted") return refuse("already_decided", "This draft has already been decided.");
    const now = Date.now();
    await ctx.db.patch(draft._id, {
      status: "rejected",
      reviewedByUserId: caller.user._id,
      reviewedAtMs: now,
      decisionReason: trimmed,
    });
    await audit(ctx, caller.user, "route.reject", "routeDraft", draft._id, "allowed");
    return { schemaVersion: SCHEMA_VERSION, status: "rejected", serverNowMs: now };
  },
});

/**
 * Stores a recorded draft as submitted. Internal: the authorized driver
 * upload path (docs/08 §6, driver operating grant) calls it; there is no
 * public create-draft.
 */
export const recordDraft = internalMutation({
  args: {
    routeId: v.optional(v.id("routes")),
    label: v.string(),
    direction: routeDirection,
    path: v.array(point),
    stops: v.array(draftStop),
    recordedByDeviceId: v.optional(v.id("devices")),
  },
  returns: v.id("routeDrafts"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("routeDrafts", { ...args, status: "submitted", submittedAtMs: Date.now() });
  },
});

/**
 * Removes one student from one route (docs/09 §9, docs/08 §9): revokes the
 * assignment with a reason. The student record, other assignments, guardian
 * links and attendance history stay. Drivers do the same through
 * `POST /device/v1/roster-actions`, scoped to their grant's routes.
 */
export const removeAssignment = mutation({
  args: { requestId: v.string(), assignmentId: v.string(), reason: v.string() },
  handler: async (ctx, { requestId, assignmentId, reason }): Promise<StaffActionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "assignment.remove", "assignments", assignmentId, "denied");
      return denied(caller.reason);
    }
    const refuseRemoval = (code: "not_found" | "reason_required" | "already_removed", message: string): StaffActionResult => ({
      schemaVersion: SCHEMA_VERSION,
      status: "refused",
      serverNowMs: Date.now(),
      code,
      message,
    });
    const why = boundedText(reason, MAX_REASON_LENGTH);
    if (!why || !isRequestId(requestId)) return refuseRemoval("reason_required", "Give a reason for removing this student.");
    const scope = `user:${caller.user._id}`;
    const prior = await receiptFor(ctx, scope, requestId);
    if (prior) {
      if (prior.fingerprint !== `remove:${assignmentId}`) return refuseRemoval("not_found", "This request was already used.");
      return { schemaVersion: SCHEMA_VERSION, status: "accepted", serverNowMs: Date.now(), checkIn: null };
    }
    const id = ctx.db.normalizeId("assignments", assignmentId);
    const assignment = id ? await ctx.db.get(id) : null;
    if (!assignment) return refuseRemoval("not_found", "That assignment doesn't exist.");
    if (assignment.status !== "approved") return refuseRemoval("already_removed", "This student was already removed from the route.");
    await revokeAssignment(ctx, assignment, caller.user._id, why);
    await storeReceipt(ctx, { scope, requestId, fingerprint: `remove:${assignmentId}`, status: "accepted" });
    await audit(ctx, caller.user, "assignment.remove", "assignments", assignment._id, "allowed", { reason: why, source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "accepted", serverNowMs: Date.now(), checkIn: null };
  },
});
