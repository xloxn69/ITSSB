import { MAX_PERSON_NAME_LENGTH } from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";

// The Convex runtime provides `process.env`.
declare const process: { env: Record<string, string | undefined> };

/**
 * Placeholder `tokenIdentifier` for an approved person who has not signed in
 * yet. Convex identities are always `issuer|subject`, so it can never match.
 */
export const UNLINKED_PREFIX = "unlinked:";

/** `<issuer URL>|<subject>`, the shape Convex derives from a verified token. */
const TOKEN_IDENTIFIER_RE = /^https:\/\/[^|\s]+\|[^|\s]+$/;

/**
 * Attaches a verified sign-in identity to an approved `users` row.
 *
 * Signing in proves who someone is; it grants nothing (docs/11 §1). Access
 * comes only from a staff-approved `users` row and its assignments and
 * guardian links. Internal: run by an administrator with
 * `bunx convex run users:linkIdentity` against the intended deployment, for
 * a row created ahead of sign-in (the dev seed's people). New staff join
 * through a staff invitation (staffInvitations.ts) instead.
 *
 * `tokenIdentifier` is what Convex derives from the verified token:
 * `<CLERK_JWT_ISSUER_DOMAIN>|<Clerk user ID>`. One identity maps to at most
 * one person, and an account already linked is never silently re-pointed.
 */
export const linkIdentity = internalMutation({
  args: { userId: v.id("users"), tokenIdentifier: v.string() },
  handler: async (ctx, { userId, tokenIdentifier }) => {
    if (!TOKEN_IDENTIFIER_RE.test(tokenIdentifier)) {
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

/**
 * Creates the very first staff account on a deployment, linked to a verified
 * sign-in identity. Internal: the one command-line step an owner runs, with
 * `bunx convex run users:bootstrapStaff`. Every later staff member joins
 * through a staff invitation that an existing staff member issues.
 *
 * Refuses an identity already linked to anyone, so it never re-points or
 * promotes an existing account, and refuses once any staff account exists.
 */
export const bootstrapStaff = internalMutation({
  args: { tokenIdentifier: v.string(), displayName: v.string() },
  handler: async (ctx, { tokenIdentifier, displayName }) => {
    if (!TOKEN_IDENTIFIER_RE.test(tokenIdentifier)) {
      throw new ConvexError({ code: "INVALID_TOKEN_IDENTIFIER" });
    }
    const name = displayName.trim();
    if (!name || name.length > MAX_PERSON_NAME_LENGTH) throw new ConvexError({ code: "INVALID_DISPLAY_NAME" });
    const taken = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
      .first();
    if (taken) throw new ConvexError({ code: "IDENTITY_ALREADY_LINKED" });
    // First account only: once staff exist, more staff join by invitation, so
    // a rerun can never quietly add a staff member. A development deployment
    // that allows the fictional seed may add one more, because its seeded
    // staff row has no identity anyone can sign in with.
    const anyStaff = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "staff"))
      .first();
    if (anyStaff && process.env.ITSSB_ALLOW_DEV_SEED !== "true") {
      throw new ConvexError({ code: "STAFF_ALREADY_EXISTS" });
    }
    const userId = await ctx.db.insert("users", { tokenIdentifier, role: "staff", displayName: name });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "users.bootstrapStaff",
      resourceType: "users",
      resourceId: userId,
      result: "allowed",
      atMs: Date.now(),
    });
    return { userId };
  },
});
