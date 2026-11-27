import { localDate } from "@itssb/contracts";
import { DEMO_ROUTE_PATH, demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const CLERK = "https://example-name-00.clerk.accounts.dev|user_fictional01";

describe("seed.dev", () => {
  beforeEach(() => {
    vi.stubEnv("ITSSB_ALLOW_DEV_SEED", "true");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run unless the deployment allows the dev seed", async () => {
    vi.stubEnv("ITSSB_ALLOW_DEV_SEED", "");
    const t = convexTest(schema, modules);
    await expect(t.action(internal.seed.dev, {})).rejects.toThrow(/SEED_NOT_ALLOWED/);
    // The mutation checks too, so calling it directly does not bypass the guard.
    await expect(
      t.mutation(internal.seed.insert, { deviceCredentialHash: "x", driverGrantHash: "y", nowMs: 0 }),
    ).rejects.toThrow(
      /SEED_NOT_ALLOWED/,
    );
    expect(await t.run((ctx) => ctx.db.query("users").first())).toBeNull();
  });

  it("refuses a database that already has data", async () => {
    const t = convexTest(schema, modules);
    await t.action(internal.seed.dev, {});
    await expect(t.action(internal.seed.dev, {})).rejects.toThrow(/SEED_REFUSED_NOT_EMPTY/);
    expect((await t.run((ctx) => ctx.db.query("devices").collect())).length).toBe(1);
  });

  it("refuses a database holding only a student record, or only history", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => ctx.db.insert("students", { displayName: "Existing Example" }));
    await expect(t.action(internal.seed.dev, {})).rejects.toThrow(/SEED_REFUSED_NOT_EMPTY/);
    const t2 = convexTest(schema, modules);
    await t2.run((ctx) =>
      ctx.db.insert("auditLog", { actor: { kind: "system" }, action: "x", resourceType: "x", result: "allowed", atMs: 0 }),
    );
    await expect(t2.action(internal.seed.dev, {})).rejects.toThrow(/SEED_REFUSED_NOT_EMPTY/);
  });

  it("seeds everything, grant included, in one transaction (nothing half-written to repair)", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.mutation(internal.seed.insert, { deviceCredentialHash: "x", driverGrantHash: "y", nowMs: 0 });
    const grants = await t.run((ctx) => ctx.db.query("driverGrants").collect());
    expect(grants).toEqual([
      expect.objectContaining({ tokenHash: "y", deviceId: ids.deviceId, driverUserId: ids.driverUserId }),
    ]);
  });

  it("seeds a world in which the Pi can start, report and end one run that only the family can read", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.action(internal.seed.dev, {});
    const { ids, deviceSecret, driverGrant } = seeded;

    // The seeded route is the dense road-following demo path, not a few corners.
    const route = await t.run((ctx) => ctx.db.get(ids.routeVersionId));
    expect(route?.path).toEqual(DEMO_ROUTE_PATH);

    // Secrets are returned once and stored only as hashes.
    const stored = JSON.stringify(await t.run(async (ctx) => [await ctx.db.query("devices").collect(), await ctx.db.query("driverGrants").collect()]));
    expect(stored).not.toContain(deviceSecret);
    expect(stored).not.toContain(driverGrant);

    await t.mutation(internal.users.linkIdentity, { userId: ids.guardianUserId, tokenIdentifier: CLERK });
    const asGuardian = t.withIdentity({ tokenIdentifier: CLERK });
    const mine = await asGuardian.query(api.tracking.myAssignments, {});
    expect(mine).toMatchObject({ status: "ready", assignments: [{ assignmentId: ids.assignmentId, relationship: "guardian" }] });

    const post = async (path: string, body: unknown) => {
      const res = await t.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceSecret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    const capturedAtMs = Date.now() - 1000;
    const start = await post("/device/v1/trip-events", {
      schemaVersion: 1,
      requestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      type: "startRun",
      driverOperatingGrant: driverGrant,
      routeVersionId: ids.routeVersionId,
      serviceDate: localDate(capturedAtMs, "America/New_York"),
      serviceTimezone: "America/New_York",
      capturedAtMs,
    });
    expect(start).toMatchObject({ status: "accepted", state: "active" });
    const runId = start.runId as string;
    const report = await post("/device/v1/telemetry", {
      schemaVersion: 1,
      events: [{ ...demoTelemetryEvent, runId, capturedAtMs }],
    });
    expect(report.results).toEqual([expect.objectContaining({ status: "accepted", liveStateApplied: true })]);
    expect(await asGuardian.query(api.tracking.myRun, { assignmentId: ids.assignmentId })).toMatchObject({
      status: "ready",
      run: { runId, busLabel: "Bus 12 (demo)", lastPosition: { capturedAtMs } },
    });
    // Unlinked seed accounts and strangers see nothing.
    const asStranger = t.withIdentity({ tokenIdentifier: "https://example-name-00.clerk.accounts.dev|user_x" });
    expect(await asStranger.query(api.runs.live, { runId })).toBeNull();

    const end = await post("/device/v1/trip-events", {
      schemaVersion: 1,
      requestId: "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f",
      type: "endRun",
      driverOperatingGrant: driverGrant,
      runId,
      capturedAtMs: Date.now(),
      lastRunSequence: demoTelemetryEvent.runSequence,
    });
    expect(end).toMatchObject({ status: "accepted", state: "completed" });
  });
});
