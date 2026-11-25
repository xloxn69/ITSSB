import { v } from "convex/values";
import { query } from "./_generated/server";
import { canViewRun, getUser } from "./lib/authz";

/**
 * Live position for one run, for signed-in clients.
 *
 * Returns null both when the run doesn't exist and when the caller may not
 * see it, so the response never reveals whether an unrelated run exists.
 * The client computes the position's age from `capturedAtMs`; never present
 * this as "live" without showing that age.
 */
export const live = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const user = await getUser(ctx);
    const id = ctx.db.normalizeId("runs", runId);
    if (!user || !id) return null;
    if (!(await canViewRun(ctx, user, id))) return null;

    const run = await ctx.db.get(id);
    if (!run) return null;
    const position = await ctx.db
      .query("liveState")
      .withIndex("by_run", (q) => q.eq("runId", id))
      .unique();

    return {
      runId: run._id,
      state: run.state,
      position: position
        ? {
            latitude: position.latitude,
            longitude: position.longitude,
            speedMps: position.speedMps,
            headingDegrees: position.headingDegrees,
            capturedAtMs: position.capturedAtMs,
            receivedAtMs: position.receivedAtMs,
          }
        : null,
    };
  },
});
