import { type ListStudentsResult, SCHEMA_VERSION, type StudentSummary } from "@itssb/contracts";
import { query } from "./_generated/server";
import { denied, staffCaller } from "./lib/staff";

/**
 * Staff student list (docs/12): each student's assignments and guardian
 * links, for issuing guardian invitations and reviewing access. No
 * addresses: those stay on the enrollment request.
 */
export const list = query({
  args: {},
  handler: async (ctx): Promise<ListStudentsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const students: StudentSummary[] = [];
    for (const student of await ctx.db.query("students").take(500)) {
      const assignments: StudentSummary["assignments"] = [];
      for (const a of await ctx.db.query("assignments").withIndex("by_student", (q) => q.eq("studentId", student._id)).collect()) {
        const version = await ctx.db.get(a.routeVersionId);
        const route = version?.routeId ? await ctx.db.get(version.routeId) : null;
        const stop = await ctx.db.get(a.stopId);
        assignments.push({
          assignmentId: a._id,
          routeLabel: route?.label ?? version?.label ?? "Route",
          direction: route?.direction ?? null,
          stopLabel: stop?.label ?? "Stop",
          status: a.status,
        });
      }
      const guardians: StudentSummary["guardians"] = [];
      for (const link of await ctx.db.query("guardianLinks").withIndex("by_student", (q) => q.eq("studentId", student._id)).collect()) {
        const guardian = await ctx.db.get(link.guardianUserId);
        guardians.push({ guardianLinkId: link._id, guardianName: guardian?.displayName ?? "Guardian", status: link.status });
      }
      students.push({ studentId: student._id, displayName: student.displayName, hasOwnAccount: student.userId !== undefined, assignments, guardians });
    }
    students.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), students };
  },
});
