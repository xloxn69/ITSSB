import {
  type AssignmentCheckInResult,
  type CheckInRejection,
  type RecentRun,
  type RecentRunsResult,
  type RecordCheckInResult,
  type RunAttendanceResult,
  type RunAttendanceStudent,
  SCHEMA_VERSION,
  type StaffActionResult,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { currentCheckIn, currentOf, historyFor, receiptFor, recordOnce, storeReceipt, toRecord } from "./lib/attendance";
import { getTrackableAssignment, getUser, missingUserReason } from "./lib/authz";
import { isRequestId, tokenProblem } from "./lib/family";
import { audit, denied, staffCaller } from "./lib/staff";
import { resolveToken } from "./lib/tokens";
import { reportsForRun, staffReports } from "./runReports";

/**
 * Trip check-in (docs/09 §6–§8). A student scans the challenge shown on the
 * bus; the server derives who they are from the session, never from an
 * argument. One displayed challenge serves every eligible student; each
 * student gets one logical record per run.
 */

const now = () => Date.now();

function rejected(code: CheckInRejection, message: string): RecordCheckInResult {
  return { schemaVersion: SCHEMA_VERSION, status: "rejected", serverNowMs: now(), code, message };
}

/** The caller's own approved assignment on this run's route version, if any. */
async function ownAssignmentOn(ctx: QueryCtx, user: Doc<"users">, run: Doc<"runs">) {
  const students = await ctx.db
    .query("students")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  for (const student of students) {
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .collect();
    const match = assignments.find((a) => a.status === "approved" && a.routeVersionId === run.routeVersionId);
    if (match) return match;
  }
  return null;
}

export const record = mutation({
  args: { requestId: v.string(), token: v.string(), runId: v.string() },
  handler: async (ctx, { requestId, token, runId }): Promise<RecordCheckInResult> => {
    const user = await getUser(ctx);
    if (!user) return denied(await missingUserReason(ctx));
    if (!isRequestId(requestId)) return rejected("invalid_request", "Scan the code again.");

    // A retry after a lost response returns the original outcome, even if
    // the challenge has expired since; it never makes a second record.
    const scope = `user:${user._id}`;
    const receipt = await receiptFor(ctx, scope, requestId);
    if (receipt) {
      if (receipt.fingerprint !== runId) return rejected("request_id_conflict", "Scan the code again.");
      const row = receipt.checkInId ? await ctx.db.get(receipt.checkInId) : null;
      if (row && (receipt.status === "accepted" || receipt.status === "already_recorded")) {
        return { schemaVersion: SCHEMA_VERSION, status: receipt.status, serverNowMs: now(), requestId, runId, checkIn: toRecord(row) };
      }
    }

    const resolved = await resolveToken(ctx, token, "trip_check_in", now());
    if (!resolved.ok) return tokenProblem(resolved.problem);
    const id = ctx.db.normalizeId("runs", runId);
    if (!id || resolved.token.runId !== id) {
      return rejected("wrong_run", "This code is for a different trip. Scan the code on your bus.");
    }
    const run = await ctx.db.get(id);
    if (!run || run.state !== "active") return rejected("run_not_active", "This trip isn't running now.");
    const assignment = await ownAssignmentOn(ctx, user, run);
    if (!assignment) {
      return rejected("not_assigned", "Your account isn't assigned to this route. Ask the driver to record you.");
    }

    const outcome = await recordOnce(ctx, {
      run,
      assignment,
      status: "boarded",
      source: "student_qr_claim",
      recordedByUserId: user._id,
      recordedAtMs: now(),
      challengeId: resolved.token._id,
    });
    await storeReceipt(ctx, { scope, requestId, fingerprint: runId, status: outcome.status, checkInId: outcome.row._id });
    if (outcome.status === "accepted") {
      await audit(ctx, user, "checkIn.studentClaim", "checkIns", outcome.row._id, "allowed", { source: "family_app" });
    }
    return { schemaVersion: SCHEMA_VERSION, status: outcome.status, serverNowMs: now(), requestId, runId, checkIn: toRecord(outcome.row) };
  },
});

/** The current check-in for a trackable assignment's active run (student or guardian). */
export const forAssignment = query({
  args: { assignmentId: v.string() },
  handler: async (ctx, { assignmentId }): Promise<AssignmentCheckInResult> => {
    const user = await getUser(ctx);
    if (!user) return denied(await missingUserReason(ctx));
    const access = await getTrackableAssignment(ctx, user, assignmentId);
    if (!access) return denied("not_permitted");
    const run = await ctx.db
      .query("runs")
      .withIndex("by_route_version_state", (q) =>
        q.eq("routeVersionId", access.assignment.routeVersionId as string).eq("state", "active"),
      )
      .first();
    const row = run ? await currentCheckIn(ctx, run._id, access.student._id) : null;
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: now(),
      assignmentId: access.assignment._id,
      runId: run?._id ?? null,
      checkIn: row ? toRecord(row) : null,
    };
  },
});

// MARK: Staff

