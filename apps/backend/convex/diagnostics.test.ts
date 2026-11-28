import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
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

describe("fleet.diagnostics measurements", () => {
  it("a heartbeat without measurements (older Pi software) reads as not reported, never zeros", async () => {
    const { t } = await setup();
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.devices.map((d) => d.metrics)).toEqual([null, null]);
  });
});

describe("fleet.diagnostics notification job age", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = 1_795_700_000_000;

  afterEach(() => vi.useRealTimers());

  async function withJobs(jobs: { agoMs: number; state: Doc<"notificationJobs">["state"] }[]) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW - 30 * HOUR);
    const s = await setup();
    const base = await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { tokenIdentifier: "test|family", role: "family", displayName: "Sam" });
      const routeVersionId = await ctx.db.insert("routeVersions", { label: "Route 17", path: [] });
      const stopId = await ctx.db.insert("stops", { routeVersionId, label: "Oak & Pine", latitude: 34.1, longitude: -83.9 });
      const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId });
      const assignmentId = await ctx.db.insert("assignments", { studentId, routeVersionId, stopId, status: "approved" });
      const pushTokenId = await ctx.db.insert("pushTokens", {
        userId,
        installationId: "install-1",
        token: "fake-token",
        environment: "sandbox",
        permission: "authorized",
        active: true,
        updatedAtMs: NOW,
      });
      return { userId, stopId, assignmentId, pushTokenId };
    });
    for (const [i, job] of jobs.entries()) {
      vi.setSystemTime(NOW - job.agoMs); // _creationTime is the transaction's time
      await s.t.run(async (ctx) => {
        const { userId, stopId, assignmentId, pushTokenId } = base;
        const alertId = await ctx.db.insert("alerts", {
          logicalKey: `k${i}`,
          type: "approaching",
          userId,
          assignmentId,
          runId: s.activeRun,
          stopId,
          createdAtMs: NOW - job.agoMs,
          predictedArrivalAtMs: NOW,
          predictionGeneratedAtMs: NOW - job.agoMs,
          sourceEventId: `e${i}`,
        });
        await ctx.db.insert("notificationJobs", {
          alertId,
          userId,
          runId: s.activeRun,
          pushTokenId,
          state: job.state,
          attempts: 0,
          nextAttemptAtMs: NOW,
          expiresAtMs: NOW + HOUR,
          updatedAtMs: NOW,
        });
      });
    }
    vi.setSystemTime(NOW);
    return s;
  }

  it("reports the oldest waiting job and 24 h counts by state", async () => {
    const { t } = await withJobs([
      { agoMs: 26 * HOUR, state: "provider_accepted" }, // outside the window
      { agoMs: 3 * HOUR, state: "retryable_failure" }, // oldest waiting
      { agoMs: 2 * HOUR, state: "in_progress" }, // sending, not waiting
      { agoMs: HOUR, state: "pending" },
      { agoMs: HOUR, state: "provider_accepted" },
      { agoMs: 10 * 60_000, state: "permanent_failure" },
    ]);
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.notifications).toEqual({
      oldestWaitingCreatedAtMs: NOW - 3 * HOUR,
      waitingCount: 2,
      windowMs: 24 * HOUR,
      countsByState: {
        pending: 1,
        in_progress: 1,
        provider_accepted: 1,
        retryable_failure: 1,
        permanent_failure: 1,
        expired: 0,
        cancelled: 0,
      },
      truncated: false,
    });
    const text = JSON.stringify(result.notifications);
    expect(text).not.toContain("fake-token");
  });

  it("a stuck job older than the window still sets the oldest waiting age", async () => {
    const { t } = await withJobs([{ agoMs: 27 * HOUR, state: "pending" }]);
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.notifications.oldestWaitingCreatedAtMs).toBe(NOW - 27 * HOUR);
    expect(result.notifications.countsByState.pending).toBe(0); // created before the window
  });

  it("with no jobs, nothing is waiting", async () => {
    const { t } = await withJobs([]);
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.diagnostics, {});
    if (result.status !== "ready") throw new Error(result.status);
    expect(result.notifications).toMatchObject({ oldestWaitingCreatedAtMs: null, waitingCount: 0, truncated: false });
  });
});
