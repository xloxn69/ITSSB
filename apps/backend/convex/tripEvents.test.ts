import { localDate, type TelemetryEvent } from "@itssb/contracts";
import { demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * One credentialed Pi starts, reports, and completes one authorized run
 * through the real HTTP routes (docs/15 §5), and every wrong scope is refused.
 * Times are relative to the real clock because the routes use `Date.now()`.
 */

const modules = import.meta.glob("./**/*.ts");
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_A = "g".repeat(64);
const GRANT_B = "h".repeat(64);
const TZ = "America/New_York";
const GUARDIAN = "test|guardian";
const STRANGER = "test|stranger";
const HOUR = 60 * 60 * 1000;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana" });
    const family = await ctx.db.insert("users", { tokenIdentifier: "test|family-driver", role: "family", displayName: "X" });
    const guardian = await ctx.db.insert("users", { tokenIdentifier: GUARDIAN, role: "family", displayName: "Pat" });
    await ctx.db.insert("users", { tokenIdentifier: STRANGER, role: "family", displayName: "Lee" });
    const routeA = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const routeB = await ctx.db.insert("routeVersions", { label: "Route 4 Morning", path: [] });
    const stopId = await ctx.db.insert("stops", { routeVersionId: routeA, label: "Oak & Pine", latitude: 34.1, longitude: -83.98 });
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example" });
    const assignmentId = await ctx.db.insert("assignments", { studentId, routeVersionId: routeA, stopId, status: "approved" });
    await ctx.db.insert("guardianLinks", { guardianUserId: guardian, studentId, status: "approved" });
    const deviceA = await ctx.db.insert("devices", { label: "Pi A", credentialHash: await sha256Hex(SECRET_A), revoked: false });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: await sha256Hex(SECRET_B), revoked: false });
    const grant = (tokenHash: string, deviceId: Id<"devices">, routeVersionIds: Id<"routeVersions">[], driverUserId = driver) =>
      ctx.db.insert("driverGrants", {
        tokenHash,
        deviceId,
        driverUserId,
        routeVersionIds,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 8 * HOUR,
        revoked: false,
      });
    const grantA = await grant(await sha256Hex(GRANT_A), deviceA, [routeA]);
    await grant(await sha256Hex(GRANT_B), deviceB, [routeB]);
    return { driver, family, routeA, routeB, assignmentId, deviceA, deviceB, grantA };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

async function post(t: T, path: string, secret: string | null, body: unknown) {
  const res = await t.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
}

const startBody = (routeVersionId: string, overrides: Record<string, unknown> = {}) => {
  const capturedAtMs = Date.now() - 1000;
  return {
    schemaVersion: 1,
    requestId: "64869872-aaf9-4e4f-99df-621722bbac06",
    type: "startRun",
    driverOperatingGrant: GRANT_A,
    routeVersionId,
    serviceDate: localDate(capturedAtMs, TZ),
    serviceTimezone: TZ,
    capturedAtMs,
    ...overrides,
  };
};

const endBody = (runId: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f",
  type: "endRun",
  driverOperatingGrant: GRANT_A,
  runId,
  capturedAtMs: Date.now() - 500,
  lastRunSequence: 920,
  ...overrides,
});

let eventCounter = 0;
const telemetry = (runId: string, overrides: Partial<TelemetryEvent> = {}): TelemetryEvent => {
  eventCounter += 1;
  return {
    ...demoTelemetryEvent,
    eventId: `5fe2a60d-7c11-45b9-995d-${String(eventCounter).padStart(12, "0")}`,
    runId,
    capturedAtMs: Date.now() - 2000,
    ...overrides,
  };
};

const sendTelemetry = (t: T, secret: string, events: TelemetryEvent[]) =>
  post(t, "/device/v1/telemetry", secret, { schemaVersion: 1, events });

const runCount = (t: T) => t.run(async (ctx) => (await ctx.db.query("runs").collect()).length);

