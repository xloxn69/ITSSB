import {
  CHECK_IN_CHALLENGE_TTL_MS,
  DEVICE_ENROLLMENT_INVITATION_TTL_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_QUEUED_ACTION_AGE_MS,
  type RosterAction,
  type RosterActionRejection,
  type RosterActionResult,
  type RosterResponse,
  type RosterStudent,
  SCHEMA_VERSION,
  TOKEN_LINK_PATHS,
} from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { grantForDevice } from "./driverGrants";
import { appendCorrection, currentCheckIn, receiptFor, recordOnce, revokeAssignment, storeReceipt, toRecord } from "./lib/attendance";
import { insertAudit } from "./lib/staff";

/**
 * The driver screen's student features (docs/09 §6–§9, docs/08 §9.2):
 * displayed QR codes, the run roster, and driver actions that the Pi may
 * queue offline. Every call carries the driver operating grant; a device
 * credential alone never reads the roster or changes a student record.
 */

type Failure = { ok: false; status: 400 | 403; code: "GRANT_NOT_AUTHORIZED" | "RUN_NOT_AUTHORIZED" | "INVALID_REQUEST"; message: string };
const GRANT_DENIED: Failure = { ok: false, status: 403, code: "GRANT_NOT_AUTHORIZED", message: "The driver operating grant does not allow this." };
const RUN_DENIED: Failure = { ok: false, status: 403, code: "RUN_NOT_AUTHORIZED", message: "This device is not authorized for that run." };

export async function liveDevice(ctx: QueryCtx, deviceId: Id<"devices">) {
  const device = await ctx.db.get(deviceId);
  if (!device || device.revoked) throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
  return device;
}

/** A grant valid right now for this device. */
export async function currentGrant(ctx: QueryCtx, grantHash: string, device: Doc<"devices">, nowMs: number) {
  const grant = await grantForDevice(ctx, grantHash, device);
  return grant && grant.expiresAtMs > nowMs ? grant : null;
}

/** The device's own run whose route version the grant covers. */
async function grantedRun(ctx: QueryCtx, rawRunId: unknown, device: Doc<"devices">, grant: Doc<"driverGrants">) {
  const id = typeof rawRunId === "string" ? ctx.db.normalizeId("runs", rawRunId) : null;
  const run = id ? await ctx.db.get(id) : null;
  if (!run || run.deviceId !== device._id) return null;
  if (!grant.routeVersionIds.some((g) => g === run.routeVersionId)) return null;
  return run;
}

// MARK: QR codes

