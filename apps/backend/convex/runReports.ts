import {
  MAX_FUTURE_SKEW_MS,
  MAX_RUN_REPORT_AGE_MS,
  REPORTED_DELAY_SHOWN_FOR_MS,
  type ReportedDelay,
  type RunReportRecord,
  type RunReportRejection,
  type RunReportRequest,
  type RunReportResult,
  SCHEMA_VERSION,
  type StaffRunReport,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import { authorizedDevice } from "./deviceDrafts";
import { grantForDevice } from "./driverGrants";
import { insertAudit } from "./lib/staff";

/**
 * Driver delay and issue reports from the Pi (docs/08 §9.4, docs/05 D20).
 *
 * Authority is rechecked here, for a report queued offline too: the device
 * credential is the one the request presented and is not revoked; the
 * driver operating grant belongs to this device, is current when the report
 * arrives, and was valid when the report was made; and the run is this
 * device's, on one of the grant's routes, and the report was made while it
 * was going. A report made during the run but arriving after the run ended
 * is still accepted (it was queued offline); families only ever see reports
 * on an active run.
 */

function record(row: Doc<"runReports">): RunReportRecord {
  return {
    reportId: row._id,
    runId: row.runId,
    category: row.category,
    expectedDelayMinutes: row.expectedDelayMinutes,
    capturedAtMs: row.capturedAtMs,
    receivedAtMs: row.receivedAtMs,
  };
}

export const submit = internalMutation({
  args: {
    deviceId: v.id("devices"),
    /** SHA-256 of the credential the request presented; rechecked here. */
    credentialHash: v.string(),
    grantHash: v.string(),
    // Validated by validateRunReport in http.ts.
    report: v.any(),
    nowMs: v.number(),
  },
  handler: async (ctx, { deviceId, credentialHash, grantHash, report, nowMs }): Promise<RunReportResult> => {
    const device = await authorizedDevice(ctx, deviceId, credentialHash);
    const r = report as RunReportRequest;
    const reject = async (code: RunReportRejection, message: string): Promise<RunReportResult> => {
      await insertAudit(ctx, { kind: "device", deviceId: device._id }, "run.report", "runReports", undefined, "denied", {
        source: "driver_device",
        capturedAtMs: r.capturedAtMs,
        reason: code,
      });
      return { schemaVersion: SCHEMA_VERSION, requestId: r.requestId, status: "rejected", code, message, serverNowMs: nowMs };
    };

    // A retry returns what was stored; the same requestId with other content is refused.
    const prior = await ctx.db
      .query("runReports")
      .withIndex("by_device_request", (q) => q.eq("deviceId", device._id).eq("requestId", r.requestId))
      .unique();
    if (prior) {
      const same =
        prior.runId === r.runId &&
        prior.category === r.category &&
        prior.expectedDelayMinutes === r.expectedDelayMinutes &&
        prior.capturedAtMs === r.capturedAtMs;
      if (!same) return reject("request_id_conflict", "This requestId was already used for a different report.");
      return { schemaVersion: SCHEMA_VERSION, requestId: r.requestId, status: "already_recorded", report: record(prior), serverNowMs: nowMs };
    }

    if (r.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS || nowMs - r.capturedAtMs > MAX_RUN_REPORT_AGE_MS) {
      return reject("capture_time_out_of_range", "The report's time is not plausible.");
    }
    const grant = await grantForDevice(ctx, grantHash, device);
    // Grant times are server times and the capture time is the Pi's clock:
    // allow the same skew as the rest of the device contract.
    if (
      !grant ||
      grant.expiresAtMs <= nowMs ||
      r.capturedAtMs < grant.issuedAtMs - MAX_FUTURE_SKEW_MS ||
      r.capturedAtMs > grant.expiresAtMs
    ) {
      return reject("grant_not_authorized", "The driver was not authorized for this when it was reported.");
    }
    const runId = ctx.db.normalizeId("runs", r.runId);
    const run = runId ? await ctx.db.get(runId) : null;
    if (
      !run ||
      run.deviceId !== device._id ||
      !grant.routeVersionIds.some((g) => g === run.routeVersionId) ||
      (run.state !== "active" && run.state !== "completed") ||
      run.startedAtMs === undefined ||
      // The start and end as captured on the same device clock; else the server's, with skew.
      r.capturedAtMs < (run.startCapturedAtMs ?? run.startedAtMs - MAX_FUTURE_SKEW_MS) ||
      r.capturedAtMs > (run.endCapturedAtMs ?? run.endedAtMs ?? Number.POSITIVE_INFINITY)
    ) {
      return reject("run_not_authorized", "This device is not authorized to report on that run.");
    }

    const id = await ctx.db.insert("runReports", {
      runId: run._id,
      deviceId: device._id,
      driverUserId: grant.driverUserId,
      grantId: grant._id,
      requestId: r.requestId,
      category: r.category,
      expectedDelayMinutes: r.expectedDelayMinutes,
      capturedAtMs: r.capturedAtMs,
      receivedAtMs: nowMs,
    });
    await insertAudit(ctx, { kind: "user", userId: grant.driverUserId }, "run.report", "runReports", id, "allowed", {
      source: "driver_device",
      viaDeviceId: device._id,
      capturedAtMs: r.capturedAtMs,
    });
    const row = await ctx.db.get(id);
    return { schemaVersion: SCHEMA_VERSION, requestId: r.requestId, status: "accepted", report: record(row!), serverNowMs: nowMs };
  },
});

/** A run's reports, newest made on the bus first. */
export async function reportsForRun(ctx: QueryCtx, runId: Id<"runs">): Promise<Doc<"runReports">[]> {
  const rows = await ctx.db
    .query("runReports")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .take(200);
  return rows.toSorted((a, b) => b.capturedAtMs - a.capturedAtMs || b.receivedAtMs - a.receivedAtMs);
}

/**
 * What a family may see on an active run: the newest report, category and
 * minutes only, while it is recent. Its time is when it was made on the
 * bus, so one that sat offline never reads as just reported.
 */
export async function familyReportedDelay(ctx: QueryCtx, run: Doc<"runs">, serverNowMs: number): Promise<ReportedDelay | null> {
  if (run.state !== "active") return null;
  const newest = (await reportsForRun(ctx, run._id))[0];
  if (!newest) return null;
  const reportedAtMs = Math.min(newest.capturedAtMs, newest.receivedAtMs);
  const validUntilMs = reportedAtMs + REPORTED_DELAY_SHOWN_FOR_MS;
  if (serverNowMs >= validUntilMs) return null;
  return { category: newest.category, minutes: newest.expectedDelayMinutes, reportedAtMs, validUntilMs, source: "driver" };
}

/** Reports as staff see them, with the reporting driver's name. */
export async function staffReports(ctx: QueryCtx, rows: Doc<"runReports">[]): Promise<StaffRunReport[]> {
  const names = new Map<Id<"users">, string | null>();
  const out: StaffRunReport[] = [];
  for (const row of rows) {
    if (!names.has(row.driverUserId)) names.set(row.driverUserId, (await ctx.db.get(row.driverUserId))?.displayName ?? null);
    out.push({ ...record(row), driverName: names.get(row.driverUserId) ?? null });
  }
  return out;
}
