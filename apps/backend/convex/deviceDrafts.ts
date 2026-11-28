import {
  type RouteDraftRejection,
  type RouteDraftReview,
  type RouteDraftStatusResponse,
  type RouteDraftSubmission,
  type RouteDraftSubmitResult,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { currentGrant, liveDevice } from "./deviceRoster";
import { insertDraft } from "./routes";
import { insertAudit } from "./lib/staff";

/**
 * Route drafts submitted from the driver screen (docs/08 §7.1, docs/05
 * D10-D11). The device credential identifies the Pi; the driver operating
 * grant, current when the request arrives, identifies the driver. A stored
 * draft is always `submitted`: only staff approve (routes.approveDraft).
 */

function review(draft: Doc<"routeDrafts">): RouteDraftReview {
  return {
    draftId: draft._id,
    deviceDraftId: draft.deviceDraftId ?? "",
    status: draft.status,
    submittedAtMs: draft.submittedAtMs,
    reviewedAtMs: draft.reviewedAtMs ?? null,
    decisionReason: draft.decisionReason ?? null,
    routeVersionId: draft.approvedVersionId ?? null,
  };
}

/**
 * Stores one validated submission (http.ts ran validateRouteDraftSubmission
 * and hashed routeDraftContent). Idempotent: the same requestId, or the same
 * device draft with the same content, returns the stored draft; different
 * content under either identity is rejected, never merged.
 */
export const submit = internalMutation({
  args: {
    deviceId: v.id("devices"),
    grantHash: v.string(),
    contentHash: v.string(),
    // Validated by validateRouteDraftSubmission in http.ts.
    submission: v.any(),
    nowMs: v.number(),
  },
  handler: async (ctx, { deviceId, grantHash, contentHash, submission, nowMs }): Promise<RouteDraftSubmitResult> => {
    const device = await liveDevice(ctx, deviceId);
    const s = submission as RouteDraftSubmission;
    const reject = (code: RouteDraftRejection, message: string): RouteDraftSubmitResult => ({
      schemaVersion: SCHEMA_VERSION,
      requestId: s.requestId,
      status: "rejected",
      code,
      message,
      serverNowMs: nowMs,
    });
    const ok = (status: "accepted" | "already_submitted", draft: Doc<"routeDrafts">): RouteDraftSubmitResult => ({
      schemaVersion: SCHEMA_VERSION,
      requestId: s.requestId,
      status,
      draft: review(draft),
      serverNowMs: nowMs,
    });

    const grant = await currentGrant(ctx, grantHash, device, nowMs);
    if (!grant) {
      await insertAudit(ctx, { kind: "device", deviceId: device._id }, "route.submitDraft", "routeDrafts", undefined, "denied", {
        source: "driver_device",
        capturedAtMs: s.capturedAtMs,
      });
      return reject("grant_not_authorized", "The driver operating grant does not allow this.");
    }

    const byRequest = await ctx.db
      .query("routeDrafts")
      .withIndex("by_device_request", (q) => q.eq("recordedByDeviceId", device._id).eq("submitRequestId", s.requestId))
      .unique();
    if (byRequest) {
      if (byRequest.contentHash !== contentHash || byRequest.deviceDraftId !== s.deviceDraftId) {
        return reject("request_id_conflict", "This requestId was already used for a different draft.");
      }
      return ok("already_submitted", byRequest);
    }
    const byDraft = await ctx.db
      .query("routeDrafts")
      .withIndex("by_device_draft", (q) => q.eq("recordedByDeviceId", device._id).eq("deviceDraftId", s.deviceDraftId))
      .first();
    if (byDraft) {
      if (byDraft.contentHash !== contentHash) {
        return reject("draft_conflict", "This draft was already submitted with different stops or path. Record the route again to change it.");
      }
      // A resend under a new requestId (the first answer was lost and the
      // driver pressed Submit again): the same draft, not a second one.
      return ok("already_submitted", byDraft);
    }

    const gapBeforeIndexes = s.path.flatMap((p, i) => (p.gapBefore ? [i] : []));
    const draftId = await insertDraft(
      ctx,
      {
        label: s.label,
        direction: s.direction,
        path: s.path.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
        stops: s.stops.map((p) => ({ label: p.label, latitude: p.latitude, longitude: p.longitude })),
        recordedByDeviceId: device._id,
        recordedByUserId: grant.driverUserId,
        deviceDraftId: s.deviceDraftId,
        submitRequestId: s.requestId,
        contentHash,
        recordingStartedAtMs: s.startedAtMs,
        recordingFinishedAtMs: s.finishedAtMs,
        ...(gapBeforeIndexes.length > 0 ? { gapBeforeIndexes } : {}),
      },
      nowMs,
    );
    await insertAudit(ctx, { kind: "user", userId: grant.driverUserId }, "route.submitDraft", "routeDrafts", draftId, "allowed", {
      source: "driver_device",
      viaDeviceId: device._id,
      capturedAtMs: s.capturedAtMs,
    });
    const draft = await ctx.db.get(draftId);
    return ok("accepted", draft!);
  },
});

type StatusFailure = { ok: false; status: 403; code: "GRANT_NOT_AUTHORIZED"; message: string };

/** Review state of drafts this device submitted. Another device's draft reads as not_found. */
export const status = internalQuery({
  args: { deviceId: v.id("devices"), grantHash: v.string(), draftIds: v.array(v.string()), nowMs: v.number() },
  handler: async (ctx, { deviceId, grantHash, draftIds, nowMs }): Promise<{ ok: true; body: RouteDraftStatusResponse } | StatusFailure> => {
    const device = await liveDevice(ctx, deviceId);
    if (!(await currentGrant(ctx, grantHash, device, nowMs))) {
      return { ok: false, status: 403, code: "GRANT_NOT_AUTHORIZED", message: "The driver operating grant does not allow this." };
    }
    const drafts: RouteDraftStatusResponse["drafts"] = [];
    for (const draftId of draftIds) {
      const id = ctx.db.normalizeId("routeDrafts", draftId);
      const draft = id ? await ctx.db.get(id) : null;
      drafts.push(draft && draft.recordedByDeviceId === device._id ? review(draft) : { draftId, status: "not_found" });
    }
    return { ok: true, body: { schemaVersion: SCHEMA_VERSION, drafts, serverNowMs: nowMs } };
  },
});
