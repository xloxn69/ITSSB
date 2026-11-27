import {
  type EndRunRequest,
  localDate,
  MAX_FUTURE_SKEW_MS,
  SCHEMA_VERSION,
  type StartRunRequest,
  type TripEventAccepted,
  type TripEventErrorCode,
  validateTripEventRequest,
} from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { grantForDevice } from "./driverGrants";
import { stillAuthorized } from "./lib/deviceAuth";
import { isApprovedForNewRuns } from "./lib/routeVersions";
import { stopJobsForRun } from "./notificationJobs";
import { linkReplacement } from "./runOps";

/**
 * Online run start and end (docs/07 §8, docs/08 §6), committed in one
 * transaction per request. The HTTP action authenticates the device and
 * parses the body; this mutation rechecks the device, the driver grant, the
 * run scope, and the single-active-run rule against current state.
 */

/** How far before the server clock a start may have been captured. */
export const MAX_START_AGE_MS = 6 * 60 * 60 * 1000;

export type TripEventOutcome =
  | { ok: true; body: TripEventAccepted }
  | { ok: false; status: 400 | 403 | 409; code: TripEventErrorCode; message: string };

const fail = (
  status: 400 | 403 | 409,
  code: TripEventErrorCode,
  message: string,
): TripEventOutcome => ({ ok: false, status, code, message });

const GRANT_DENIED = fail(403, "GRANT_NOT_AUTHORIZED", "The driver operating grant does not allow this.");
// Unknown runs and other devices' runs get the same answer (docs/08 §5).
const RUN_DENIED = fail(403, "RUN_NOT_AUTHORIZED", "This device is not authorized for that run.");

/**
 * The accepted response for a start or end, rebuilt from the stored receipt
 * fields, so a retry gets what the first attempt got: a start always answers
 * `active` with `endedAtMs: null`, even if the run has ended since. Only
 * `serverNowMs` is current; it is the server clock, not part of the receipt.
 */
function accepted(
  run: Doc<"runs">,
  operation: "startRun" | "endRun",
  requestId: string,
  nowMs: number,
): TripEventOutcome {
  return {
    ok: true,
    body: {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      status: "accepted",
      runId: run._id,
      state: operation === "startRun" ? "active" : "completed",
      startedAtMs: run.startedAtMs ?? run._creationTime,
      endedAtMs: operation === "startRun" ? null : (run.endedAtMs ?? null),
      serverNowMs: nowMs,
    },
  };
}

/**
 * Every run on this device whose start or end used `requestId`. One
 * requestId names one command: reusing it for another operation or another
 * run is a conflict.
 */
async function receiptsFor(ctx: MutationCtx, device: Doc<"devices">, requestId: string) {
  const [start, end] = await Promise.all([
    ctx.db
      .query("runs")
      .withIndex("by_device_start_request", (q) =>
        q.eq("deviceId", device._id).eq("startRequestId", requestId),
      )
      .unique(),
    ctx.db
      .query("runs")
      .withIndex("by_device_end_request", (q) => q.eq("deviceId", device._id).eq("endRequestId", requestId))
      .unique(),
  ]);
  return { start, end };
}

const REQUEST_CONFLICT = fail(409, "REQUEST_ID_CONFLICT", "This requestId was already used for a different command.");

export const apply = internalMutation({
  args: {
    deviceId: v.id("devices"),
    /** Hash of the credential the request authenticated with; see stillAuthorized. */
    credentialHash: v.optional(v.string()),
    grantHash: v.string(),
    // Parsed JSON from the HTTP body; validated below with the shared contract.
    request: v.any(),
    nowMs: v.number(),
  },
  handler: async (ctx, { deviceId, credentialHash, grantHash, request, nowMs }): Promise<TripEventOutcome> => {
    const device = await ctx.db.get(deviceId);
    if (!device || !stillAuthorized(device, credentialHash)) {
      throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
    }
    const checked = validateTripEventRequest(request);
    if (!checked.ok) return fail(400, checked.code, checked.message);
    const r = checked.request;
    return r.type === "startRun"
      ? await startRun(ctx, device, grantHash, r, nowMs)
      : await endRun(ctx, device, grantHash, r, nowMs);
  },
});

