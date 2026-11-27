import { DEMO_ROUTE_PATH, DEMO_ROUTE_POINTS } from "@itssb/contracts/fixtures";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation } from "./_generated/server";
import type { TableNames } from "./_generated/dataModel";
import { insertGrant, MAX_GRANT_TTL_MS } from "./driverGrants";
import { generateDeviceSecret, sha256Hex } from "./lib/deviceAuth";
import { UNLINKED_PREFIX } from "./users";

/**
 * Fictional first-run data for a DEVELOPMENT deployment (docs/15 §5): one
 * route version with two stops on a dense path that follows public roads,
 * one driver, one bus/device, one student with an approved assignment, and
 * one guardian with an approved link. The path is the shared demo route
 * (© OpenStreetMap contributors, ODbL, via the OSRM demo server; see
 * packages/contracts/src/demoRoute.ts).
 *
 * Runnable only where the deployment variable `ITSSB_ALLOW_DEV_SEED` is
 * `true` (set it on the dev deployment only), and only into an empty
 * database, so it can never mix fictional people into real records.
 *
 *     bunx convex env set ITSSB_ALLOW_DEV_SEED true
 *     bunx convex run seed:dev
 *
 * It prints the device secret and a driver grant once. Put the secret in the
 * Pi's /etc/itssb/device.env; neither is stored anywhere except as a hash.
 */

// The Convex runtime provides `process.env`.
declare const process: { env: Record<string, string | undefined> };

function requireDevSeedAllowed() {
  if (process.env.ITSSB_ALLOW_DEV_SEED !== "true") {
    throw new ConvexError({
      code: "SEED_NOT_ALLOWED",
      message: "Set ITSSB_ALLOW_DEV_SEED=true on a development deployment to seed it.",
    });
  }
}

export const dev = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    ids: SeedIds;
    deviceSecret: string;
    driverGrant: string;
    driverGrantExpiresAtMs: number;
    next: string[];
  }> => {
    requireDevSeedAllowed();
    // Secrets come from real randomness in the action, never from a mutation.
    const deviceSecret = generateDeviceSecret();
    const driverGrant = generateDeviceSecret();
    const nowMs = Date.now();
    // One transaction: either everything is seeded and both secrets are
    // returned, or nothing is written and the seed can simply be rerun.
    const { driverGrantExpiresAtMs, ...ids }: SeedIds & { driverGrantExpiresAtMs: number } =
      await ctx.runMutation(internal.seed.insert, {
        deviceCredentialHash: await sha256Hex(deviceSecret),
        driverGrantHash: await sha256Hex(driverGrant),
        nowMs,
      });
    return {
      ids,
      deviceSecret,
      driverGrant,
      driverGrantExpiresAtMs,
      next: [
        "Pi: set ITSSB_DEVICE_TOKEN=<deviceSecret> and ITSSB_DEVICE_API_ORIGIN=<deployment .convex.site URL> in /etc/itssb/device.env (root, 0600).",
        "Sign in with Clerk, then link: bunx convex run users:linkIdentity '{\"userId\":\"<guardianUserId>\",\"tokenIdentifier\":\"<issuer>|<Clerk user id>\"}'",
        "The driver grant expires; issue another with driverGrants:issue.",
      ],
    };
  },
});

/** Every table in the schema. A new table must be added here (typechecked below). */
const SEED_GUARDED_TABLES = [
  "users",
  "devices",
  "runs",
  "driverGrants",
  "telemetryEvents",
  "liveState",
  "runProgress",
  "etaPredictions",
  "routeVersions",
  "stops",
  "routes",
  "routeDrafts",
  "students",
  "assignments",
  "guardianLinks",
  "scopedTokens",
  "enrollmentRequests",
  "guardianLinkRequests",
  "checkIns",
  "requestReceipts",
  "notificationPreferences",
  "pushTokens",
  "alerts",
  "notificationJobs",
  "auditLog",
  "deviceHealth",
] as const satisfies readonly TableNames[];
// Fails to compile if a schema table is missing from the list above.
type MissingFromGuard = Exclude<TableNames, (typeof SEED_GUARDED_TABLES)[number]>;
const guardCoversEveryTable: [MissingFromGuard] extends [never] ? true : false = true;
void guardCoversEveryTable;

type SeedIds = {
  routeVersionId: Id<"routeVersions">;
  stopIds: Id<"stops">[];
  driverUserId: Id<"users">;
  studentUserId: Id<"users">;
  guardianUserId: Id<"users">;
  studentId: Id<"students">;
  assignmentId: Id<"assignments">;
  deviceId: Id<"devices">;
};

export const insert = internalMutation({
  args: { deviceCredentialHash: v.string(), driverGrantHash: v.string(), nowMs: v.number() },
  handler: async (
    ctx,
    { deviceCredentialHash, driverGrantHash, nowMs },
  ): Promise<SeedIds & { driverGrantExpiresAtMs: number }> => {
    requireDevSeedAllowed();
    // Every application table must be empty, so fictional records never mix
    // with existing ones.
    const existing = await Promise.all(SEED_GUARDED_TABLES.map((table) => ctx.db.query(table).first()));
    if (existing.some((row) => row !== null)) {
      throw new ConvexError({
        code: "SEED_REFUSED_NOT_EMPTY",
        message: "The seed only runs on an empty development deployment.",
      });
    }

    // Fictional people and places only (AGENTS.md).
    const routeVersionId = await ctx.db.insert("routeVersions", {
      label: "Route 17 Morning (demo)",
      // Dense road-following path from OpenStreetMap data via OSRM (ODbL);
      // source and licence in packages/contracts/src/demoRoute.ts.
      path: [...DEMO_ROUTE_PATH],
    });
    const firstStopId = await ctx.db.insert("stops", {
      routeVersionId,
      label: "Maple & Elm (demo)",
      sequence: 0,
      ...DEMO_ROUTE_POINTS.firstStop,
    });
    const assignedStopId = await ctx.db.insert("stops", {
      routeVersionId,
      label: "Oak & Pine (demo)",
      sequence: 1,
      ...DEMO_ROUTE_POINTS.assignedStop,
    });
    const stopIds = [firstStopId, assignedStopId];
    const user = (key: string, role: "driver" | "family", displayName: string) =>
      ctx.db.insert("users", { tokenIdentifier: `${UNLINKED_PREFIX}seed-${key}`, role, displayName });
    const driverUserId = await user("driver", "driver", "Dana Driver (demo)");
    const studentUserId = await user("student", "family", "Sam Example (demo)");
    const guardianUserId = await user("guardian", "family", "Pat Example (demo)");
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example (demo)", userId: studentUserId });
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId,
      stopId: assignedStopId,
      status: "approved",
    });
    await ctx.db.insert("guardianLinks", { guardianUserId, studentId, status: "approved" });
    const deviceId = await ctx.db.insert("devices", {
      label: "Bench Pi (demo)",
      credentialHash: deviceCredentialHash,
      revoked: false,
      busLabel: "Bus 12 (demo)",
    });
    const driverGrantExpiresAtMs = await insertGrant(ctx, {
      tokenHash: driverGrantHash,
      deviceId,
      driverUserId,
      routeVersionIds: [routeVersionId],
      ttlMs: MAX_GRANT_TTL_MS,
      nowMs,
    });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "seed.dev",
      resourceType: "deployment",
      result: "allowed",
      atMs: nowMs,
    });
    return {
      routeVersionId,
      stopIds,
      driverUserId,
      studentUserId,
      guardianUserId,
      studentId,
      assignmentId,
      deviceId,
      driverGrantExpiresAtMs,
    };
  },
});
