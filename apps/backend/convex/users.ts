import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Placeholder `tokenIdentifier` for an approved person who has not signed in
 * yet. Convex identities are always `issuer|subject`, so it can never match.
 */
export const UNLINKED_PREFIX = "unlinked:";

/**
 * Attaches a verified sign-in identity to an approved `users` row.
 *
 * Signing in proves who someone is; it grants nothing (docs/11 §1). Access
 * comes only from a staff-approved `users` row and its assignments and
 * guardian links. Internal: run by an administrator with
 * `bunx convex run users:linkIdentity` against the intended deployment.
 *
 * `tokenIdentifier` is what Convex derives from the verified token:
 * `<CLERK_JWT_ISSUER_DOMAIN>|<Clerk user ID>`. One identity maps to at most
 * one person, and an account already linked is never silently re-pointed.
 */
export const linkIdentity = internalMutation({
  args: { userId: v.id("users"), tokenIdentifier: v.string() },
  handler: async (ctx, { userId, tokenIdentifier }) => {
    if (!/^https:\/\/[^|\s]+\|[^|\s]+$/.test(tokenIdentifier)) {
      throw new ConvexError({ code: "INVALID_TOKEN_IDENTIFIER" });
    }
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError({ code: "USER_NOT_FOUND" });
    if (user.tokenIdentifier === tokenIdentifier) return { userId, changed: false };
    const taken = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .first();
    if (taken) throw new ConvexError({ code: "IDENTITY_ALREADY_LINKED" });
    if (!user.tokenIdentifier.startsWith(UNLINKED_PREFIX)) {
      throw new ConvexError({ code: "USER_ALREADY_LINKED" });
    }
    await ctx.db.patch(userId, { tokenIdentifier });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "users.linkIdentity",
      resourceType: "users",
      resourceId: userId,
      result: "allowed",
      atMs: Date.now(),
    });
    return { userId, changed: true };
  },
});
