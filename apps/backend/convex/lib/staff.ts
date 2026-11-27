import { type AccessUnavailable, type AccessUnavailableReason, SCHEMA_VERSION } from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getUser, missingUserReason } from "./authz";

/**
 * Staff console access (docs/12 §1, docs/08 §11). Every staff function calls
 * `staffCaller` first and returns `denied(...)` when it fails, before reading
 * anything else, so a non-staff caller learns nothing about what exists.
 *
 * V1 has one organization; when organizations arrive, scope staff here.
 */
export async function staffCaller(
  ctx: QueryCtx | MutationCtx,
): Promise<{ ok: true; user: Doc<"users"> } | { ok: false; reason: AccessUnavailableReason; user: Doc<"users"> | null }> {
  const user = await getUser(ctx);
  if (!user) return { ok: false, reason: await missingUserReason(ctx), user: null };
  if (user.role !== "staff") return { ok: false, reason: "not_permitted", user };
  return { ok: true, user };
}

export function denied(reason: AccessUnavailableReason): AccessUnavailable {
  return { schemaVersion: SCHEMA_VERSION, status: "access_unavailable", serverNowMs: Date.now(), reason };
}

export const accessUnavailable = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("access_unavailable"),
  serverNowMs: v.number(),
  reason: v.union(v.literal("unauthenticated"), v.literal("not_permitted")),
});

/**
 * Appends an audit row. Staff mutations return typed results instead of
 * throwing, so a denied attempt by a signed-in person is recorded too
 * (a thrown error would roll the row back).
 */
export async function audit(
  ctx: MutationCtx,
  user: Doc<"users"> | null,
  action: string,
  resourceType: string,
  resourceId: string | undefined,
  result: "allowed" | "denied",
  extra: AuditExtra = {},
) {
  if (!user) return; // An anonymous caller has no actor to record.
  await insertAudit(ctx, { kind: "user", userId: user._id }, action, resourceType, resourceId, result, extra);
}

export type AuditExtra = {
  /** Why: a removal, rejection, or correction reason. Never a token or an address. */
  reason?: string;
  source?: "staff_web" | "family_app" | "driver_device";
  viaDeviceId?: Id<"devices">;
  capturedAtMs?: number;
};

export type AuditActor =
  | { kind: "user"; userId: Id<"users"> }
  | { kind: "device"; deviceId: Id<"devices"> }
  | { kind: "system" }
  | { kind: "identity"; tokenIdentifier: string };

export async function insertAudit(
  ctx: MutationCtx,
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string | undefined,
  result: "allowed" | "denied",
  extra: AuditExtra = {},
) {
  await ctx.db.insert("auditLog", {
    actor,
    action,
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    result,
    atMs: Date.now(),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.viaDeviceId ? { viaDeviceId: extra.viaDeviceId } : {}),
    ...(extra.capturedAtMs !== undefined ? { capturedAtMs: extra.capturedAtMs } : {}),
  });
}