describe("startRun", () => {
  it("starts one active run and returns the server-issued runId", async () => {
    const { t, routeA } = await setup();
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "accepted", state: "active", endedAtMs: null });
    expect(typeof r.body.runId).toBe("string");
  });

  it("a retried start returns the same run and start time, and creates nothing new", async () => {
    const { t, routeA } = await setup();
    const body = startBody(routeA);
    const first = await post(t, "/device/v1/trip-events", SECRET_A, body);
    const retry = await post(t, "/device/v1/trip-events", SECRET_A, body);
    expect(retry.status).toBe(200);
    expect(retry.body.runId).toBe(first.body.runId);
    expect(retry.body.startedAtMs).toBe(first.body.startedAtMs);
    expect(await runCount(t)).toBe(1);
  });

  it("the same requestId with different content is a conflict, not the old run", async () => {
    const { t, routeA } = await setup();
    const body = startBody(routeA);
    await post(t, "/device/v1/trip-events", SECRET_A, body);
    const r = await post(t, "/device/v1/trip-events", SECRET_A, { ...body, capturedAtMs: body.capturedAtMs + 1 });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("REQUEST_ID_CONFLICT");
    expect(r.body).not.toHaveProperty("runId");
  });

  it("another device reusing a requestId never receives the first device's run", async () => {
    const { t, routeA, routeB } = await setup();
    const a = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA));
    const b = await post(t, "/device/v1/trip-events", SECRET_B, startBody(routeB, { driverOperatingGrant: GRANT_B }));
    expect(b.status).toBe(200);
    expect(b.body.runId).not.toBe(a.body.runId);
  });

  it("a device credential without a valid grant cannot start a run", async () => {
    const { t, routeA } = await setup();
    const missing = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { driverOperatingGrant: undefined }));
    expect(missing.status).toBe(400);
    const forged = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { driverOperatingGrant: "f".repeat(64) }));
    expect(forged.status).toBe(403);
    expect(forged.body.error?.code).toBe("GRANT_NOT_AUTHORIZED");
    expect(await runCount(t)).toBe(0);
  });

  it("wrong device: another Pi cannot use this Pi's grant", async () => {
    const { t, routeA } = await setup();
    const r = await post(t, "/device/v1/trip-events", SECRET_B, startBody(routeA));
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("GRANT_NOT_AUTHORIZED");
    expect(await runCount(t)).toBe(0);
  });

  it("refuses a route version outside the grant", async () => {
    const { t, routeB } = await setup();
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeB));
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("GRANT_NOT_AUTHORIZED");
  });

  it("refuses an expired or revoked grant", async () => {
    const { t, routeA, grantA } = await setup();
    await t.run((ctx) => ctx.db.patch(grantA, { expiresAtMs: Date.now() - 1 }));
    expect((await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).status).toBe(403);
    await t.run((ctx) => ctx.db.patch(grantA, { expiresAtMs: Date.now() + HOUR, revoked: true }));
    expect((await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).status).toBe(403);
    expect(await runCount(t)).toBe(0);
  });

  it("refuses a grant whose holder is no longer a driver", async () => {
    const { t, routeA, driver } = await setup();
    await t.run((ctx) => ctx.db.patch(driver, { role: "family" }));
    expect((await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).status).toBe(403);
  });

  it("allows only one active run per device", async () => {
    const { t, routeA } = await setup();
    await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA));
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { requestId: "11111111-2222-4333-8444-555555555555" }));
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("ACTIVE_RUN_CONFLICT");
    expect(await runCount(t)).toBe(1);
  });

  it("refuses a service date that is not today in the service time zone", async () => {
    const { t, routeA } = await setup();
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { serviceDate: "2020-01-01" }));
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe("SERVICE_DATE_OUT_OF_RANGE");
  });

  it("refuses a capture time far from the server clock", async () => {
    const { t, routeA } = await setup();
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { capturedAtMs: Date.now() + HOUR }));
    expect(r.body.error?.code).toBe("CLOCK_OUT_OF_RANGE");
  });

  it("refuses a missing, unknown, or revoked device credential", async () => {
    const { t, routeA, deviceA } = await setup();
    expect((await post(t, "/device/v1/trip-events", null, startBody(routeA))).status).toBe(401);
    expect((await post(t, "/device/v1/trip-events", "c".repeat(64), startBody(routeA))).status).toBe(401);
    await t.run((ctx) => ctx.db.patch(deviceA, { revoked: true }));
    expect((await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).status).toBe(401);
    expect(await runCount(t)).toBe(0);
  });

  it("refuses a revoked device inside the committing mutation", async () => {
    const { t, routeA, deviceA } = await setup();
    await t.run((ctx) => ctx.db.patch(deviceA, { revoked: true }));
    await expect(
      t.mutation(internal.tripEvents.apply, {
        deviceId: deviceA,
        grantHash: await sha256Hex(GRANT_A),
        request: startBody(routeA),
        nowMs: Date.now(),
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
  });

  it("rejects malformed JSON and unknown event types", async () => {
    const { t, routeA } = await setup();
    expect((await post(t, "/device/v1/trip-events", SECRET_A, "{")).body.error?.code).toBe("MALFORMED_JSON");
    expect((await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { type: "patchRow" }))).status).toBe(400);
  });
});

