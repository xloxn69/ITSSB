import { localDate } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import { approvedVersionForNewRun } from "./lib/routeVersions";
import schema from "./schema";

/**
 * End to end (docs/15 §8): a recorded draft is approved by staff, a driver
 * grant is issued for the route's approved version, and a run started
 * through the real `/device/v1/trip-events` route pins that version. A later
 * approval changes what new runs pin, never a run already started.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const TZ = "America/New_York";
const HOUR = 60 * 60 * 1000;
const PATH = [
  { latitude: 34.1, longitude: -83.98 },
  { latitude: 34.1009, longitude: -83.98 },
];
const STOPS = [{ label: "Oak & Pine", latitude: 34.1009, longitude: -83.98 }];

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana" });
    const deviceA = await ctx.db.insert("devices", { label: "Pi A", credentialHash: await sha256Hex(SECRET_A), revoked: false });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: await sha256Hex(SECRET_B), revoked: false });
    return { driver, deviceA, deviceB };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

async function grantFor(t: T, grant: string, deviceId: Id<"devices">, driver: Id<"users">, routeId: string) {
  const versionId = await t.run((ctx) => approvedVersionForNewRun(ctx, routeId as Id<"routes">));
  if (!versionId) throw new Error("no approved version");
  await t.mutation(internal.driverGrants.insert, {
    tokenHash: await sha256Hex(grant),
    deviceId,
    driverUserId: driver,
    routeVersionIds: [versionId],
    ttlMs: 8 * HOUR,
    nowMs: Date.now(),
  });
  return versionId;
}

async function startRun(t: T, secret: string, grant: string, routeVersionId: string, requestId: string) {
  const capturedAtMs = Date.now() - 1000;
  const res = await t.fetch("/device/v1/trip-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId,
      type: "startRun",
      driverOperatingGrant: grant,
      routeVersionId,
      serviceDate: localDate(capturedAtMs, TZ),
      serviceTimezone: TZ,
      capturedAtMs,
    }),
  });
  return { status: res.status, body: (await res.json()) as { runId?: string; status?: string } };
}

const pinnedVersion = (t: T, runId: string) =>
  t.run(async (ctx) => (await ctx.db.get(ctx.db.normalizeId("runs", runId)!))?.routeVersionId);

describe("approval pins the version a new run uses", () => {
  it("approve → grant → start pins v1; approving v2 moves new runs only", async () => {
    const { t, driver, deviceA, deviceB } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });

    const draft = await t.mutation(internal.routes.recordDraft, {
      label: "Route 17 Morning",
      direction: "to_school",
      path: PATH,
      stops: STOPS,
      recordedByDeviceId: deviceA,
    });
    const v1 = await staff.mutation(api.routes.approveDraft, { draftId: draft });
    if (v1.status !== "approved") throw new Error(`not approved: ${JSON.stringify(v1)}`);

    const grantA = "g".repeat(64);
    const v1Id = await grantFor(t, grantA, deviceA, driver, v1.routeId);
    expect(v1Id).toBe(v1.routeVersionId);
    const runA = await startRun(t, SECRET_A, grantA, v1Id, "64869872-aaf9-4e4f-99df-621722bbac06");
    expect(runA).toMatchObject({ status: 200, body: { status: "accepted" } });
    expect(await pinnedVersion(t, runA.body.runId!)).toBe(v1.routeVersionId);

    const revision = await t.mutation(internal.routes.recordDraft, {
      routeId: v1.routeId as Id<"routes">,
      label: "Route 17 Morning",
      direction: "to_school",
      path: [...PATH, { latitude: 34.1018, longitude: -83.98 }],
      stops: STOPS,
    });
    const v2 = await staff.mutation(api.routes.approveDraft, { draftId: revision });
    if (v2.status !== "approved") throw new Error(`not approved: ${JSON.stringify(v2)}`);

    const grantB = "h".repeat(64);
    const v2Id = await grantFor(t, grantB, deviceB, driver, v2.routeId);
    expect(v2Id).toBe(v2.routeVersionId);
    const runB = await startRun(t, SECRET_B, grantB, v2Id, "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f");
    expect(runB).toMatchObject({ status: 200, body: { status: "accepted" } });

    expect(await pinnedVersion(t, runB.body.runId!)).toBe(v2.routeVersionId);
    expect(await pinnedVersion(t, runA.body.runId!)).toBe(v1.routeVersionId);
    const v1Row = await t.run((ctx) => ctx.db.get(v1.routeVersionId as Id<"routeVersions">));
    expect(v1Row?.path).toEqual(PATH);
  });

  it("an older grant naming a superseded version can't start a new run", async () => {
    const { t, driver, deviceA } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const draft = await t.mutation(internal.routes.recordDraft, { label: "Route 17 Morning", direction: "to_school", path: PATH, stops: STOPS });
    const v1 = await staff.mutation(api.routes.approveDraft, { draftId: draft });
    if (v1.status !== "approved") throw new Error("not approved");
    const grant = "g".repeat(64);
    const v1Id = await grantFor(t, grant, deviceA, driver, v1.routeId);
    const revision = await t.mutation(internal.routes.recordDraft, {
      routeId: v1.routeId as Id<"routes">,
      label: "Route 17 Morning",
      direction: "to_school",
      path: PATH,
      stops: STOPS,
    });
    expect(await staff.mutation(api.routes.approveDraft, { draftId: revision })).toMatchObject({ status: "approved" });
    const r = await startRun(t, SECRET_A, grant, v1Id, "64869872-aaf9-4e4f-99df-621722bbac06");
    expect(r.status).toBe(403);
    expect(await t.run(async (ctx) => (await ctx.db.query("runs").collect()).length)).toBe(0);
  });
});
