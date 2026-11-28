import {
  type CreateStaffInvitationResult,
  type ListStaffInvitationsResult,
  MAX_PERSON_NAME_LENGTH,
  MAX_STAFF_INVITATION_TTL_MS,
  MIN_INVITATION_TTL_MS,
  type RedeemStaffInvitationResult,
  type RevokeStaffInvitationResult,
  SCHEMA_VERSION,
  type StaffInvitationSummary,
} from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { audit, denied, insertAudit, staffCaller } from "./lib/staff";
import { boundedText, okResult, refusedResult } from "./lib/staffResults";
import { generateToken, resolveToken, tokenHash } from "./lib/tokens";

/**
 * Staff invitations (docs/12 §1). An existing staff member issues a
 * single-use, expiring code for a named person; that person signs in and
 * redeems it, which creates their staff account linked to that sign-in.
 * Only the code's hash is stored. The very first staff account on a
 * deployment comes from `users:bootstrapStaff` instead.
 */

const now = () => Date.now();
const PURPOSE = "staff_invitation" as const;

export const create = action({
  args: { displayName: v.string(), ttlMs: v.number() },
  handler: async (ctx, args): Promise<CreateStaffInvitationResult> => {
    const token = generateToken();
    const result: CreateStaffInvitationResult = await ctx.runMutation(internal.staffInvitations.insert, {
      ...args,
      tokenHash: (await tokenHash(token)) as string,
    });
    return result.status === "created" ? { ...result, token } : result;
  },
});

/** Returns `created` without the token; the action adds it. */
export const insert = internalMutation({
  args: { tokenHash: v.string(), displayName: v.string(), ttlMs: v.number() },
  handler: async (ctx, { tokenHash: hash, displayName, ttlMs }): Promise<CreateStaffInvitationResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "staffInvitation.create", "scopedTokens", undefined, "denied");
      return denied(caller.reason);
    }
    const name = boundedText(displayName, MAX_PERSON_NAME_LENGTH);
    if (!name) {
      return refusedResult("invalid_name", `Use 1 to ${MAX_PERSON_NAME_LENGTH} characters for the name.`) as CreateStaffInvitationResult;
    }
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_INVITATION_TTL_MS || ttlMs > MAX_STAFF_INVITATION_TTL_MS) {
      return refusedResult("invalid_ttl", "Choose a lifetime between one hour and 7 days.") as CreateStaffInvitationResult;
    }
    const t = now();
    const invitationId = await ctx.db.insert("scopedTokens", {
      tokenHash: hash,
      purpose: PURPOSE,
      displayName: name,
      issuedByUserId: caller.user._id,
      issuedAtMs: t,
      expiresAtMs: t + ttlMs,
      revoked: false,
      singleUse: true,
    });
    await audit(ctx, caller.user, "staffInvitation.create", "scopedTokens", invitationId, "allowed", { source: "staff_web" });
    return { schemaVersion: SCHEMA_VERSION, status: "created", serverNowMs: t, invitationId, token: "", expiresAtMs: t + ttlMs };
  },
});

export const list = query({
  args: {},
  handler: async (ctx): Promise<ListStaffInvitationsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const rows = await ctx.db
      .query("scopedTokens")
      .withIndex("by_purpose", (q) => q.eq("purpose", PURPOSE))
      .order("desc")
      .take(100);
    const invitations: StaffInvitationSummary[] = [];
    for (const row of rows) {
      const issuer = row.issuedByUserId ? await ctx.db.get(row.issuedByUserId) : null;
      invitations.push({
        invitationId: row._id,
        displayName: row.displayName ?? "Staff member",
        issuedAtMs: row.issuedAtMs,
        issuedByName: issuer?.displayName ?? null,
        expiresAtMs: row.expiresAtMs,
        revoked: row.revoked,
        usedAtMs: row.usedAtMs ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: now(), invitations };
  },
});

/** Revokes a staff invitation. Idempotent. An account already created stays. */
export const revoke = mutation({
  args: { invitationId: v.string() },
  handler: async (ctx, { invitationId }): Promise<RevokeStaffInvitationResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "staffInvitation.revoke", "scopedTokens", invitationId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("scopedTokens", invitationId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.purpose !== PURPOSE) return refusedResult<"not_found">("not_found", "That invitation doesn't exist.");
    if (!row.revoked) {
      await ctx.db.patch(row._id, { revoked: true });
      await audit(ctx, caller.user, "staffInvitation.revoke", "scopedTokens", row._id, "allowed", { source: "staff_web" });
    }
    return okResult<"not_found">();
  },
});

const refused = (
  code: "invalid_code" | "already_linked" | "identity_unverified",
  message: string,
): RedeemStaffInvitationResult => ({ schemaVersion: SCHEMA_VERSION, status: "refused", serverNowMs: now(), code, message });

/** One answer for every unusable code, so it reveals nothing about the code. */
const INVALID_CODE = "This code can't be used. Ask the person who invited you for a new one.";

/**
 * Redeems a staff invitation for the signed-in person. Requires a verified
 * identity that is not linked to any account, so it never re-points or
 * promotes an existing account. A retry by the person who already redeemed
 * the code answers `joined` again without a second account.
 */
export const redeem = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<RedeemStaffInvitationResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return denied("unauthenticated");
    const me = identity.tokenIdentifier;
    const actor = { kind: "identity" as const, tokenIdentifier: me };
    const deny = async (resourceId: string | undefined, code: "invalid_code" | "already_linked" | "identity_unverified", message: string) => {
      await insertAudit(ctx, actor, "staffInvitation.redeem", "scopedTokens", resourceId, "denied", { source: "family_app" });
      return refused(code, message);
    };
    // A sign-in whose provider says the email is unverified never becomes staff.
    if (identity.emailVerified === false) {
      return deny(undefined, "identity_unverified", "Verify your email address, then try again.");
    }

    const hash = await tokenHash(token);
    const row = hash
      ? await ctx.db
          .query("scopedTokens")
          .withIndex("by_token_hash", (q) => q.eq("tokenHash", hash))
          .unique()
      : null;
    const account = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", me))
      .unique();

    // An exact retry by the person who redeemed it: same answer, no second account.
    if (row?.purpose === PURPOSE && row.usedByTokenIdentifier === me && account?.role === "staff") {
      return { schemaVersion: SCHEMA_VERSION, status: "joined", serverNowMs: now(), displayName: account.displayName };
    }
    if (account) {
      return deny(undefined, "already_linked", "This sign-in already belongs to an account. Sign in with a different email to join as staff.");
    }

    const resolved = await resolveToken(ctx, token, PURPOSE, now());
    if (!resolved.ok || resolved.token.usedAtMs !== undefined) return deny(undefined, "invalid_code", INVALID_CODE);
    const invitation = resolved.token;

    const t = now();
    const displayName = invitation.displayName ?? "Staff member";
    const userId = await ctx.db.insert("users", { tokenIdentifier: me, role: "staff", displayName });
    await ctx.db.patch(invitation._id, { usedAtMs: t, usedByTokenIdentifier: me });
    await insertAudit(ctx, actor, "staffInvitation.redeem", "users", userId, "allowed", { source: "family_app" });
    return { schemaVersion: SCHEMA_VERSION, status: "joined", serverNowMs: t, displayName };
  },
});
