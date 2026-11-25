import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

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
