import { deviceHealthNoFix } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "fake-health-device-secret-0000000000000"; // fictional
const OTHER_SECRET = "fake-other-device-secret-000000000000000"; // fictional
const STUDENT = "test|student";

type T = ReturnType<typeof convexTest>;

/** One fictional route with an active run on device A, and an idle device B. */
async function setup({ runStartedAgoMs = 60_000 } = {}) {
  const t = convexTest(schema, modules);
  const [hashA, hashB] = await Promise.all([sha256Hex(SECRET), sha256Hex(OTHER_SECRET)]);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" });
    const routeVersionId = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const stopId = await ctx.db.insert("stops", { routeVersionId, label: "Oak & Pine", latitude: 34.1, longitude: -83.9 });
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: user });
    const assignmentId = await ctx.db.insert("assignments", { studentId, routeVersionId, stopId, status: "approved" });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: hashA, revoked: false });
    const otherDeviceId = await ctx.db.insert("devices", { label: "Spare Pi", credentialHash: hashB, revoked: false });
    const runId = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId,
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: Date.now() - runStartedAgoMs,
    });
    return { assignmentId, deviceId, otherDeviceId, runId };
  });
  return { t, ...ids };
}

const report = (overrides: Record<string, unknown> = {}) => ({
  ...deviceHealthNoFix,
  capturedAtMs: Date.now() - 100,
  ...overrides,
});

async function post(t: T, secret: string | null, body: unknown) {
  const res = await t.fetch("/device/v1/health", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
}

async function myRun(t: T, assignmentId: string) {
  const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
  if (r.status !== "ready") throw new Error(r.status);
  return r.run;
}

describe("POST /device/v1/health", () => {
  it("D09: a no-fix report reaches families as gpsStatus no_fix with fresh contact", async () => {
    const { t, assignmentId } = await setup();
    expect((await myRun(t, assignmentId)).gpsStatus).toBeNull(); // never inferred
    const before = Date.now();
    const res = await post(t, SECRET, report());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemaVersion: 1, status: "accepted" });
    const run = await myRun(t, assignmentId);
    expect(run.gpsStatus).toBe("no_fix");
    expect(run.lastDeviceContactAtMs).toBeGreaterThanOrEqual(before);
    expect(run.lastPosition).toBeNull(); // no coordinates are invented
  });

  it("contact is the later of health and telemetry receipt", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    await post(t, SECRET, report({ gpsStatus: "valid" }));
    const healthAt = (await myRun(t, assignmentId)).lastDeviceContactAtMs!;
    await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [{ ...deviceTelemetry(), runId }],
      nowMs: healthAt + 10_000,
    });
    expect((await myRun(t, assignmentId)).lastDeviceContactAtMs).toBe(healthAt + 10_000);
  });

  it("GPSD down on the Pi is reported to families as no status, not as a fix problem", async () => {
    const { t, assignmentId } = await setup();
    await post(t, SECRET, report({ gpsStatus: "unknown" }));
    const run = await myRun(t, assignmentId);
    expect(run.gpsStatus).toBeNull();
    expect(run.lastDeviceContactAtMs).not.toBeNull();
  });

  it("an older report does not replace a newer one from the same boot", async () => {
    const { t, assignmentId } = await setup();
    await post(t, SECRET, report({ gpsStatus: "valid" }));
    await post(t, SECRET, report({ gpsStatus: "no_fix", capturedAtMs: Date.now() - 20_000 }));
    expect((await myRun(t, assignmentId)).gpsStatus).toBe("valid");
  });

  it("health from before the run started says nothing about this run", async () => {
    const { t, assignmentId, runId } = await setup();
    await post(t, SECRET, report());
    await t.run(async (ctx) => ctx.db.patch(runId, { startedAtMs: Date.now() + 1000 }));
    const run = await myRun(t, assignmentId);
    expect(run.gpsStatus).toBeNull();
    expect(run.lastDeviceContactAtMs).toBeNull();
  });

  it("another device's health never changes this run", async () => {
    const { t, assignmentId } = await setup();
    const res = await post(t, OTHER_SECRET, report({ runId: "claims_someone_elses_run" }));
    expect(res.status).toBe(200);
    const run = await myRun(t, assignmentId);
    expect(run.gpsStatus).toBeNull();
    expect(run.lastDeviceContactAtMs).toBeNull();
  });

  it("refuses a missing, wrong, or revoked credential", async () => {
    const { t, deviceId } = await setup();
    expect((await post(t, null, report())).status).toBe(401);
    expect((await post(t, "not-the-secret-000000000000000000000", report())).status).toBe(401);
    await t.run(async (ctx) => ctx.db.patch(deviceId, { revoked: true }));
    expect((await post(t, SECRET, report())).status).toBe(401);
  });

  it("refuses malformed, invalid, oversized, and future reports without storing them", async () => {
    const { t, assignmentId } = await setup();
    expect((await post(t, SECRET, "{nope")).body.error?.code).toBe("MALFORMED_JSON");
    expect((await post(t, SECRET, report({ latitude: 34.1 }))).body.error?.code).toBe("INVALID_REQUEST");
    expect((await post(t, SECRET, report({ capturedAtMs: Date.now() + 10 * 60_000 }))).status).toBe(400);
    expect((await post(t, SECRET, report({ appVersion: "x".repeat(4000) }))).status).toBe(413);
    expect((await myRun(t, assignmentId)).lastDeviceContactAtMs).toBeNull();
  });
});

let n = 0;
function deviceTelemetry() {
  n += 1;
  return {
    eventId: `7a1c2b3d-4e5f-4a6b-8c7d-${String(n).padStart(12, "0")}`,
    bootId: deviceHealthNoFix.bootId,
    sequence: n,
    runSequence: n,
    capturedAtMs: Date.now() - 1000,
    latitude: 34.1,
    longitude: -83.98,
    speedMps: null,
    headingDegrees: null,
    horizontalAccuracyM: null,
    fixMode: 3,
  };
}
