import { type AuditEntry, type ListAuditResult, SCHEMA_VERSION } from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { denied, staffCaller } from "./lib/staff";

/**
 * Staff audit view (docs/09 §10, docs/11 §7): who did what, to which
 * record, when, from where, and with what result. Rows never hold tokens
 * or addresses, so nothing private is shown here.
 */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<ListAuditResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const n = Math.min(Math.max(Math.floor(limit ?? 100), 1), 200);
    const rows = await ctx.db.query("auditLog").withIndex("by_at").order("desc").take(n);
    const entries: AuditEntry[] = [];
    for (const row of rows) {
      entries.push({
        auditId: row._id,
        atMs: row.atMs,
        actorName: await actorName(ctx, row.actor),
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? null,
        result: row.result,
        reason: row.reason ?? null,
        source: row.source ?? null,
        capturedAtMs: row.capturedAtMs ?? null,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), entries };
  },
});

async function actorName(ctx: QueryCtx, actor: Doc<"auditLog">["actor"]): Promise<string> {
  switch (actor.kind) {
    case "user":
      return (await ctx.db.get(actor.userId))?.displayName ?? "Unknown person";
    case "device":
      return `device:${(await ctx.db.get(actor.deviceId))?.label ?? "unknown"}`;
    case "identity":
      return "Applicant (not yet approved)";
    default:
      return "system";
  }
}
