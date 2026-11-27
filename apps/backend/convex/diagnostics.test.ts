import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana Driver" });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: "secret-hash-x", revoked: false });
    const spareId = await ctx.db.insert("devices", { label: "Spare Pi", credentialHash: "secret-hash-y", revoked: false });
    const doneRun = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId: "rv",
      state: "completed",
      startRequestId: "a",
      endedAtMs: 1_000,
    });
    const activeRun = await ctx.db.insert("runs", { deviceId, routeVersionId: "rv", state: "active", startRequestId: "b" });
    await ctx.db.insert("liveState", {
      runId: activeRun,
      eventId: "e1",
      capturedAtMs: 4_000,
      receivedAtMs: 5_000,
      latitude: 34.1,
      longitude: -83.98,
      speedMps: null,
      headingDegrees: null,
    });
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "retention.purgeRawGps",
      resourceType: "retention",
      resourceId: "rawGps",
      reason: "telemetry:12,live:1",
      result: "allowed",
      atMs: 9_000,
    });
    // A later, smaller batch: the newest one is the last cleanup.
    await ctx.db.insert("auditLog", {
      actor: { kind: "system" },
      action: "retention.purgeRawGps",
      resourceType: "retention",
      resourceId: "rawGps",
      reason: "telemetry:1,live:0",
      result: "allowed",
      atMs: 10_000,
    });
    // The heartbeat arrived after the last position (a backlog upload
    // doesn't move the live position): contact is the heartbeat.
    await ctx.db.insert("deviceHealth", {
      deviceId,
      bootId: "boot-1",
      capturedAtMs: 7_900,
      receivedAtMs: 8_000,
      appVersion: "0.1.0",
      reportedRunId: null,
      gpsStatus: "valid",
      lastValidFixAtMs: 7_800,
      pendingCount: 42,
      oldestPendingCapturedAtMs: 1_500,
    });
    return { deviceId, spareId, doneRun, activeRun };
  });
  return { t, ...ids };
}

afterEach(() => vi.unstubAllEnvs());

describe("fleet.diagnostics", () => {
  it("reports release, retention and per-device run IDs without credentials or positions", async () => {
    vi.stubEnv("ITSSB_RELEASE", "2026.11.27-abc1234");
    vi.stubEnv("ITSSB_ENVIRONMENT", "development");
    const { t, deviceId, spareId, activeRun } = await setup();
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    expect(result).toMatchObject({
      status: "ready",
      deployment: { release: "2026.11.27-abc1234", environment: "development", contractSchemaVersion: 1 },
      retention: { rawGpsDays: 30, lastSweepAtMs: 10_000, lastSweepDeleted: "telemetry:1,live:0" },
      devices: [
        {
          deviceId,
          label: "Bench Pi",
          activeRunId: activeRun,
          lastContactAtMs: 8_000,
          softwareVersion: "0.1.0",
          pendingCount: 42,
          oldestPendingCapturedAtMs: 1_500,
          lastRun: { runId: activeRun, state: "active", endedAtMs: null },
        },
        {
          deviceId: spareId,
          activeRunId: null,
          lastContactAtMs: null,
          lastRun: null,
          softwareVersion: null,
          pendingCount: null,
        },
      ],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("secret-hash");
    expect(text).not.toContain("34.1");
  });

  it("an unrecorded release is null, not guessed", async () => {
    const { t } = await setup();
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    expect(result).toMatchObject({ deployment: { release: null, environment: null } });
  });

  it("is staff only", async () => {
    const { t } = await setup();
    expect(await t.query(api.fleet.diagnostics, {})).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
    expect(await t.withIdentity({ tokenIdentifier: "test|driver" }).query(api.fleet.diagnostics, {})).toMatchObject({
      status: "access_unavailable",
      reason: "not_permitted",
    });
  });
});
