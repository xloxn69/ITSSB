import {
  type DriverGrantSummary,
  type GrantableRouteVersion,
  type GrantIssuedResult,
  type GrantRefusalCode,
  type GrantRouteVersion,
  type ListDriverGrantsResult,
  MAX_GRANT_ROUTE_VERSIONS,
  type RevokeGrantResult,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { generateDeviceSecret, sha256Hex } from "./lib/deviceAuth";
import { isApprovedForNewRuns } from "./lib/routeVersions";
import { type AuditActor, type AuditExtra, audit, denied, insertAudit, staffCaller } from "./lib/staff";
import { okResult, refusedResult } from "./lib/staffResults";

/**
 * Driver operating grants (docs/07 §6, docs/08 §6).
 *
 * Staff issue one in the console (`issueForDriver`) for one driver, one
 * device and approved route versions, and install it in the Pi's drivers
 * file. The internal `issue` stays for the command line, and the dev seed
 * issues one too. The planned `POST /device/v1/driver-session` (docs/08 §7)
 * will issue them after driver sign-in on the Pi. Either way the grant is
 * server-issued, short-lived, scoped, revocable, and stored only as a hash.
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
  handler: async (ctx, args) => await insertGrant(ctx, args),
});

/** Checks and inserts one grant; shared by `insert` and the dev seed's single transaction. */
export async function insertGrant(
  ctx: MutationCtx,
  {
    tokenHash,
    deviceId,
    driverUserId,
    routeVersionIds,
    ttlMs,
    nowMs,
  }: {
    tokenHash: string;
    deviceId: Id<"devices">;
    driverUserId: Id<"users">;
    routeVersionIds: Id<"routeVersions">[];
    ttlMs: number;
    nowMs: number;
  },
): Promise<number> {
    if (!(ttlMs > 0 && ttlMs <= MAX_GRANT_TTL_MS)) throw new ConvexError({ code: "INVALID_TTL" });
    if (routeVersionIds.length === 0) throw new ConvexError({ code: "NO_ROUTE_VERSIONS" });
    const [device, driver] = await Promise.all([ctx.db.get(deviceId), ctx.db.get(driverUserId)]);
    if (!device || device.revoked) throw new ConvexError({ code: "DEVICE_NOT_AUTHORIZED" });
    if (!driver || driver.role !== "driver") throw new ConvexError({ code: "NOT_A_DRIVER" });
    for (const id of routeVersionIds) {
      if (!(await ctx.db.get(id))) throw new ConvexError({ code: "UNKNOWN_ROUTE_VERSION" });
    }
    const { expiresAtMs } = await writeGrant(ctx, { tokenHash, deviceId, driverUserId, routeVersionIds, ttlMs, nowMs }, { kind: "system" });
    return expiresAtMs;
}

/** Staff actions come from the console; command-line and seed actions have no source. */
const sourceOf = (actor: AuditActor): AuditExtra => (actor.kind === "user" ? { source: "staff_web" } : {});

/** Inserts an already checked grant and its audit row. */
async function writeGrant(
  ctx: MutationCtx,
  g: {
    tokenHash: string;
    deviceId: Id<"devices">;
    driverUserId: Id<"users">;
    routeVersionIds: Id<"routeVersions">[];
    ttlMs: number;
    nowMs: number;
  },
  actor: AuditActor,
): Promise<{ grantId: Id<"driverGrants">; expiresAtMs: number }> {
  const expiresAtMs = g.nowMs + g.ttlMs;
  const grantId = await ctx.db.insert("driverGrants", {
    tokenHash: g.tokenHash,
    deviceId: g.deviceId,
    driverUserId: g.driverUserId,
    routeVersionIds: g.routeVersionIds,
    issuedAtMs: g.nowMs,
    expiresAtMs,
    revoked: false,
    ...(actor.kind === "user" ? { issuedByUserId: actor.userId } : {}),
  });
  await insertAudit(ctx, actor, "driverGrants.issue", "driverGrants", grantId, "allowed", sourceOf(actor));
  return { grantId, expiresAtMs };
}

export const revoke = internalMutation({
  args: { grantId: v.id("driverGrants") },
  handler: async (ctx, { grantId }) => {
    const grant = await ctx.db.get(grantId);
    if (grant) await revokeGrant(ctx, grant, { kind: "system" });
  },
});

/**
 * Revokes a grant: the next trip event with it is refused, including the
 * end of a run it started (staff can cancel that run instead). Idempotent;
 * only the first revoke is audited.
 */
async function revokeGrant(ctx: MutationCtx, grant: Doc<"driverGrants">, actor: AuditActor) {
  if (grant.revoked) return;
  await ctx.db.patch(grant._id, { revoked: true });
  await insertAudit(ctx, actor, "driverGrants.revoke", "driverGrants", grant._id, "allowed", sourceOf(actor));
}

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

// ── Staff console (docs/12 §3) ───────────────────────────────────────
//
// Issuing is an action so the secret comes from real randomness; the staff
// check, the validation, the write and the audit row happen together in one
// internal mutation, which sees the caller's identity. Refusals are returned,
// not thrown, so a refused attempt keeps its audit row. The secret is
// returned once, to the staff member who asked, and never stored or logged.

type GrantWriteResult =
  | {
      status: "ok";
      grantId: string;
      expiresAtMs: number;
      driverUserId: string;
      driverName: string;
      deviceId: string;
      routeVersions: GrantRouteVersion[];
    }
  | Exclude<GrantIssuedResult, { status: "issued" }>;

const grantRefusal = (code: GrantRefusalCode, message: string) => refusedResult<GrantRefusalCode>(code, message) as Exclude<
  GrantIssuedResult,
  { status: "issued" } | { status: "access_unavailable" }
>;

/** Issues a grant for one driver, one device and approved route versions. */
export const issueForDriver = action({
  args: { driverUserId: v.string(), deviceId: v.string(), routeVersionIds: v.array(v.string()), ttlMs: v.number() },
  handler: async (ctx, args): Promise<GrantIssuedResult> => {
    const grant = generateDeviceSecret();
    const write: GrantWriteResult = await ctx.runMutation(internal.driverGrants.insertForStaff, {
      ...args,
      tokenHash: await sha256Hex(grant),
    });
    if (write.status !== "ok") return write;
    const { status: _ok, ...rest } = write;
    return { schemaVersion: SCHEMA_VERSION, status: "issued", serverNowMs: Date.now(), grant, ...rest };
  },
});

export const insertForStaff = internalMutation({
  args: {
    tokenHash: v.string(),
    driverUserId: v.string(),
    deviceId: v.string(),
    routeVersionIds: v.array(v.string()),
    ttlMs: v.number(),
  },
  handler: async (ctx, args): Promise<GrantWriteResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "driverGrants.issue", "driverGrants", undefined, "denied");
      return denied(caller.reason);
    }
    const refuse = async (code: GrantRefusalCode, message: string) => {
      await audit(ctx, caller.user, "driverGrants.issue", "driverGrants", undefined, "denied", { source: "staff_web" });
      return grantRefusal(code, message);
    };
    const driverId = ctx.db.normalizeId("users", args.driverUserId);
    const driver = driverId ? await ctx.db.get(driverId) : null;
    if (!driver || driver.role !== "driver") return refuse("driver_not_found", "That driver doesn't exist.");
    const deviceId = ctx.db.normalizeId("devices", args.deviceId);
    const device = deviceId ? await ctx.db.get(deviceId) : null;
    if (!device || device.revoked) return refuse("device_unavailable", "That device doesn't exist or is revoked.");
    if (!(Number.isFinite(args.ttlMs) && args.ttlMs > 0 && args.ttlMs <= MAX_GRANT_TTL_MS)) {
      return refuse("invalid_ttl", "Choose a lifetime of at most 16 hours.");
    }
    const unique = [...new Set(args.routeVersionIds)];
    if (unique.length === 0 || unique.length > MAX_GRANT_ROUTE_VERSIONS) {
      return refuse("route_version_unavailable", `Choose 1 to ${MAX_GRANT_ROUTE_VERSIONS} approved routes.`);
    }
    const versions: Doc<"routeVersions">[] = [];
    for (const raw of unique) {
      const id = ctx.db.normalizeId("routeVersions", raw);
      const version = id ? await ctx.db.get(id) : null;
      // Only a version a new run may start on: never a superseded one.
      if (!version || !(await isApprovedForNewRuns(ctx, version._id))) {
        return refuse("route_version_unavailable", "A chosen route isn't approved for new runs. Reload and choose again.");
      }
      versions.push(version);
    }
    const { grantId, expiresAtMs } = await writeGrant(
      ctx,
      {
        tokenHash: args.tokenHash,
        deviceId: device._id,
        driverUserId: driver._id,
        routeVersionIds: versions.map((x) => x._id),
        ttlMs: args.ttlMs,
        nowMs: Date.now(),
      },
      { kind: "user", userId: caller.user._id },
    );
    return {
      status: "ok",
      grantId,
      expiresAtMs,
      driverUserId: driver._id,
      driverName: driver.displayName,
      deviceId: device._id,
      routeVersions: versions.map((x) => ({ routeVersionId: x._id, label: x.label })),
    };
  },
});

