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

/**
 * Whether a run may start on this version now. A version superseded by a
 * later approval is refused, even if an older driver grant still names it.
 * Versions created before route review existed (no `routeId`) stay allowed.
 * Run start (`/device/v1/trip-events`) should call this before creating a run.
 */
export async function isApprovedForNewRuns(
  ctx: QueryCtx | MutationCtx,
  versionId: Id<"routeVersions">,
): Promise<boolean> {
  const version = await ctx.db.get(versionId);
  if (!version) return false;
  if (!version.routeId) return true;
  return (await approvedVersionForNewRun(ctx, version.routeId)) === versionId;
}
