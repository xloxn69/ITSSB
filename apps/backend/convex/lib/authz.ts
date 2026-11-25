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