/** Active grants (not revoked, not expired), without secrets, and the versions a grant may name. */
export const listForStaff = query({
  args: {},
  handler: async (ctx): Promise<ListDriverGrantsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const nowMs = Date.now();
    const label = async (id: Id<"routeVersions">) => (await ctx.db.get(id))?.label ?? "Unknown route";
    const grants: DriverGrantSummary[] = [];
    const active = await ctx.db
      .query("driverGrants")
      .withIndex("by_expires", (q) => q.gt("expiresAtMs", nowMs))
      .take(500);
    for (const g of active) {
      if (g.revoked) continue;
      grants.push({
        grantId: g._id,
        driverUserId: g.driverUserId,
        deviceId: g.deviceId,
        deviceLabel: (await ctx.db.get(g.deviceId))?.label ?? "Unknown device",
        routeVersions: await Promise.all(g.routeVersionIds.map(async (id) => ({ routeVersionId: id as string, label: await label(id) }))),
        issuedAtMs: g.issuedAtMs,
        expiresAtMs: g.expiresAtMs,
        issuedByName: g.issuedByUserId ? ((await ctx.db.get(g.issuedByUserId))?.displayName ?? null) : null,
      });
    }
    grants.sort((a, b) => a.expiresAtMs - b.expiresAtMs);

    const routeVersions: GrantableRouteVersion[] = [];
    for (const route of await ctx.db.query("routes").take(500)) {
      const version = route.currentVersionId ? await ctx.db.get(route.currentVersionId) : null;
      if (version) routeVersions.push({ routeVersionId: version._id, label: version.label, versionNumber: version.versionNumber ?? null });
    }
    // Versions created before route review existed have no route and stay startable.
    for (const version of await ctx.db.query("routeVersions").take(500)) {
      if (!version.routeId) routeVersions.push({ routeVersionId: version._id, label: version.label, versionNumber: null });
    }
    routeVersions.sort((a, b) => a.label.localeCompare(b.label));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: nowMs, grants, routeVersions };
  },
});

export const revokeForStaff = mutation({
  args: { grantId: v.string() },
  handler: async (ctx, { grantId }): Promise<RevokeGrantResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "driverGrants.revoke", "driverGrants", grantId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("driverGrants", grantId);
    const grant = id ? await ctx.db.get(id) : null;
    if (!grant) return refusedResult<"not_found">("not_found", "That grant doesn't exist.");
    await revokeGrant(ctx, grant, { kind: "user", userId: caller.user._id });
    return okResult<"not_found">();
  },
});