function staffRefused(
  code: "not_found" | "run_not_active" | "reason_required" | "already_removed" | "correction_target_invalid",
  message: string,
): StaffActionResult {
  return { schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code, message };
}

/** Staff-recorded attendance for an active run: the no-phone fallback from the office. */
export const staffRecord = mutation({
  args: {
    runId: v.string(),
    assignmentId: v.string(),
    status: v.union(v.literal("boarded"), v.literal("not_boarded")),
  },
  handler: async (ctx, args): Promise<StaffActionResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "checkIn.staffRecord", "runs", args.runId, "denied");
      return denied(caller.reason);
    }
    const runId = ctx.db.normalizeId("runs", args.runId);
    const run = runId ? await ctx.db.get(runId) : null;
    const assignmentId = ctx.db.normalizeId("assignments", args.assignmentId);
    const assignment = assignmentId ? await ctx.db.get(assignmentId) : null;
    if (!run || !assignment || assignment.routeVersionId !== run.routeVersionId || assignment.status !== "approved") {
      return staffRefused("not_found", "That student isn't on this trip.");
    }
    if (run.state !== "active") return staffRefused("run_not_active", "This trip isn't running.");
    const outcome = await recordOnce(ctx, {
      run,
      assignment,
      status: args.status,
      source: "staff_recorded",
      recordedByUserId: caller.user._id,
      recordedAtMs: now(),
    });
    if (outcome.status === "accepted") {
      await audit(ctx, caller.user, "checkIn.staffRecord", "checkIns", outcome.row._id, "allowed", { source: "staff_web" });
    }
    return { schemaVersion: SCHEMA_VERSION, status: outcome.status, serverNowMs: now(), checkIn: toRecord(outcome.row) };
  },
});

export const runAttendance = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }): Promise<RunAttendanceResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const id = ctx.db.normalizeId("runs", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run) return { schemaVersion: SCHEMA_VERSION, status: "not_found", serverNowMs: now() };
    const versionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
    const version = versionId ? await ctx.db.get(versionId) : null;
    const route = version?.routeId ? await ctx.db.get(version.routeId) : null;
    const students: RunAttendanceStudent[] = [];
    if (versionId) {
      const assignments = await ctx.db
        .query("assignments")
        .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
        .collect();
      for (const a of assignments) {
        const history = await historyFor(ctx, run._id, a.studentId);
        // A removed student still shows if they have records on this run.
        if (a.status !== "approved" && history.length === 0) continue;
        const student = await ctx.db.get(a.studentId);
        const stop = await ctx.db.get(a.stopId);
        const current = currentOf(history);
        const names = new Map<Id<"users">, string | null>();
        const rows = [];
        for (const row of history) {
          if (!names.has(row.recordedByUserId)) {
            names.set(row.recordedByUserId, (await ctx.db.get(row.recordedByUserId))?.displayName ?? null);
          }
          rows.push({ ...toRecord(row), recordedByName: names.get(row.recordedByUserId) ?? null, reason: row.reason ?? null });
        }
        students.push({
          assignmentId: a._id,
          studentDisplayName: student?.displayName ?? "Student",
          stopLabel: stop?.label ?? "Stop",
          seatLabel: a.seatLabel ?? null,
          driverNote: a.driverNote ?? null,
          current: current ? toRecord(current) : null,
          history: rows,
        });
      }
    }
    students.sort((x, y) => x.studentDisplayName.localeCompare(y.studentDisplayName));
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: now(),
      runId: run._id,
      routeLabel: route?.label ?? version?.label ?? "Route",
      runState: run.state,
      startedAtMs: run.startedAtMs ?? null,
      students,
      reports: await staffReports(ctx, await reportsForRun(ctx, run._id)),
    };
  },
});

/** Recent runs with roster and boarded counts, newest first. */
export const recentRuns = query({
  args: {},
  handler: async (ctx): Promise<RecentRunsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const runs: RecentRun[] = [];
    for (const run of await ctx.db.query("runs").order("desc").take(30)) {
      const versionId = ctx.db.normalizeId("routeVersions", run.routeVersionId);
      const version = versionId ? await ctx.db.get(versionId) : null;
      const route = version?.routeId ? await ctx.db.get(version.routeId) : null;
      const device = await ctx.db.get(run.deviceId);
      const assignments = versionId
        ? (await ctx.db.query("assignments").withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId)).collect()).filter(
            (a) => a.status === "approved",
          )
        : [];
      let boarded = 0;
      const rows = await ctx.db.query("checkIns").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
      const byStudent = new Map<string, Doc<"checkIns">[]>();
      for (const row of rows) byStudent.set(row.studentId, [...(byStudent.get(row.studentId) ?? []), row]);
      for (const history of byStudent.values()) if (currentOf(history)?.status === "boarded") boarded++;
      runs.push({
        runId: run._id,
        routeLabel: route?.label ?? version?.label ?? "Route",
        busLabel: device?.busLabel ?? null,
        state: run.state,
        startedAtMs: run.startedAtMs ?? null,
        endedAtMs: run.endedAtMs ?? null,
        assignedCount: assignments.length,
        boardedCount: boarded,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), runs };
  },
});