export const issueQrCode = internalMutation({
  args: {
    deviceId: v.id("devices"),
    grantHash: v.string(),
    tokenHash: v.string(),
    // Parsed JSON; checked below.
    request: v.any(),
    nowMs: v.number(),
  },
  handler: async (ctx, { deviceId, grantHash, tokenHash, request, nowMs }) => {
    const device = await liveDevice(ctx, deviceId);
    const r = request as { purpose?: unknown; runId?: unknown; routeVersionId?: unknown };
    if (r.purpose !== "trip_check_in" && r.purpose !== "route_enrollment") {
      return { ok: false, status: 400, code: "INVALID_REQUEST", message: "purpose must be trip_check_in or route_enrollment." } as Failure;
    }
    const grant = await currentGrant(ctx, grantHash, device, nowMs);
    if (!grant) return GRANT_DENIED;

    if (r.purpose === "trip_check_in") {
      const run = await grantedRun(ctx, r.runId, device, grant);
      if (!run || run.state !== "active") return RUN_DENIED;
      // A refreshed code replaces the previous one, so an old screenshot
      // stops working as soon as the screen updates.
      for (const old of await ctx.db.query("scopedTokens").withIndex("by_run", (q) => q.eq("runId", run._id)).collect()) {
        if (!old.revoked && old.expiresAtMs > nowMs) await ctx.db.patch(old._id, { revoked: true });
      }
      const expiresAtMs = nowMs + CHECK_IN_CHALLENGE_TTL_MS;
      const id = await ctx.db.insert("scopedTokens", {
        tokenHash,
        purpose: "trip_check_in",
        runId: run._id,
        issuedByUserId: grant.driverUserId,
        issuedByDeviceId: device._id,
        issuedAtMs: nowMs,
        expiresAtMs,
        revoked: false,
        singleUse: false,
      });
      await insertAudit(ctx, { kind: "user", userId: grant.driverUserId }, "qr.issueCheckIn", "scopedTokens", id, "allowed", {
        source: "driver_device",
        viaDeviceId: device._id,
      });
      return { ok: true, purpose: "trip_check_in", linkPath: TOKEN_LINK_PATHS.trip_check_in, expiresAtMs } as const;
    }

    const versionId = typeof r.routeVersionId === "string" ? ctx.db.normalizeId("routeVersions", r.routeVersionId) : null;
    if (!versionId || !grant.routeVersionIds.includes(versionId)) return GRANT_DENIED;
    const version = await ctx.db.get(versionId);
    const route = version?.routeId ? await ctx.db.get(version.routeId) : null;
    // Only the route's current version invites new families.
    if (!route || route.currentVersionId !== versionId) return GRANT_DENIED;
    const expiresAtMs = nowMs + DEVICE_ENROLLMENT_INVITATION_TTL_MS;
    const id = await ctx.db.insert("scopedTokens", {
      tokenHash,
      purpose: "route_enrollment",
      routeId: route._id,
      issuedByUserId: grant.driverUserId,
      issuedByDeviceId: device._id,
      issuedAtMs: nowMs,
      expiresAtMs,
      revoked: false,
      singleUse: false,
    });
    await insertAudit(ctx, { kind: "user", userId: grant.driverUserId }, "qr.issueEnrollment", "scopedTokens", id, "allowed", {
      source: "driver_device",
      viaDeviceId: device._id,
    });
    return { ok: true, purpose: "route_enrollment", linkPath: TOKEN_LINK_PATHS.route_enrollment, expiresAtMs } as const;
  },
});

// MARK: Roster

export const roster = internalQuery({
  args: { deviceId: v.id("devices"), grantHash: v.string(), runId: v.string(), nowMs: v.number() },
  handler: async (ctx, { deviceId, grantHash, runId, nowMs }): Promise<{ ok: true; body: RosterResponse } | Failure> => {
    const device = await liveDevice(ctx, deviceId);
    const grant = await currentGrant(ctx, grantHash, device, nowMs);
    if (!grant) return GRANT_DENIED;
    const run = await grantedRun(ctx, runId, device, grant);
    if (!run) return RUN_DENIED;
    const versionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
    const students: RosterStudent[] = [];
    if (versionId) {
      const assignments = await ctx.db
        .query("assignments")
        .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
        .collect();
      for (const a of assignments) {
        if (a.status !== "approved") continue;
        const student = await ctx.db.get(a.studentId);
        const stop = await ctx.db.get(a.stopId);
        const row = await currentCheckIn(ctx, run._id, a.studentId);
        // Selected fields only: no address, account or guardian details.
        students.push({
          assignmentId: a._id,
          studentDisplayName: student?.displayName ?? "Student",
          stopId: a.stopId,
          stopLabel: stop?.label ?? "Stop",
          stopSequence: stop?.sequence ?? 0,
          seatLabel: a.seatLabel ?? null,
          driverNote: a.driverNote ?? null,
          checkIn: row ? toRecord(row) : null,
        });
      }
    }
    students.sort((x, y) => x.stopSequence - y.stopSequence || x.studentDisplayName.localeCompare(y.studentDisplayName));
    return {
      ok: true,
      body: { schemaVersion: SCHEMA_VERSION, runId: run._id, routeVersionId: run.routeVersionId, students, serverNowMs: nowMs },
    };
  },
});

// MARK: Roster actions

