import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Resolves the signed-in person, or null.
 *
 * Fails closed: an identity with no `users` row (not yet provisioned or
 * approved) is treated as signed out. A new account has no implied access.
 */
export async function getUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await getUser(ctx);
  if (!user) throw new ConvexError({ code: "UNAUTHENTICATED" });
  return user;
}

/**
 * Whether `user` may see a run's live position.
 *
 * V1 milestone: staff only. Guardian/student access arrives with verified
 * family links and assignments (docs/09); add it here, in one place, so every
 * query that exposes run data inherits the same rule.
 */
export async function canViewRun(
  _ctx: QueryCtx,
  user: Doc<"users">,
  _runId: Id<"runs">,
): Promise<boolean> {
  return user.role === "staff";
}

export type AssignmentAccess = {
  assignment: Doc<"assignments">;
  student: Doc<"students">;
  relationship: "self" | "guardian";
};

/**
 * Resolves an assignment the signed-in person may track, or null.
 *
 * Allowed only for the student's own account or an approved guardian link,
 * and only while the assignment itself is approved. Unknown, malformed,
 * revoked, and forbidden IDs all return null, so the caller cannot tell them
 * apart (docs/08 §5: no existence leaks). Family tracking never trusts a
 * caller-supplied role or student ID.
 */
export async function getTrackableAssignment(
  ctx: QueryCtx,
  user: Doc<"users">,
  rawAssignmentId: string,
): Promise<AssignmentAccess | null> {
  const id = ctx.db.normalizeId("assignments", rawAssignmentId);
  if (!id) return null;
  const assignment = await ctx.db.get(id);
  if (!assignment || assignment.status !== "approved") return null;
  const student = await ctx.db.get(assignment.studentId);
  if (!student) return null;
  if (student.userId === user._id) return { assignment, student, relationship: "self" };
  const link = await ctx.db
    .query("guardianLinks")
    .withIndex("by_guardian_student", (q) =>
      q.eq("guardianUserId", user._id).eq("studentId", student._id),
    )
    .first();
  if (link?.status === "approved") return { assignment, student, relationship: "guardian" };
  return null;
}

/** Every approved assignment the signed-in person may track. */
export async function listTrackableAssignments(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<AssignmentAccess[]> {
  const own = await ctx.db
    .query("students")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  const links = await ctx.db
    .query("guardianLinks")
    .withIndex("by_guardian", (q) => q.eq("guardianUserId", user._id))
    .collect();
  const sources: { studentId: Id<"students">; relationship: "self" | "guardian" }[] = [
    ...own.map((s) => ({ studentId: s._id, relationship: "self" as const })),
    ...links
      .filter((l) => l.status === "approved")
      .map((l) => ({ studentId: l.studentId, relationship: "guardian" as const })),
  ];
  const result: AssignmentAccess[] = [];
  for (const { studentId, relationship } of sources) {
    const student = await ctx.db.get(studentId);
    if (!student) continue;
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_student", (q) => q.eq("studentId", studentId))
      .collect();
    for (const assignment of assignments) {
      if (assignment.status === "approved") result.push({ assignment, student, relationship });
    }
  }
  return result;
}
