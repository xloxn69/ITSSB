import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, type QueryCtx } from "./_generated/server";
import { generateDeviceSecret, sha256Hex } from "./lib/deviceAuth";

/**
 * Driver operating grants (docs/07 §6, docs/08 §6).
 *
 * For now an administrator issues one with
 * `bunx convex run driverGrants:issue` for a known driver, device, and route
 * versions; the dev seed issues one too. The planned
 * `POST /device/v1/driver-session` (docs/08 §7) will issue them after driver
 * sign-in on the Pi. Either way the grant is server-issued, short-lived,
 * scoped, revocable, and stored only as a hash.
 */

/** Longest grant this function will issue: one long school day. */
export const MAX_GRANT_TTL_MS = 16 * 60 * 60 * 1000;

/**
 * Issues a grant and returns the secret once. An action, so the secret comes
 * from real randomness rather than a mutation's deterministic seed.
 */
export const issue = internalAction({
  args: {
    deviceId: v.id("devices"),
    driverUserId: v.id("users"),
    routeVersionIds: v.array(v.id("routeVersions")),
    ttlMs: v.number(),
  },
  handler: async (ctx, args): Promise<{ grant: string; expiresAtMs: number }> => {
    const grant = generateDeviceSecret();
    const expiresAtMs: number = await ctx.runMutation(internal.driverGrants.insert, {
      ...args,
      tokenHash: await sha256Hex(grant),
      nowMs: Date.now(),
    });
    return { grant, expiresAtMs };
  },
});

export const insert = internalMutation({
  args: {
    tokenHash: v.string(),
    deviceId: v.id("devices"),
    driverUserId: v.id("users"),
    routeVersionIds: v.array(v.id("routeVersions")),
    ttlMs: v.number(),
    nowMs: v.number(),
  },
  handler: async (ctx, { tokenHash, deviceId, driverUserId, routeVersionIds, ttlMs, nowMs }) => {
    if (!(ttlMs > 0 && ttlMs <= MAX_GRANT_TTL_MS)) throw new ConvexError({ code: "INVALID_TTL" });
    if (routeVersionIds.length === 0) throw new ConvexError({ code: "NO_ROUTE_VERSIONS" });
    const [device, driver] = await Promise.all([ctx.db.get(deviceId), ctx.db.get(driverUserId)]);
    if (!device || device.revoked) throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
    if (!driver || driver.role !== "driver") throw new ConvexError({ code: "NOT_A_DRIVER" });
    for (const id of routeVersionIds) {
      if (!(await ctx.db.get(id))) throw new ConvexError({ code: "UNKNOWN_ROUTE_VERSION" });
    }
    const expiresAtMs = nowMs + ttlMs;
    const grantId = await ctx.db.insert("driverGrants", {
      tokenHash,
      deviceId,
      driverUserId,
      routeVersionIds,
      issuedAtMs: nowMs,
      expiresAtMs,
      revoked: false,
    });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "driverGrants.issue",
      resourceType: "driverGrants",
      resourceId: grantId,
      result: "allowed",
      atMs: nowMs,
    });
    return expiresAtMs;
  },
});

export const revoke = internalMutation({
  args: { grantId: v.id("driverGrants") },
  handler: async (ctx, { grantId }) => {
    await ctx.db.patch(grantId, { revoked: true });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "driverGrants.revoke",
      resourceType: "driverGrants",
      resourceId: grantId,
      result: "allowed",
      atMs: Date.now(),
    });
  },
});

/**
 * The grant behind `tokenHash` if it belongs to this device, is not revoked,
 * and its driver is still a driver. Expiry is checked by the caller, because
 * an exact retry of an already accepted request is honored after expiry.
 */
export async function grantForDevice(
  ctx: QueryCtx,
  tokenHash: string,
  device: Doc<"devices">,
): Promise<Doc<"driverGrants"> | null> {
  const grant = await ctx.db
    .query("driverGrants")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!grant || grant.revoked || grant.deviceId !== device._id) return null;
  const driver = await ctx.db.get(grant.driverUserId);
  if (!driver || driver.role !== "driver") return null;
  return grant;
}