/**
 * Applies one driver action. Authority is rechecked at acceptance, for an
 * action queued offline too: the grant must belong to this device, must not
 * be revoked (revocation history is not kept, so a revoked grant cannot
 * prove it was valid at capture), and must have been valid when the action
 * was captured. The capture time must be plausible. The outcome is stored
 * under the device and `requestId`, so a retry returns it unchanged.
 */
export const applyAction = internalMutation({
  args: { deviceId: v.id("devices"), grantHash: v.string(), action: v.any(), nowMs: v.number() },
  handler: async (ctx, { deviceId, grantHash, action, nowMs }): Promise<RosterActionResult> => {
    const device = await liveDevice(ctx, deviceId);
    const a = action as RosterAction;
    const scope = `device:${device._id}`;
    const { driverOperatingGrant: _secret, ...content } = a;
    const fingerprint = JSON.stringify(content, Object.keys(content).sort());

    const prior = await receiptFor(ctx, scope, a.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return reject(a, "request_id_conflict", "This requestId was already used for a different action.", nowMs);
      const row = prior.checkInId ? await ctx.db.get(prior.checkInId) : null;
      if (prior.status === "rejected") {
        return { schemaVersion: SCHEMA_VERSION, requestId: a.requestId, status: "rejected", code: prior.code as RosterActionRejection, message: prior.message ?? "", serverNowMs: nowMs };
      }
      return { schemaVersion: SCHEMA_VERSION, requestId: a.requestId, status: prior.status, checkIn: row ? toRecord(row) : null, serverNowMs: nowMs };
    }

    const result = await decide(ctx, device, grantHash, a, nowMs);
    await storeReceipt(ctx, {
      scope,
      requestId: a.requestId,
      fingerprint,
      status: result.status,
      ...(result.status !== "rejected" && result.checkIn ? { checkInId: result.checkIn.checkInId as Id<"checkIns"> } : {}),
      ...(result.status === "rejected" ? { code: result.code, message: result.message } : {}),
    });
    return result;
  },
});

function reject(a: RosterAction, code: RosterActionRejection, message: string, nowMs: number): RosterActionResult {
  return { schemaVersion: SCHEMA_VERSION, requestId: a.requestId, status: "rejected", code, message, serverNowMs: nowMs };
}