async function started() {
  const s = await setup();
  const r = await post(s.t, "/device/v1/trip-events", SECRET_A, startBody(s.routeA));
  return { ...s, runId: r.body.runId as string };
}

describe("endRun", () => {
  it("completes the run once; a retry returns the same result", async () => {
    const { t, runId } = await started();
    const body = endBody(runId);
    const first = await post(t, "/device/v1/trip-events", SECRET_A, body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "accepted", runId, state: "completed" });
    expect(typeof first.body.endedAtMs).toBe("number");
    const retry = await post(t, "/device/v1/trip-events", SECRET_A, body);
    expect(retry.body.endedAtMs).toBe(first.body.endedAtMs);
  });

  it("a second, different end of a completed run is a conflict", async () => {
    const { t, runId } = await started();
    await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId));
    const r = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { requestId: "22222222-3333-4444-8555-666666666666" }));
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("RUN_NOT_ACTIVE");
  });

  it("wrong run: another device cannot end it, and cannot tell it exists", async () => {
    const { t, runId } = await started();
    const other = await post(t, "/device/v1/trip-events", SECRET_B, endBody(runId, { driverOperatingGrant: GRANT_B }));
    const unknown = await post(t, "/device/v1/trip-events", SECRET_B, endBody("not_a_run", { driverOperatingGrant: GRANT_B }));
    expect(other.status).toBe(403);
    expect(other.body).toEqual(unknown.body);
    const state = await t.run(async (ctx) => (await ctx.db.query("runs").first())?.state);
    expect(state).toBe("active");
  });

  it("needs a grant: the device credential alone cannot end a run", async () => {
    const { t, runId } = await started();
    const r = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { driverOperatingGrant: "f".repeat(64) }));
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe("GRANT_NOT_AUTHORIZED");
  });

  it("refuses a final sequence below telemetry already accepted", async () => {
    const { t, runId } = await started();
    await sendTelemetry(t, SECRET_A, [telemetry(runId, { runSequence: 50 })]);
    const r = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { lastRunSequence: 49 }));
    expect(r.status).toBe(400);
  });
});

