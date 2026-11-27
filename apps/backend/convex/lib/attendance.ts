import type { AttendanceStatus, CheckInRecord, CheckInSource } from "@itssb/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Attendance records (docs/09 §6–§9). One logical record per student, run
 * and phase: the first claim or staff record makes it, a repeat returns it,
 * and only an explicit correction adds a newer row. Rows are never edited
 * or deleted, so the history stays complete.
 */

export function toRecord(row: Doc<"checkIns">): CheckInRecord {
  return {
    checkInId: row._id,
    status: row.status,
    source: row.source,
    recordedAtMs: row.recordedAtMs,
    receivedAtMs: row.receivedAtMs,
  };
}

/** Every row for one student and run, oldest first. */
export async function historyFor(ctx: QueryCtx, runId: Id<"runs">, studentId: Id<"students">) {
  return await ctx.db
    .query("checkIns")
    .withIndex("by_run_student_phase", (q) => q.eq("runId", runId).eq("studentId", studentId).eq("phase", "boarding"))
    .collect();
}

/** The current row: the newest correction, else the first record. */
export function currentOf(history: Doc<"checkIns">[]): Doc<"checkIns"> | null {
  const corrections = history.filter((r) => r.source === "staff_correction");
  return corrections.at(-1) ?? history[0] ?? null;
}

export async function currentCheckIn(ctx: QueryCtx, runId: Id<"runs">, studentId: Id<"students">) {
  return currentOf(await historyFor(ctx, runId, studentId));
}

/**
 * Records attendance unless a record already exists, in which case that
 * record is returned (`already_recorded`). Never overwrites.
 */
export async function recordOnce(
  ctx: MutationCtx,
  fields: {
    run: Doc<"runs">;
    assignment: Doc<"assignments">;
    status: AttendanceStatus;
    source: Exclude<CheckInSource, "staff_correction">;
    recordedByUserId: Id<"users">;
    recordedAtMs: number;
    viaDeviceId?: Id<"devices">;
    challengeId?: Id<"scopedTokens">;
  },
): Promise<{ status: "accepted" | "already_recorded"; row: Doc<"checkIns"> }> {
  const existing = await currentCheckIn(ctx, fields.run._id, fields.assignment.studentId);
  if (existing) return { status: "already_recorded", row: existing };
  const id = await ctx.db.insert("checkIns", {
    runId: fields.run._id,
    studentId: fields.assignment.studentId,
    assignmentId: fields.assignment._id,
    phase: "boarding",
    status: fields.status,
    source: fields.source,
    recordedByUserId: fields.recordedByUserId,
    ...(fields.viaDeviceId ? { viaDeviceId: fields.viaDeviceId } : {}),
    ...(fields.challengeId ? { challengeId: fields.challengeId } : {}),
    recordedAtMs: fields.recordedAtMs,
    receivedAtMs: Date.now(),
  });
  return { status: "accepted", row: (await ctx.db.get(id)) as Doc<"checkIns"> };
}

/** Appends a correction naming the record it corrects; the original stays. */
export async function appendCorrection(
  ctx: MutationCtx,
  fields: {
    run: Doc<"runs">;
    assignment: Doc<"assignments">;
    status: AttendanceStatus;
    corrects: Doc<"checkIns">;
    reason: string;
    recordedByUserId: Id<"users">;
    recordedAtMs: number;
    viaDeviceId?: Id<"devices">;
  },
): Promise<Doc<"checkIns">> {
  const id = await ctx.db.insert("checkIns", {
    runId: fields.run._id,
    studentId: fields.assignment.studentId,
    assignmentId: fields.assignment._id,
    phase: "boarding",
    status: fields.status,
    source: "staff_correction",
    recordedByUserId: fields.recordedByUserId,
    ...(fields.viaDeviceId ? { viaDeviceId: fields.viaDeviceId } : {}),
    correctsCheckInId: fields.corrects._id,
    reason: fields.reason,
    recordedAtMs: fields.recordedAtMs,
    receivedAtMs: Date.now(),
  });
  return (await ctx.db.get(id)) as Doc<"checkIns">;
}

/** The stored receipt for `scope` + `requestId`, if any. */
export async function receiptFor(ctx: QueryCtx, scope: string, requestId: string) {
  return await ctx.db
    .query("requestReceipts")
    .withIndex("by_scope_request", (q) => q.eq("scope", scope).eq("requestId", requestId))
    .unique();
}

export async function storeReceipt(
  ctx: MutationCtx,
  receipt: Omit<Doc<"requestReceipts">, "_id" | "_creationTime" | "atMs">,
) {
  await ctx.db.insert("requestReceipts", { ...receipt, atMs: Date.now() });
}

/** Revokes an approved assignment; the student, links and history stay. */
export async function revokeAssignment(
  ctx: MutationCtx,
  assignment: Doc<"assignments">,
  by: Id<"users">,
  reason: string,
) {
  await ctx.db.patch(assignment._id, {
    status: "revoked",
    revokedAtMs: Date.now(),
    revokedByUserId: by,
    revokeReason: reason,
  });
}