async function decide(
  ctx: MutationCtx,
  device: Doc<"devices">,
  grantHash: string,
  a: RosterAction,
  nowMs: number,
): Promise<RosterActionResult> {
  if (a.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS || nowMs - a.capturedAtMs > MAX_QUEUED_ACTION_AGE_MS) {
    return reject(a, "capture_time_out_of_range", "The action's time is not plausible.", nowMs);
  }
  // The grant must still be current when the action arrives (docs/08 §6:
  // a capture time alone never overrides an expired or revoked grant), and
  // the action must have been captured while it was valid.
  const grant = await grantForDevice(ctx, grantHash, device);
  // Grant times are server times and the capture time is the Pi's clock, so
  // allow the same skew the rest of the device contract allows.
  if (
    !grant ||
    grant.expiresAtMs <= nowMs ||
    a.capturedAtMs < grant.issuedAtMs - MAX_FUTURE_SKEW_MS ||
    a.capturedAtMs > grant.expiresAtMs
  ) {
    return reject(a, "grant_not_authorized", "The driver was not authorized for this when it was recorded.", nowMs);
  }
  const assignmentId = ctx.db.normalizeId("assignments", a.assignmentId);
  const assignment = assignmentId ? await ctx.db.get(assignmentId) : null;
  // Unknown and other routes' assignments get the same answer.
  if (!assignment || !grant.routeVersionIds.includes(assignment.routeVersionId)) {
    return reject(a, "assignment_not_authorized", "That student isn't on a route this driver may manage.", nowMs);
  }
  const by = grant.driverUserId;
  const auditExtra = { source: "driver_device" as const, viaDeviceId: device._id, capturedAtMs: a.capturedAtMs };
  const ok = (status: "accepted" | "already_recorded" | "superseded", row: Doc<"checkIns"> | null): RosterActionResult => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: a.requestId,
    status,
    checkIn: row ? toRecord(row) : null,
    serverNowMs: nowMs,
  });

  if (a.type === "removeAssignment") {
    if (assignment.status !== "approved") return reject(a, "already_removed", "This student was already removed from the route.", nowMs);
    const reason = a.reason.trim();
    await revokeAssignment(ctx, assignment, by, reason);
    await insertAudit(ctx, { kind: "user", userId: by }, "assignment.remove", "assignments", assignment._id, "allowed", { ...auditExtra, reason });
    return ok("accepted", null);
  }

  if (assignment.status !== "approved") return reject(a, "assignment_not_authorized", "That student isn't on this route now.", nowMs);

  if (a.type === "setSeatNote") {
    if ((assignment.seatNoteCapturedAtMs ?? 0) > a.capturedAtMs) return ok("superseded", null);
    await ctx.db.patch(assignment._id, {
      seatLabel: a.seatLabel?.trim() || undefined,
      driverNote: a.driverNote?.trim() || undefined,
      seatNoteCapturedAtMs: a.capturedAtMs,
    });
    await insertAudit(ctx, { kind: "user", userId: by }, "assignment.setSeatNote", "assignments", assignment._id, "allowed", auditExtra);
    return ok("accepted", null);
  }

  // Attendance: the device's own run on the assignment's route, and the
  // action captured while that run was going.
  const runId = ctx.db.normalizeId("runs", a.runId);
  const run = runId ? await ctx.db.get(runId) : null;
  if (
    !run ||
    run.deviceId !== device._id ||
    run.routeVersionId !== assignment.routeVersionId ||
    run.startedAtMs === undefined ||
    // The start as captured on the same device clock; else the server's, with skew.
    a.capturedAtMs < (run.startCapturedAtMs ?? run.startedAtMs - MAX_FUTURE_SKEW_MS) ||
    // The end as captured on the bus, not when it reached the server.
    a.capturedAtMs > (run.endCapturedAtMs ?? run.endedAtMs ?? Number.POSITIVE_INFINITY) ||
    (run.state !== "active" && run.state !== "completed")
  ) {
    return reject(a, "run_not_authorized", "That action doesn't match a trip this bus ran.", nowMs);
  }

  if (a.type === "recordAttendance") {
    const outcome = await recordOnce(ctx, {
      run,
      assignment,
      status: a.status,
      source: "staff_recorded",
      recordedByUserId: by,
      recordedAtMs: a.capturedAtMs,
      viaDeviceId: device._id,
    });
    if (outcome.status === "accepted") {
      await insertAudit(ctx, { kind: "user", userId: by }, "checkIn.staffRecord", "checkIns", outcome.row._id, "allowed", auditExtra);
    }
    return ok(outcome.status, outcome.row);
  }

  const targetId = ctx.db.normalizeId("checkIns", a.correctsCheckInId);
  const target = targetId ? await ctx.db.get(targetId) : null;
  if (!target || target.runId !== run._id || target.studentId !== assignment.studentId) {
    return reject(a, "correction_target_invalid", "The record to correct isn't this student's on this trip.", nowMs);
  }
  // Corrections are ordered by when they were made on the bus: one captured
  // before the correction that is current now is superseded, so a late
  // queued change never overrides a newer one.
  const current = await currentCheckIn(ctx, run._id, assignment.studentId);
  if (current && current.source === "staff_correction" && current.recordedAtMs >= a.capturedAtMs) {
    return ok("superseded", current);
  }
  const reason = a.reason.trim();
  const row = await appendCorrection(ctx, {
    run,
    assignment,
    status: a.status,
    corrects: target,
    reason,
    recordedByUserId: by,
    recordedAtMs: a.capturedAtMs,
    viaDeviceId: device._id,
  });
  await insertAudit(ctx, { kind: "user", userId: by }, "checkIn.correct", "checkIns", row._id, "allowed", { ...auditExtra, reason });
  return ok("accepted", row);
}
