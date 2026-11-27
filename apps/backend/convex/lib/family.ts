import { SCHEMA_VERSION, type TokenProblem } from "@itssb/contracts";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The verified sign-in identity of a family applicant, or null.
 *
 * Enrollment and guardian-link requests come from people who have no
 * approved `users` row yet, so they are keyed by the identity provider's
 * `tokenIdentifier`. The identity grants nothing by itself: tracking still
 * goes through `getUser` and approved assignments (lib/authz.ts).
 */
export async function callerIdentity(ctx: QueryCtx | MutationCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier ?? null;
}

export function tokenProblem(problem: TokenProblem) {
  return { schemaVersion: SCHEMA_VERSION, status: "token_problem" as const, serverNowMs: Date.now(), problem };
}

/** Trimmed text within bounds, or null. */
export function boundedText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

/** A client request identity: 8 to 100 URL-safe characters. */
export function isRequestId(raw: string): boolean {
  return /^[A-Za-z0-9_-]{8,100}$/.test(raw);
}

/**
 * The approved family account for `tokenIdentifier`, creating it if absent.
 * Called only from staff approval. Refuses an identity that already belongs
 * to a staff or driver account: approval never changes someone's role.
 */
export async function approvedFamilyUser(
  ctx: MutationCtx,
  tokenIdentifier: string,
  displayName: string,
): Promise<Doc<"users"> | null> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  if (existing) return existing.role === "family" ? existing : null;
  const id: Id<"users"> = await ctx.db.insert("users", { tokenIdentifier, role: "family", displayName });
  return await ctx.db.get(id);
}

/** Stop label lookup that tolerates a missing row. */
export async function stopLabel(ctx: QueryCtx, stopId: Id<"stops"> | undefined): Promise<string | null> {
  if (!stopId) return null;
  return (await ctx.db.get(stopId))?.label ?? null;
}