async function startRun(
  ctx: MutationCtx,
  device: Doc<"devices">,
  grantHash: string,
  r: StartRunRequest,
  nowMs: number,
): Promise<TripEventOutcome> {
  const grant = await grantForDevice(ctx, grantHash, device);
  if (!grant) return GRANT_DENIED;

  // Idempotency is per device: another device reusing this requestId never
  // sees this device's run.
  const prior = await receiptsFor(ctx, device, r.requestId);
  if (prior.end) return REQUEST_CONFLICT;
  if (prior.start) {
    const same =
      prior.start.routeVersionId === r.routeVersionId &&
      prior.start.serviceDate === r.serviceDate &&
      prior.start.serviceTimezone === r.serviceTimezone &&
      prior.start.startCapturedAtMs === r.capturedAtMs &&
      prior.start.startGrantId === grant._id;
    if (!same) return REQUEST_CONFLICT;
    // An exact retry, with the same grant, returns the stored result even if
    // that grant expired since.
    return accepted(prior.start, "startRun", r.requestId, nowMs);
  }

  if (grant.expiresAtMs <= nowMs) return GRANT_DENIED;
  const routeVersionId = ctx.db.normalizeId("routeVersions", r.routeVersionId);
  if (!routeVersionId || !grant.routeVersionIds.includes(routeVersionId)) return GRANT_DENIED;
  if (!(await ctx.db.get(routeVersionId))) return GRANT_DENIED;
  // A version superseded by a later approval can't start a new run, even if
  // an older grant still names it (docs/08 §11).
  if (!(await isApprovedForNewRuns(ctx, routeVersionId))) return GRANT_DENIED;

  if (r.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS || r.capturedAtMs < nowMs - MAX_START_AGE_MS) {
    return fail(400, "CLOCK_OUT_OF_RANGE", "capturedAtMs is too far from the server clock.");
  }
  const today = localDate(nowMs, r.serviceTimezone);
  if (r.serviceDate !== today && r.serviceDate !== localDate(r.capturedAtMs, r.serviceTimezone)) {
    return fail(400, "SERVICE_DATE_OUT_OF_RANGE", "serviceDate is not today in serviceTimezone.");
  }

  const [deviceActive, routeActive] = await Promise.all([
    ctx.db
      .query("runs")
      .withIndex("by_device_state", (q) => q.eq("deviceId", device._id).eq("state", "active"))
      .first(),
    ctx.db
      .query("runs")
      .withIndex("by_route_version_state", (q) =>
        q.eq("routeVersionId", routeVersionId).eq("state", "active"),
      )
      .first(),
  ]);
  if (deviceActive || routeActive) {
    return fail(409, "ACTIVE_RUN_CONFLICT", "This bus or route already has an active run.");
  }

  const runId = await ctx.db.insert("runs", {
    deviceId: device._id,
    routeVersionId,
    state: "active",
    startRequestId: r.requestId,
    startedAtMs: nowMs,
    driverUserId: grant.driverUserId,
    startGrantId: grant._id,
    serviceDate: r.serviceDate,
    serviceTimezone: r.serviceTimezone,
    startCapturedAtMs: r.capturedAtMs,
  });
  await ctx.db.insert("auditLog", {
    actor: { kind: "device", deviceId: device._id },
    action: "runs.start",
    resourceType: "runs",
    resourceId: runId,
    result: "allowed",
    atMs: nowMs,
  });
  const run = await ctx.db.get(runId);
  if (!run) throw new Error("run vanished inside its own transaction");
  // Staff sent this bus to replace a cancelled run on this route today.
  await linkReplacement(ctx, run);
  return accepted(run, "startRun", r.requestId, nowMs);
}

async function endRun(
  ctx: MutationCtx,
  device: Doc<"devices">,
  grantHash: string,
  r: EndRunRequest,
  nowMs: number,
): Promise<TripEventOutcome> {
  // Check the grant before anything that depends on the run, so a device
  // credential alone cannot probe which runs exist.
  const grant = await grantForDevice(ctx, grantHash, device);
  if (!grant) return GRANT_DENIED;

  const runId = ctx.db.normalizeId("runs", r.runId);
  const run = runId ? await ctx.db.get(runId) : null;
  if (!run || run.deviceId !== device._id) return RUN_DENIED;

  const prior = await receiptsFor(ctx, device, r.requestId);
  if (prior.start || (prior.end && prior.end._id !== run._id)) return REQUEST_CONFLICT;
  if (prior.end) {
    const same =
      run.endCapturedAtMs === r.capturedAtMs &&
      run.lastRunSequence === r.lastRunSequence &&
      run.endGrantId === grant._id;
    if (!same) return REQUEST_CONFLICT;
    return accepted(run, "endRun", r.requestId, nowMs);
  }

  if (grant.expiresAtMs <= nowMs) return GRANT_DENIED;
  const routeVersionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
  if (!routeVersionId || !grant.routeVersionIds.includes(routeVersionId)) return GRANT_DENIED;
  if (run.state !== "active") return fail(409, "RUN_NOT_ACTIVE", "This run has already ended.");

  if (r.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS || r.capturedAtMs < (run.startCapturedAtMs ?? 0)) {
    return fail(400, "CLOCK_OUT_OF_RANGE", "capturedAtMs is outside this run.");
  }
  const highest = await ctx.db
    .query("telemetryEvents")
    .withIndex("by_run_sequence", (q) => q.eq("runId", run._id))
    .order("desc")
    .first();
  if (highest && (r.lastRunSequence === null || highest.runSequence > r.lastRunSequence)) {
    return fail(400, "INVALID_REQUEST", "lastRunSequence is below telemetry already accepted.");
  }

  await ctx.db.patch(run._id, {
    state: "completed",
    endedAtMs: nowMs,
    endRequestId: r.requestId,
    endCapturedAtMs: r.capturedAtMs,
    lastRunSequence: r.lastRunSequence,
    endedByDriverUserId: grant.driverUserId,
    endGrantId: grant._id,
  });
  // A completed run's alerts are obsolete; stop their delivery jobs now.
  await stopJobsForRun(ctx, run._id, nowMs);
  await ctx.db.insert("auditLog", {
    actor: { kind: "device", deviceId: device._id },
    action: "runs.end",
    resourceType: "runs",
    resourceId: run._id,
    result: "allowed",
    atMs: nowMs,
  });
  const ended = await ctx.db.get(run._id);
  if (!ended) throw new Error("run vanished inside its own transaction");
  return accepted(ended, "endRun", r.requestId, nowMs);
}
