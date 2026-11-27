import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { generateDeviceSecret, sha256Hex } from "./lib/deviceAuth";

/** Looks up a non-revoked device by the hash of its bearer credential. */
export const byCredentialHash = internalQuery({
  args: { credentialHash: v.string() },
  handler: async (ctx, { credentialHash }) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_credential_hash", (q) => q.eq("credentialHash", credentialHash))
      .unique();
    return device && !device.revoked ? device._id : null;
  },
});

/**
 * Issues a new credential for an existing, non-revoked device and returns the
 * secret once (docs/04 §4: rotation is an administrator step). Only its hash
 * is stored; the previous secret stops working immediately.
 *
 *     bunx convex run devices:rotateCredential '{"deviceId":"<devices id>"}'
 *
 * Put the printed secret in the Pi's /etc/itssb/device.env as
 * ITSSB_DEVICE_TOKEN and restart the service. Internal: only someone holding
 * the deployment's admin access can run it.
 */
export const rotateCredential = internalAction({
  args: { deviceId: v.id("devices") },
  handler: async (ctx, { deviceId }): Promise<{ deviceSecret: string }> => {
    // An action, so the secret comes from real randomness.
    const deviceSecret = generateDeviceSecret();
    await ctx.runMutation(internal.devices.setCredentialHash, {
      deviceId,
      credentialHash: await sha256Hex(deviceSecret),
      nowMs: Date.now(),
    });
    return { deviceSecret };
  },
});

export const setCredentialHash = internalMutation({
  args: { deviceId: v.id("devices"), credentialHash: v.string(), nowMs: v.number() },
  handler: async (ctx, { deviceId, credentialHash, nowMs }) => {
    const device = await ctx.db.get(deviceId);
    // A revoked device stays revoked; rotation never revives it.
    if (!device || device.revoked) throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
    if (!/^[0-9a-f]{64}$/.test(credentialHash)) throw new ConvexError({ code: "INVALID_HASH" });
    await ctx.db.patch(deviceId, { credentialHash });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "devices.rotateCredential",
      resourceType: "devices",
      resourceId: deviceId,
      result: "allowed",
      atMs: nowMs,
    });
  },
});
