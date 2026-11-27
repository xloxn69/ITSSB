import { type AccessUnavailable, type AccessUnavailableReason, SCHEMA_VERSION } from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getUser } from "./authz";

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
  if (!user) return { ok: false, reason: "unauthenticated", user: null };
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
) {
  if (!user) return; // An anonymous caller has no actor to record.
  await ctx.db.insert("auditLog", {
    actor: { kind: "user", userId: user._id },
    action,
    resourceType,
    ...(resourceId ? { resourceId } : {}),
    result,
    atMs: Date.now(),
  });
}