describe("one authorized run, end to end", () => {
  it("start, report, read as guardian, complete, reconcile late history", async () => {
    const { t, routeA, assignmentId } = await setup();
    const asGuardian = t.withIdentity({ tokenIdentifier: GUARDIAN });
    const asStranger = t.withIdentity({ tokenIdentifier: STRANGER });

    const start = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA));
    const runId = start.body.runId as string;

    const late = telemetry(runId, { runSequence: 900, capturedAtMs: Date.now() - 10_000 });
    const current = telemetry(runId, { runSequence: 901, capturedAtMs: Date.now() - 3000 });
    const sent = await sendTelemetry(t, SECRET_A, [current]);
    expect(sent.body.results).toEqual([
      expect.objectContaining({ eventId: current.eventId, status: "accepted", liveStateApplied: true }),
    ]);

    // Duplicate delivery cannot duplicate events.
    const again = await sendTelemetry(t, SECRET_A, [current]);
    expect(again.body.results).toEqual([expect.objectContaining({ status: "duplicate" })]);

    // Wrong device: Pi B cannot report into Pi A's run.
    const intruder = await sendTelemetry(t, SECRET_B, [telemetry(runId)]);
    expect(intruder.body.results).toEqual([expect.objectContaining({ status: "rejected", code: "RUN_NOT_AUTHORIZED" })]);

    // Current-state selection: the guardian sees the newest position with its capture time.
    const ready = await asGuardian.query(api.tracking.myRun, { assignmentId });
    expect(ready).toMatchObject({ status: "ready", run: { runId, lastPosition: { capturedAtMs: current.capturedAtMs } } });
    expect(await asGuardian.query(api.runs.live, { runId })).not.toBeNull();
    // Wrong account: an unrelated family account cannot read it.
    expect(await asStranger.query(api.tracking.myRun, { assignmentId })).toMatchObject({ status: "access_unavailable" });
    expect(await asStranger.query(api.runs.live, { runId })).toBeNull();

    const end = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { lastRunSequence: 905 }));
    expect(end.body.state).toBe("completed");
    expect(await asGuardian.query(api.tracking.myRun, { assignmentId })).toMatchObject({ status: "no_active_run" });

    // Late history inside the end boundary is kept, but never moves the live position.
    const reconciled = await sendTelemetry(t, SECRET_A, [late]);
    expect(reconciled.body.results).toEqual([
      expect.objectContaining({ status: "accepted", liveStateApplied: false }),
    ]);
    // Completed-run ingest outside the boundary is rejected.
    const pastBoundary = await sendTelemetry(t, SECRET_A, [
      telemetry(runId, { runSequence: 906, capturedAtMs: Date.now() - 4000 }),
      telemetry(runId, { runSequence: 904, capturedAtMs: Date.now() + 1000 }),
    ]);
    expect(pastBoundary.body.results).toEqual([
      expect.objectContaining({ status: "rejected", code: "RUN_NOT_AUTHORIZED" }),
      expect.objectContaining({ status: "rejected", code: "RUN_NOT_AUTHORIZED" }),
    ]);

    const stored = await t.run(async (ctx) => ({
      events: (await ctx.db.query("telemetryEvents").collect()).map((e) => e.eventId).toSorted(),
      live: await ctx.db.query("liveState").first(),
      run: await ctx.db.query("runs").first(),
    }));
    expect(stored.events).toEqual([current.eventId, late.eventId].toSorted());
    expect(stored.live?.eventId).toBe(current.eventId);
    expect(stored.run?.state).toBe("completed");
  });

  it("a completed run that sent no telemetry accepts no late history", async () => {
    const { t, routeA } = await setup();
    const start = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA));
    const runId = start.body.runId as string;
    await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { lastRunSequence: null }));
    const r = await sendTelemetry(t, SECRET_A, [telemetry(runId, { runSequence: 0, capturedAtMs: Date.now() - 3000 })]);
    expect(r.body.results).toEqual([expect.objectContaining({ status: "rejected", code: "RUN_NOT_AUTHORIZED" })]);
  });
});

describe("driverGrants.issue", () => {
  it("issues a usable grant only to a driver, and stores only its hash", async () => {
    const { t, routeA, deviceA, driver, family } = await setup();
    const { grant } = await t.action(internal.driverGrants.issue, {
      deviceId: deviceA,
      driverUserId: driver,
      routeVersionIds: [routeA],
      ttlMs: HOUR,
    });
    const hashes = await t.run(async (ctx) => (await ctx.db.query("driverGrants").collect()).map((g) => g.tokenHash));
    expect(hashes).toContain(await sha256Hex(grant));
    expect(hashes).not.toContain(grant);
    const r = await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { driverOperatingGrant: grant }));
    expect(r.status).toBe(200);
    await expect(
      t.action(internal.driverGrants.issue, { deviceId: deviceA, driverUserId: family, routeVersionIds: [routeA], ttlMs: HOUR }),
    ).rejects.toThrow(/NOT_A_DRIVER/);
  });
});

