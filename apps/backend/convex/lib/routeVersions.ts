import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The approved route version a new run must pin (docs/15 §8, docs/12 §4).
 *
 * Run start (owned by the run lifecycle work) stores the returned ID in
 * `runs.routeVersionId` once, at creation. A later approval changes only
 * `routes.currentVersionId`, so a run already started keeps its version, and
 * approved versions are never edited.
 */
export async function approvedVersionForNewRun(
  ctx: QueryCtx | MutationCtx,
  routeId: Id<"routes">,
): Promise<Id<"routeVersions"> | null> {
  const route = await ctx.db.get(routeId);
  return route?.currentVersionId ?? null;
}