/** A second driver's grant for the same Pi, scoped to route B, already expired. */
async function otherDriversExpiredGrant(t: T, deviceId: Id<"devices">, routeB: Id<"routeVersions">) {
  const secret = "k".repeat(64);
  await t.run(async (ctx) => {
    const other = await ctx.db.insert("users", { tokenIdentifier: "test|driver2", role: "driver", displayName: "Rae" });
    await ctx.db.insert("driverGrants", {
      tokenHash: await sha256Hex(secret),
      deviceId,
      driverUserId: other,
      routeVersionIds: [routeB],
      issuedAtMs: Date.now() - 2 * HOUR,
      expiresAtMs: Date.now() - HOUR,
      revoked: false,
    });
  });
  return secret;
}

describe("review regressions (PR #18)", () => {
  it("a start retry with another driver's grant does not return the run", async () => {
    const { t, routeA, routeB, deviceA } = await setup();
    const body = startBody(routeA);
    await post(t, "/device/v1/trip-events", SECRET_A, body);
    const other = await otherDriversExpiredGrant(t, deviceA, routeB);
    const r = await post(t, "/device/v1/trip-events", SECRET_A, { ...body, driverOperatingGrant: other });
    expect(r.status).toBe(409);
    expect(r.body).not.toHaveProperty("runId");
  });

  it("an end retry with another driver's grant does not return the run", async () => {
    const { t, routeA, routeB, deviceA } = await setup();
    const runId = (await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).body.runId as string;
    const end = endBody(runId);
    await post(t, "/device/v1/trip-events", SECRET_A, end);
    const other = await otherDriversExpiredGrant(t, deviceA, routeB);
    const r = await post(t, "/device/v1/trip-events", SECRET_A, { ...end, driverOperatingGrant: other });
    expect(r.status).toBe(409);
  });

  it("one requestId names one command: an end cannot reuse the start's requestId", async () => {
    const { t, routeA } = await setup();
    const start = startBody(routeA);
    const runId = (await post(t, "/device/v1/trip-events", SECRET_A, start)).body.runId as string;
    const r = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, { requestId: start.requestId }));
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe("REQUEST_ID_CONFLICT");
    expect(await t.run(async (ctx) => (await ctx.db.query("runs").first())?.state)).toBe("active");
  });

  it("one end requestId cannot complete a second run", async () => {
    const { t, routeA } = await setup();
    const first = (await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).body.runId as string;
    const end = endBody(first, { lastRunSequence: null });
    await post(t, "/device/v1/trip-events", SECRET_A, end);
    const second = (
      await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA, { requestId: "33333333-4444-4555-8666-777777777777" }))
    ).body.runId as string;
    const r = await post(t, "/device/v1/trip-events", SECRET_A, { ...end, runId: second });
    expect(r.status).toBe(409);
    const states = await t.run(async (ctx) => (await ctx.db.query("runs").collect()).map((x) => x.state));
    expect(states.toSorted()).toEqual(["active", "completed"]);
  });

  it("a start retry after the run ended still returns the original active response", async () => {
    const { t, routeA } = await setup();
    const start = startBody(routeA);
    const first = await post(t, "/device/v1/trip-events", SECRET_A, start);
    await post(t, "/device/v1/trip-events", SECRET_A, endBody(first.body.runId as string, { lastRunSequence: null }));
    const retry = await post(t, "/device/v1/trip-events", SECRET_A, start);
    const { serverNowMs: _a, ...original } = first.body;
    const { serverNowMs: _b, ...again } = retry.body;
    expect(again).toEqual(original);
    expect(again).toMatchObject({ state: "active", endedAtMs: null });
  });

  it("with an invalid grant, an owned run and an unknown run look the same", async () => {
    const { t, routeA } = await setup();
    const runId = (await post(t, "/device/v1/trip-events", SECRET_A, startBody(routeA))).body.runId as string;
    const forged = { driverOperatingGrant: "f".repeat(64) };
    const owned = await post(t, "/device/v1/trip-events", SECRET_A, endBody(runId, forged));
    const unknown = await post(t, "/device/v1/trip-events", SECRET_A, endBody("not_a_run", forged));
    expect(owned.status).toBe(unknown.status);
    expect(owned.body).toEqual(unknown.body);
  });
});
