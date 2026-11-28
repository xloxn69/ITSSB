import { MAX_DELIVERY_ATTEMPTS } from "@itssb/contracts";
import { myAlertsReady, myPreferenceDefault, registerDeviceRegistered } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import { retryDelayMs } from "./notificationJobs";
import { BASELINE_V1 } from "./lib/eta";
import schema from "./schema";

/**
 * Server-side approaching alerts and their delivery outbox (docs/10 §8–10).
 * Fictional people and coordinates only. Ingest and the worker take `nowMs`
 * explicitly; it is relative to the real clock because queries use it.
 */

const modules = import.meta.glob("./**/*.ts");

const BASE = { latitude: 34.1, longitude: -83.99 };
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.latitude * Math.PI) / 180);
const at = (east: number) => ({ latitude: BASE.latitude, longitude: BASE.longitude + east / M_PER_DEG_LON });

const STUDENT = "test|student";
const GUARDIAN = "test|guardian";
const STRANGER = "test|stranger";
const GRANT = "g".repeat(64);
const STOPS_EAST = [1000, 2500, 3500];
const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
/** The student's phone. */
const INSTALL_A = "11111111-1111-4111-8111-111111111111";

// Alert evaluation runs as a scheduled function after telemetry commits; fake
// timers let each test run it deterministically. Date stays real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const NOW = Date.now();
  const ids = await t.run(async (ctx) => {
    const studentUser = await ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" });
    const guardianUser = await ctx.db.insert("users", { tokenIdentifier: GUARDIAN, role: "family", displayName: "Pat" });
    await ctx.db.insert("users", { tokenIdentifier: STRANGER, role: "family", displayName: "Lee" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana" });
    const routeVersionId = await ctx.db.insert("routeVersions", {
      label: "Route 17 Morning",
      path: Array.from({ length: 401 }, (_, i) => at(i * 10)),
    });
    const stopIds: Id<"stops">[] = [];
    for (const [sequence, east] of STOPS_EAST.entries()) {
      stopIds.push(await ctx.db.insert("stops", { routeVersionId, label: `Stop ${sequence + 1}`, sequence, ...at(east) }));
    }
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId,
      stopId: stopIds[2]!,
      status: "approved",
    });
    const guardianLinkId = await ctx.db.insert("guardianLinks", {
      guardianUserId: guardianUser,
      studentId,
      status: "approved",
    });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: "x", revoked: false });
    await ctx.db.insert("driverGrants", {
      tokenHash: await sha256Hex(GRANT),
      deviceId,
      driverUserId: driver,
      routeVersionIds: [routeVersionId],
      issuedAtMs: NOW - 3600_000,
      expiresAtMs: NOW + 3600_000,
      revoked: false,
    });
    const runId = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId,
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: NOW - 300_000,
      startCapturedAtMs: NOW - 300_000,
    });
    return { assignmentId, deviceId, runId, guardianLinkId, studentUser, guardianUser };
  });
  return { t, NOW, ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

let seq = 0;
function event(runId: string, east: number, capturedAtMs: number) {
  seq += 1;
  return {
    eventId: crypto.randomUUID(),
    bootId: "3cd44c56-c96b-4b83-a970-5414990bc25a",
    sequence: seq,
    runSequence: seq,
    runId,
    capturedAtMs,
    ...at(east),
    speedMps: 8,
    headingDegrees: 90,
    horizontalAccuracyM: 5,
    fixMode: 3 as const,
  };
}

/** Distance east at which the baseline puts the assigned (third) stop `seconds` away. */
function eastForRemaining(seconds: number) {
  // Stop 1 departed, stop 2 still ahead: one dwell is counted.
  return STOPS_EAST[2]! - (seconds - BASELINE_V1.dwellMs / 1000) * BASELINE_V1.cruiseSpeedMps;
}

/** Drives the bus from the start to `east`, ending at `endCapturedAtMs`. */
type IngestArgs = { deviceId: Id<"devices">; events: unknown[]; nowMs: number };

/** Ingests a batch, then runs the alert evaluation it scheduled. */
async function ingest(s: { t: ReturnType<typeof convexTest> }, args: IngestArgs) {
  const result = await s.t.mutation(internal.telemetry.ingestBatch, args);
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return result;
}

async function driveTo(s: Setup, east: number, endCapturedAtMs: number) {
  const events = [];
  const steps = Math.ceil(east / 50);
  for (let i = 1; i <= steps; i++) {
    events.push(event(s.runId, Math.min(east, i * 50), endCapturedAtMs - (steps - i) * 5_000));
  }
  for (let i = 0; i < events.length; i += 40) {
    const batch = events.slice(i, i + 40);
    await ingest(s, {
      deviceId: s.deviceId,
      events: batch,
      nowMs: batch.at(-1)!.capturedAtMs + 1_000,
    });
  }
}

async function enable(s: Setup, who: string, minutes = 5, enabled = true) {
  return await s.t.withIdentity({ tokenIdentifier: who }).mutation(api.notifications.setPreferences, {
    requestId: crypto.randomUUID(),
    assignmentId: s.assignmentId,
    approachingEnabled: enabled,
    approachingMinutes: minutes,
  });
}

async function register(s: Setup, who: string, token: string, installationId = crypto.randomUUID()) {
  return await s.t.withIdentity({ tokenIdentifier: who }).mutation(api.notifications.registerDevice, {
    installationId,
    apnsToken: token,
    environment: "sandbox",
    permission: "authorized",
  });
}

/** Same keys, recursively, as a canonical fixture (values and IDs differ). */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 0 ? [shape(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return value === null ? null : typeof value;
}

const alerts = (s: Setup) => s.t.run((ctx) => ctx.db.query("alerts").collect());
const jobs = (s: Setup) => s.t.run((ctx) => ctx.db.query("notificationJobs").collect());

/** Bus approaching: the assigned stop is 4 minutes away at `nowMs`. */
async function approach(s: Setup) {
  await driveTo(s, eastForRemaining(240), s.NOW - 2_000);
}

describe("notification preferences", () => {
  it("saves and reads the caller's own preference; defaults are off", async () => {
    const s = await setup();
    const student = s.t.withIdentity({ tokenIdentifier: STUDENT });
    const before = await student.query(api.notifications.myPreference, { assignmentId: s.assignmentId });
    expect(before).toMatchObject({
      status: "ready",
      preference: { approachingEnabled: false, approachingMinutes: 5, updatedAtMs: null },
    });
    expect(shape(before)).toEqual(shape(myPreferenceDefault));
    expect(await enable(s, STUDENT, 7)).toMatchObject({ status: "saved", preference: { approachingMinutes: 7 } });
    const after = await student.query(api.notifications.myPreference, { assignmentId: s.assignmentId });
    expect(after).toMatchObject({ preference: { approachingEnabled: true, approachingMinutes: 7 } });
    // The guardian's preference is separate.
    const guardian = await s.t
      .withIdentity({ tokenIdentifier: GUARDIAN })
      .query(api.notifications.myPreference, { assignmentId: s.assignmentId });
    expect(guardian).toMatchObject({ preference: { approachingEnabled: false } });
  });

  it("refuses a stranger and an out-of-range threshold", async () => {
    const s = await setup();
    expect(await enable(s, STRANGER)).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
    expect(await enable(s, STUDENT, 0)).toMatchObject({ status: "invalid" });
    expect(await enable(s, STUDENT, 31)).toMatchObject({ status: "invalid" });
    expect(await enable(s, STUDENT, 2.5)).toMatchObject({ status: "invalid" });
  });
});

describe("approaching alerts", () => {
  it("creates one alert per recipient when a fresh estimate enters the threshold", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await enable(s, GUARDIAN);
    await register(s, STUDENT, TOKEN_A);
    await register(s, GUARDIAN, TOKEN_B);
    await approach(s);
    const rows = await alerts(s);
    expect(rows.map((a) => a.userId).toSorted()).toEqual([s.studentUser, s.guardianUser].toSorted());
    expect(rows.every((a) => a.type === "approaching" && a.runId === s.runId)).toBe(true);
    const j = await jobs(s);
    expect(j).toHaveLength(2);
    expect(j.every((x) => x.state === "pending" && x.attempts === 0)).toBe(true);
  });

  it("an estimate moving back and forth across the threshold still yields one alert", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A);
    // The bus waits at a light 5:05 from the stop. Upload lag makes the
    // estimate measured from server time read 5:04, 4:57, 5:04, 4:57, …
    const east = eastForRemaining(305);
    await driveTo(s, east, s.NOW - 120_000);
    for (let i = 0; i < 8; i++) {
      // Recent enough that evaluation, which checks freshness again on the real clock, still runs.
      const captured = s.NOW - 21_000 + i * 3_000;
      const lag = i % 2 === 0 ? 1_000 : 8_000;
      await ingest(s, {
        deviceId: s.deviceId,
        events: [event(s.runId, east, captured)],
        nowMs: captured + lag,
      });
    }
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toHaveLength(1);
  });

  it("no alert while the estimate is above the threshold or the preference is off", async () => {
    const s = await setup();
    await enable(s, STUDENT, 3);
    await enable(s, GUARDIAN, 5, false);
    await register(s, STUDENT, TOKEN_A);
    await register(s, GUARDIAN, TOKEN_B);
    await approach(s); // 4 minutes away
    expect(await alerts(s)).toEqual([]);
  });

  it("stale input never creates an alert, even when the estimate is inside the threshold", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A);
    // A drained offline batch: positions captured a minute before upload.
    const east = eastForRemaining(240);
    const events = [];
    for (let d = 50; d <= east; d += 50) events.push(event(s.runId, d, s.NOW - 300_000 + d * 100));
    events.push(event(s.runId, east, s.NOW - 60_000));
    for (let i = 0; i < events.length; i += 40) {
      await ingest(s, {
        deviceId: s.deviceId,
        events: events.slice(i, i + 40),
        nowMs: s.NOW,
      });
    }
    expect(await alerts(s)).toEqual([]);
  });

  it("an alert is kept in the inbox even with no registered push token", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await approach(s);
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toEqual([]);
    const inbox = await s.t.withIdentity({ tokenIdentifier: STUDENT }).query(api.notifications.myAlerts, {});
    expect(inbox).toMatchObject({ status: "ready", alerts: [{ type: "approaching", stopLabel: "Stop 3" }] });
    expect(shape(inbox)).toEqual(shape(myAlertsReady));
    if (inbox.status !== "ready") return;
    expect(inbox.alerts[0]!.predictionGeneratedAtMs).toBeGreaterThan(0);
    const other = await s.t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.notifications.myAlerts, {});
    expect(other).toMatchObject({ status: "ready", alerts: [] });
  });
});

async function oneJob() {
  const s = await setup();
  await enable(s, STUDENT);
  await register(s, STUDENT, TOKEN_A, INSTALL_A);
  await approach(s);
  const [job] = await jobs(s);
  if (!job) throw new Error("no job");
  return { s, jobId: job._id };
}
/** The bus waits where `approach` left it, reporting a fresh fix at `atMs`. */
async function keepFresh(s: Setup, atMs: number) {
  await s.t.mutation(internal.telemetry.ingestBatch, {
    deviceId: s.deviceId,
    events: [event(s.runId, eastForRemaining(240), atMs - 1_000)],
    nowMs: atMs,
  });
}

const claim = (s: Setup, jobId: Id<"notificationJobs">, nowMs: number, leaseId = crypto.randomUUID()) =>
  s.t.mutation(internal.notificationJobs.claim, { jobId, leaseId, nowMs }).then((r) => ({ r, leaseId }));
const job = (s: Setup, jobId: Id<"notificationJobs">) => s.t.run((ctx) => ctx.db.get(jobId));

describe("delivery jobs", () => {
  it("claims once per lease; the payload carries no student details", async () => {
    const { s, jobId } = await oneJob();
    const first = await claim(s, jobId, s.NOW);
    expect(first.r).toMatchObject({ token: TOKEN_A, environment: "sandbox", attempt: 1 });
    expect(JSON.stringify(first.r)).not.toMatch(/Sam|Stop 3/);
    expect((await claim(s, jobId, s.NOW + 1_000)).r).toBeNull();
    await s.t.mutation(internal.notificationJobs.record, {
      jobId,
      leaseId: first.leaseId,
      result: { kind: "accepted" },
      nowMs: s.NOW + 2_000,
    });
    expect(await job(s, jobId)).toMatchObject({ state: "provider_accepted" });
    // Accepted is final: nothing claims or resends it.
    expect((await claim(s, jobId, s.NOW + 600_000)).r).toBeNull();
  });

  it("retries are bounded and back off", async () => {
    const { s, jobId } = await oneJob();
    let nowMs = s.NOW;
    const waits: number[] = [];
    const states: string[] = [];
    const attempts: unknown[] = [];
    const dueEarly: unknown[] = [];
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      const c = await claim(s, jobId, nowMs);
      attempts.push((c.r as { attempt?: number } | null)?.attempt);
      await s.t.mutation(internal.notificationJobs.record, {
        jobId,
        leaseId: c.leaseId,
        result: { kind: "retryable", reason: "ServiceUnavailable" },
        nowMs,
      });
      const row = (await job(s, jobId))!;
      states.push(row.state);
      if (row.state !== "retryable_failure") break;
      dueEarly.push((await claim(s, jobId, nowMs)).r); // not due yet
      waits.push(row.nextAttemptAtMs - nowMs);
      nowMs = row.nextAttemptAtMs;
      await keepFresh(s, nowMs);
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(states).toEqual([...Array(MAX_DELIVERY_ATTEMPTS - 1).fill("retryable_failure"), "permanent_failure"]);
    expect(dueEarly).toEqual(Array(MAX_DELIVERY_ATTEMPTS - 1).fill(null));
    expect(waits).toEqual(waits.toSorted((a, b) => a - b));
    expect((await claim(s, jobId, nowMs + 3600_000)).r).toBeNull();
  });

  it("a job past its expiry is expired, never sent, even by the recovery sweep", async () => {
    const { s, jobId } = await oneJob();
    const row = (await job(s, jobId))!;
    await s.t.mutation(internal.notificationJobs.sweep, { nowMs: row.expiresAtMs + 1 });
    expect(await job(s, jobId)).toMatchObject({ state: "expired" });
    expect((await claim(s, jobId, row.expiresAtMs + 2)).r).toBeNull();
  });

  it("a lease that expired mid-send is reclaimed by the sweep with the same job identity", async () => {
    const { s, jobId } = await oneJob();
    const first = await claim(s, jobId, s.NOW);
    expect(first.r).not.toBeNull();
    await keepFresh(s, s.NOW + 120_000);
    await s.t.mutation(internal.notificationJobs.sweep, { nowMs: s.NOW + 120_000 });
    const second = await claim(s, jobId, s.NOW + 120_000);
    expect(second.r).toMatchObject({ attempt: 2, collapseId: (first.r as { collapseId: string }).collapseId });
    // The stale lease can no longer record a result.
    await s.t.mutation(internal.notificationJobs.record, {
      jobId,
      leaseId: first.leaseId,
      result: { kind: "accepted" },
      nowMs: s.NOW + 121_000,
    });
    expect(await job(s, jobId)).toMatchObject({ state: "in_progress" });
  });

  it("completing the run through a trip event stops its pending jobs", async () => {
    const { s, jobId } = await oneJob();
    const outcome = await s.t.mutation(internal.tripEvents.apply, {
      deviceId: s.deviceId,
      grantHash: await sha256Hex(GRANT),
      request: {
        schemaVersion: 1,
        requestId: "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f",
        type: "endRun",
        driverOperatingGrant: GRANT,
        runId: s.runId,
        capturedAtMs: Date.now() - 500,
        lastRunSequence: seq,
      },
      nowMs: Date.now(),
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "run_not_active" });
    expect((await claim(s, jobId, Date.now())).r).toBeNull();
  });

  it("a run cancelled between enqueue and send is not sent", async () => {
    const { s, jobId } = await oneJob();
    await s.t.run((ctx) => ctx.db.patch(s.runId, { state: "cancelled" }));
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "run_not_active" });
  });

  it("a revoked guardian link stops the guardian's job and hides the alert", async () => {
    const s = await setup();
    await enable(s, GUARDIAN);
    await register(s, GUARDIAN, TOKEN_B);
    await approach(s);
    const [j] = await jobs(s);
    await s.t.run((ctx) => ctx.db.patch(s.guardianLinkId, { status: "revoked" }));
    expect((await claim(s, j!._id, s.NOW)).r).toBeNull();
    expect(await job(s, j!._id)).toMatchObject({ state: "cancelled", endReason: "access_revoked" });
    const inbox = await s.t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.notifications.myAlerts, {});
    expect(inbox).toMatchObject({ status: "ready", alerts: [] });
  });

  it("a revoked assignment stops the job", async () => {
    const { s, jobId } = await oneJob();
    await s.t.run((ctx) => ctx.db.patch(s.assignmentId, { status: "revoked" }));
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "access_revoked" });
  });

  it("turning the preference off before send stops the job", async () => {
    const { s, jobId } = await oneJob();
    await enable(s, STUDENT, 5, false);
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "preference_off" });
  });

  it("a token that moved to another account is not used for the first", async () => {
    const { s, jobId } = await oneJob();
    // The same phone signs in as the guardian and registers the same token.
    await register(s, GUARDIAN, TOKEN_A, INSTALL_A);
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "token_inactive" });
  });

  it("a permanent token failure disables the token", async () => {
    const { s, jobId } = await oneJob();
    const c = await claim(s, jobId, s.NOW);
    await s.t.mutation(internal.notificationJobs.record, {
      jobId,
      leaseId: c.leaseId,
      result: { kind: "permanent_token", reason: "Unregistered" },
      nowMs: s.NOW,
    });
    expect(await job(s, jobId)).toMatchObject({ state: "permanent_failure" });
    const tokens = await s.t.run((ctx) => ctx.db.query("pushTokens").collect());
    expect(tokens.map((x) => x.active)).toEqual([false]);
  });
});

describe("device registration", () => {
  it("re-registering an installation replaces its token; denied permission disables push", async () => {
    const s = await setup();
    const installationId = crypto.randomUUID();
    const first = await register(s, STUDENT, TOKEN_A, installationId);
    expect(first).toMatchObject({ status: "registered", pushEnabled: true });
    expect(shape(first)).toEqual(shape(registerDeviceRegistered));
    await register(s, STUDENT, TOKEN_B, installationId);
    const rows = await s.t.run((ctx) => ctx.db.query("pushTokens").collect());
    expect(rows.filter((r) => r.active).map((r) => r.token)).toEqual([TOKEN_B]);
    const denied = await s.t.withIdentity({ tokenIdentifier: STUDENT }).mutation(api.notifications.registerDevice, {
      installationId,
      apnsToken: null,
      environment: "sandbox",
      permission: "denied",
    });
    expect(denied).toMatchObject({ status: "registered", pushEnabled: false });
  });

  it("refuses a malformed token and a signed-out caller", async () => {
    const s = await setup();
    expect(await register(s, STUDENT, "not-hex")).toMatchObject({ status: "invalid" });
    const r = await s.t.mutation(api.notifications.registerDevice, {
      installationId: crypto.randomUUID(),
      apnsToken: TOKEN_A,
      environment: "sandbox",
      permission: "authorized",
    });
    expect(r).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
  });
});

describe("independent review cases", () => {
  it("a token held by another phone is refused, and that phone keeps it", async () => {
    const s = await setup();
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    const stolen = await register(s, GUARDIAN, TOKEN_A, crypto.randomUUID());
    expect(stolen).toMatchObject({ status: "invalid" });
    const rows = await s.t.run((ctx) => ctx.db.query("pushTokens").collect());
    expect(rows.filter((r) => r.active).map((r) => r.userId)).toEqual([s.studentUser]);
  });

  it("telemetry never fans out alerts in its own transaction; evaluation pages through every recipient", async () => {
    const s = await setup();
    const extra = 30;
    await s.t.run(async (ctx) => {
      const assignment = (await ctx.db.get(s.assignmentId))!;
      for (let i = 0; i < extra; i++) {
        const userId = await ctx.db.insert("users", { tokenIdentifier: `test|kid${i}`, role: "family", displayName: `K${i}` });
        const studentId = await ctx.db.insert("students", { displayName: `Kid ${i}`, userId });
        const assignmentId = await ctx.db.insert("assignments", {
          studentId,
          routeVersionId: assignment.routeVersionId,
          stopId: assignment.stopId,
          status: "approved",
        });
        await ctx.db.insert("notificationPreferences", {
          userId,
          assignmentId,
          approachingEnabled: true,
          approachingMinutes: 5,
          updatedAtMs: s.NOW,
          lastRequestId: crypto.randomUUID(),
        });
        await ctx.db.insert("pushTokens", {
          userId,
          installationId: crypto.randomUUID(),
          token: (i + 10).toString(16).padStart(2, "0").repeat(32),
          environment: "sandbox",
          permission: "authorized",
          active: true,
          updatedAtMs: s.NOW,
        });
      }
    });
    // Well outside the threshold first, then one fresh fix 4 minutes out.
    await driveTo(s, 400, s.NOW - 200_000);
    expect(await alerts(s)).toEqual([]);
    await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [event(s.runId, eastForRemaining(240), s.NOW - 2_000)],
      nowMs: s.NOW - 1_000,
    });
    expect(await alerts(s)).toEqual([]); // nothing inside the telemetry transaction
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alerts(s)).toHaveLength(extra);
    expect(await jobs(s)).toHaveLength(extra);
  });

  it("a permanent failure for an old token does not disable the phone's new token", async () => {
    const { s, jobId } = await oneJob();
    const c = await s.t.mutation(internal.notificationJobs.claim, { jobId, leaseId: "lease-1", nowMs: s.NOW });
    expect(c).not.toBeNull();
    await register(s, STUDENT, TOKEN_B, INSTALL_A); // the phone's token rotated mid-send
    await s.t.mutation(internal.notificationJobs.record, {
      jobId,
      leaseId: "lease-1",
      result: { kind: "permanent_token", reason: "BadDeviceToken" },
      nowMs: s.NOW,
    });
    const rows = await s.t.run((ctx) => ctx.db.query("pushTokens").collect());
    expect(rows.map((r) => [r.token, r.active])).toEqual([[TOKEN_B, true]]);
  });

  it("a job expires at the predicted arrival, never after it", async () => {
    const { s, jobId } = await oneJob();
    const [alert] = await alerts(s);
    const row = await s.t.run((ctx) => ctx.db.get(jobId));
    expect(row!.expiresAtMs).toBe(alert!.predictedArrivalAtMs);
    const late = await s.t.mutation(internal.notificationJobs.claim, {
      jobId,
      leaseId: "lease-late",
      nowMs: alert!.predictedArrivalAtMs,
    });
    expect(late).toBeNull();
  });

  it("no delivery job when the bus is already due; the inbox still has the alert", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    await driveTo(s, 400, s.NOW - 200_000);
    // A fix 20 s from the stop, uploaded 24 s late: still fresh enough to
    // alert, but the predicted arrival has already passed.
    await ingest(s, {
      deviceId: s.deviceId,
      events: [event(s.runId, STOPS_EAST[2]! - 20 * BASELINE_V1.cruiseSpeedMps, s.NOW - 25_000)],
      nowMs: s.NOW - 1_000,
    });
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toEqual([]);
  });

  it("a delayed retry of an older save never reverses a newer opt-out", async () => {
    const s = await setup();
    const student = s.t.withIdentity({ tokenIdentifier: STUDENT });
    const enableReq = { requestId: crypto.randomUUID(), assignmentId: s.assignmentId, approachingEnabled: true, approachingMinutes: 5 };
    await student.mutation(api.notifications.setPreferences, enableReq);
    await student.mutation(api.notifications.setPreferences, {
      ...enableReq,
      requestId: crypto.randomUUID(),
      approachingEnabled: false,
    });
    const replay = await student.mutation(api.notifications.setPreferences, enableReq);
    expect(replay).toMatchObject({ status: "saved", preference: { approachingEnabled: false } });
  });
});

describe("independent re-review cases", () => {
  it("an evaluation queued before a newer off-route fix creates no alert", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    await driveTo(s, 400, s.NOW - 200_000);
    // Approaching fix and a newer off-route fix commit before the evaluation runs.
    await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [event(s.runId, eastForRemaining(240), s.NOW - 4_000)],
      nowMs: s.NOW - 3_500,
    });
    await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [{ ...event(s.runId, eastForRemaining(235), s.NOW - 2_000), latitude: 34.103 }],
      nowMs: s.NOW - 1_500,
    });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alerts(s)).toEqual([]);
  });

  it("an evaluation that runs after its source went stale creates no alert", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    const stale = Date.now() - 60_000;
    const stopId = (await s.t.run((ctx) => ctx.db.get(s.assignmentId)))!.stopId;
    await s.t.mutation(internal.alerts.evaluate, {
      runId: s.runId,
      sourceEventId: "late-event",
      sourceCapturedAtMs: stale,
      estimates: [{ stopId, arrivalAtMs: Date.now() + 60_000, validUntilMs: Date.now() + 60_000, generatedAtMs: stale }],
      nowMs: stale + 1_000,
      cursor: null,
    });
    expect(await alerts(s)).toEqual([]);
  });

  it("the same account may move its token to a reinstalled app's new installation", async () => {
    const s = await setup();
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    const reinstalled = crypto.randomUUID();
    expect(await register(s, STUDENT, TOKEN_A, reinstalled)).toMatchObject({ status: "registered", pushEnabled: true });
    const rows = await s.t.run((ctx) => ctx.db.query("pushTokens").collect());
    expect(rows.filter((r) => r.active).map((r) => r.installationId)).toEqual([reinstalled]);
  });

  it("a job is not sent once the bus has passed the stop", async () => {
    const { s, jobId } = await oneJob();
    await s.t.run(async (ctx) => {
      const progress = await ctx.db.query("runProgress").first();
      const assignment = await ctx.db.get(s.assignmentId);
      await ctx.db.patch(progress!._id, {
        stops: progress!.stops.map((o) =>
          o.stopId === assignment!.stopId ? { ...o, departedAtMs: s.NOW } : o,
        ),
      });
    });
    const r = await s.t.mutation(internal.notificationJobs.claim, { jobId, leaseId: "l", nowMs: s.NOW });
    expect(r).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ state: "cancelled", endReason: "stop_reached" });
  });
});

describe("independent review final cases", () => {
  it("a retry after the bus went off route is not sent", async () => {
    const { s, jobId } = await oneJob();
    const first = await claim(s, jobId, s.NOW);
    await s.t.mutation(internal.notificationJobs.record, {
      jobId,
      leaseId: first.leaseId,
      result: { kind: "retryable", reason: "ServiceUnavailable" },
      nowMs: s.NOW,
    });
    await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [{ ...event(s.runId, eastForRemaining(235), s.NOW + 1_000), latitude: 34.103 }],
      nowMs: s.NOW + 1_500,
    });
    const row = (await s.t.run((ctx) => ctx.db.get(jobId)))!;
    expect((await claim(s, jobId, row.nextAttemptAtMs)).r).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ state: "cancelled", endReason: "estimate_unavailable" });
  });

  it("a pending job is not sent once the bus has stopped reporting", async () => {
    const { s, jobId } = await oneJob();
    expect((await claim(s, jobId, s.NOW + 90_000)).r).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.get(jobId))).toMatchObject({ state: "cancelled", endReason: "estimate_unavailable" });
  });
});

// ── Acceptance gaps (docs/13 §4 D11, §8) ────────────────────────────────

type Scheduled = { name: string; args: unknown[]; state: { kind: string } };
const scheduled = (s: Setup) =>
  s.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()) as unknown as Scheduled[]);
const pendingCalls = async (s: Setup, name: string) =>
  (await scheduled(s)).filter((f) => f.name.includes(name) && f.state.kind === "pending");

describe("acceptance: one alert per approach", () => {
  it("re-sending the approaching event (same eventId) adds no alert, job, event or evaluation", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    await approach(s);
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toHaveLength(1);
    const { last, count } = await s.t.run(async (ctx) => {
      const progress = await ctx.db.query("runProgress").first();
      const row = await ctx.db
        .query("telemetryEvents")
        .withIndex("by_event_id", (q) => q.eq("eventId", progress!.lastEventId!))
        .unique();
      return { last: row!, count: (await ctx.db.query("telemetryEvents").collect()).length };
    });
    const resent = {
      eventId: last.eventId,
      bootId: last.bootId,
      sequence: last.sequence,
      runSequence: last.runSequence,
      runId: last.runId,
      capturedAtMs: last.capturedAtMs,
      latitude: last.latitude,
      longitude: last.longitude,
      speedMps: last.speedMps ?? null,
      headingDegrees: last.headingDegrees ?? null,
      horizontalAccuracyM: last.horizontalAccuracyM ?? null,
      fixMode: last.fixMode,
    };
    const results = await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [resent],
      nowMs: Date.now(),
    });
    expect(results).toEqual([{ eventId: last.eventId, status: "duplicate", receivedAtMs: last.receivedAtMs, liveStateApplied: true }]);
    expect(await pendingCalls(s, "alerts")).toEqual([]);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toHaveLength(1);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("telemetryEvents").collect()).length)).toBe(count);
  });

  it("evaluating the same source twice makes one alert and one delivery job", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await register(s, STUDENT, TOKEN_A, INSTALL_A);
    // Drive close but outside the threshold, so the ingest itself alerts nobody.
    await driveTo(s, 400, s.NOW - 200_000);
    await s.t.mutation(internal.telemetry.ingestBatch, {
      deviceId: s.deviceId,
      events: [event(s.runId, eastForRemaining(240), Date.now() - 2_000)],
      nowMs: Date.now() - 1_000,
    });
    const source = await s.t.run(async (ctx) => {
      const progress = (await ctx.db.query("runProgress").first())!;
      const predictions = (await ctx.db.query("etaPredictions").collect()).filter((p) => p.sourceEventId === progress.lastEventId);
      return {
        sourceEventId: progress.lastEventId!,
        sourceCapturedAtMs: predictions[0]!.sourceCapturedAtMs,
        estimates: predictions.map((p) => ({
          stopId: p.stopId,
          arrivalAtMs: p.arrivalAtMs,
          validUntilMs: p.validUntilMs,
          generatedAtMs: p.generatedAtMs,
        })),
      };
    });
    expect(source.estimates.length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      await s.t.mutation(internal.alerts.evaluate, { runId: s.runId, ...source, nowMs: Date.now(), cursor: null });
    }
    // Plus the evaluation the ingest scheduled itself: three runs, one alert.
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await alerts(s)).toHaveLength(1);
    expect(await jobs(s)).toHaveLength(1);
  });
});

describe("acceptance: the recovery sweep leaves finished jobs alone", () => {
  it("accepted, permanently failed and cancelled jobs are never rescheduled; a due pending job is", async () => {
    const { s, jobId } = await oneJob();
    const finished = await s.t.run(async (ctx) => {
      const base = (await ctx.db.get(jobId))!;
      const { _id, _creationTime, ...fields } = base;
      const ids: Id<"notificationJobs">[] = [];
      for (const state of ["provider_accepted", "permanent_failure", "cancelled"] as const) {
        ids.push(
          await ctx.db.insert("notificationJobs", {
            ...fields,
            state,
            attempts: 1,
            nextAttemptAtMs: s.NOW - 60_000,
            leaseExpiresAtMs: s.NOW - 30_000,
          }),
        );
      }
      return ids;
    });
    const before = await s.t.run(async (ctx) => Promise.all(finished.map((id) => ctx.db.get(id))));
    await s.t.mutation(internal.notificationJobs.sweep, { nowMs: s.NOW + 1_000 });
    const queued = (await pendingCalls(s, "pushDelivery")).map((f) => (f.args[0] as { jobId: string }).jobId);
    expect(queued).toEqual([jobId]);
    expect(await s.t.run(async (ctx) => Promise.all(finished.map((id) => ctx.db.get(id))))).toEqual(before);
  });
});

/** Ingests fixes at the given positions and capture times, in batches. */
async function drive(s: Setup, points: { east: number; at: number }[]) {
  for (let i = 0; i < points.length; i += 40) {
    const batch = points.slice(i, i + 40).map((p) => event(s.runId, p.east, p.at));
    await ingest(s, { deviceId: s.deviceId, events: batch, nowMs: batch.at(-1)!.capturedAtMs + 1_000 });
  }
}

describe("acceptance: D11 an already-served stop on a loop route", () => {
  const OUT_EAST = 500;

  /** Puts the run on an out-and-back route whose two stops share one place. */
  async function loopSetup() {
    const s = await setup();
    const ids = await s.t.run(async (ctx) => {
      const out = Array.from({ length: 201 }, (_, i) => at(i * 10));
      const loop = await ctx.db.insert("routeVersions", {
        label: "Route 9 Loop",
        path: [...out, ...out.toReversed().slice(1)],
      });
      const outStop = await ctx.db.insert("stops", { routeVersionId: loop, label: "Elm (outbound)", sequence: 0, ...at(OUT_EAST) });
      const backStop = await ctx.db.insert("stops", { routeVersionId: loop, label: "Elm (return)", sequence: 1, ...at(OUT_EAST) });
      await ctx.db.patch(s.runId, { routeVersionId: loop });
      await ctx.db.patch(s.assignmentId, { routeVersionId: loop, stopId: outStop });
      // A second student who boards at the return-leg stop.
      const backUser = await ctx.db.insert("users", { tokenIdentifier: "test|back-rider", role: "family", displayName: "Jo" });
      const backStudent = await ctx.db.insert("students", { displayName: "Jo Example", userId: backUser });
      const backAssignment = await ctx.db.insert("assignments", { studentId: backStudent, routeVersionId: loop, stopId: backStop, status: "approved" });
      await ctx.db.insert("notificationPreferences", {
        userId: backUser,
        assignmentId: backAssignment,
        approachingEnabled: true,
        approachingMinutes: 5,
        updatedAtMs: s.NOW,
        lastRequestId: crypto.randomUUID(),
      });
      return { outStop, backUser, backAssignment };
    });
    return { s, ...ids };
  }

  it("the outbound stop stays passed with its original times, and the return leg alerts only the return stop", async () => {
    const { s, outStop, backUser, backAssignment } = await loopSetup();
    await enable(s, STUDENT); // the outbound stop's student wants alerts
    const outbound = [];
    for (let d = 50; d <= 2000; d += 50) outbound.push(d);
    const back = [];
    for (let d = 1950; d >= 700; d -= 50) back.push(d);
    const end = Date.now() - 2_000;
    const step = 4_000;
    const all = [...outbound, ...back].map((east, i, xs) => ({ east, at: end - (xs.length - 1 - i) * step }));

    // Outbound, long enough ago that it alerts nobody.
    await drive(s, all.slice(0, outbound.length));
    const served = await s.t.run(async (ctx) => (await ctx.db.query("runProgress").first())!.stops.find((o) => o.stopId === outStop));
    expect(served).toMatchObject({ arrivedAtMs: expect.any(Number), departedAtMs: expect.any(Number) });
    expect(await alerts(s)).toEqual([]);

    // Return leg, the last fix fresh, approaching the same place again.
    await drive(s, all.slice(outbound.length));
    const progress = (await s.t.run((ctx) => ctx.db.query("runProgress").first()))!;
    expect(progress.lastStatus).toBe("on_route");
    expect(progress.alongM).toBeGreaterThan(3000);
    expect(progress.stops.find((o) => o.stopId === outStop)).toEqual(served);
    // The return stop's rider is alerted once; the already-served stop's rider never is.
    const rows = await alerts(s);
    expect(rows.map((a) => [a.userId, a.assignmentId])).toEqual([[backUser, backAssignment]]);
    const predictions = await s.t.run((ctx) => ctx.db.query("etaPredictions").collect());
    expect(predictions.filter((p) => p.stopId === outStop && p.sourceEventId === progress.lastEventId)).toEqual([]);
  });
});

describe("acceptance: the inbox needs a sign-in", () => {
  it("a signed-out caller gets only an access answer", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await approach(s);
    expect(await alerts(s)).toHaveLength(1);
    const result = await s.t.query(api.notifications.myAlerts, {});
    expect(Object.keys(result).toSorted()).toEqual(["reason", "schemaVersion", "serverNowMs", "status"]);
    expect(result).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
  });
});

describe("access answers for a caller with no approved person", () => {
  // A verified sign-in that staff have not linked yet (a pending family) must
  // hear `not_permitted`, as tracking does (#28); `unauthenticated` would tell
  // the app to sign in again, and signing in again changes nothing.
  const UNLINKED = "test|unlinked";
  const calls = (s: Setup) =>
    [
      ["myAlerts", (t: Setup["t"]) => t.query(api.notifications.myAlerts, {})],
      ["myPreference", (t: Setup["t"]) => t.query(api.notifications.myPreference, { assignmentId: s.assignmentId })],
      [
        "setPreferences",
        (t: Setup["t"]) =>
          t.mutation(api.notifications.setPreferences, {
            requestId: crypto.randomUUID(),
            assignmentId: s.assignmentId,
            approachingEnabled: true,
            approachingMinutes: 5,
          }),
      ],
      [
        "registerDevice",
        (t: Setup["t"]) =>
          t.mutation(api.notifications.registerDevice, {
            installationId: crypto.randomUUID(),
            apnsToken: TOKEN_A,
            environment: "sandbox",
            permission: "authorized",
          }),
      ],
    ] as const;

  it("a signed-in but unlinked caller is not_permitted and nothing is stored", async () => {
    const s = await setup();
    for (const [name, call] of calls(s)) {
      const r = await call(s.t.withIdentity({ tokenIdentifier: UNLINKED }) as Setup["t"]);
      expect({ name, r }).toMatchObject({ name, r: { status: "access_unavailable", reason: "not_permitted" } });
    }
    expect(await s.t.run((ctx) => ctx.db.query("pushTokens").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("notificationPreferences").collect())).toEqual([]);
  });

  it("a signed-out caller is unauthenticated", async () => {
    const s = await setup();
    for (const [name, call] of calls(s)) {
      const r = await call(s.t);
      expect({ name, r }).toMatchObject({ name, r: { status: "access_unavailable", reason: "unauthenticated" } });
    }
  });
});

describe("acceptance: A05 a revoked person gets no new alert", () => {
  it("after a guardian link is revoked, a new evaluation alerts only the student", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await enable(s, GUARDIAN); // the guardian's preference stays on after the revoke
    await register(s, STUDENT, TOKEN_A);
    await register(s, GUARDIAN, TOKEN_B);
    await s.t.run((ctx) => ctx.db.patch(s.guardianLinkId, { status: "revoked" }));
    await approach(s);
    // The evaluation ran (the student is alerted) and skipped the revoked guardian.
    expect((await alerts(s)).map((a) => a.userId)).toEqual([s.studentUser]);
    expect((await jobs(s)).map((j) => j.userId)).toEqual([s.studentUser]);
  });

  it("after an assignment is revoked, a new evaluation creates no alert or job for anyone", async () => {
    const s = await setup();
    await enable(s, STUDENT);
    await enable(s, GUARDIAN);
    await register(s, STUDENT, TOKEN_A);
    await register(s, GUARDIAN, TOKEN_B);
    await s.t.run((ctx) => ctx.db.patch(s.assignmentId, { status: "revoked" }));
    await approach(s);
    expect(await alerts(s)).toEqual([]);
    expect(await jobs(s)).toEqual([]);
  });
});

describe("acceptance: a signed-out phone is never sent a queued alert", () => {
  // What the iOS app sends before sign-out (PushRegistrar.deactivatePush).
  const signOut = (s: Setup, permission: "authorized" | "denied", token: string | null) =>
    s.t.withIdentity({ tokenIdentifier: STUDENT }).mutation(api.notifications.registerDevice, {
      installationId: INSTALL_A,
      apnsToken: token,
      environment: "sandbox",
      permission,
    });

  it("a token cleared at sign-out cancels the pending job at claim time", async () => {
    const { s, jobId } = await oneJob();
    expect(await signOut(s, "authorized", null)).toMatchObject({ status: "registered", pushEnabled: false });
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "token_inactive", attempts: 0 });
  });

  it("notifications turned off on the phone cancels the pending job at claim time", async () => {
    const { s, jobId } = await oneJob();
    expect(await signOut(s, "denied", TOKEN_A)).toMatchObject({ status: "registered", pushEnabled: false });
    expect((await claim(s, jobId, s.NOW)).r).toBeNull();
    expect(await job(s, jobId)).toMatchObject({ state: "cancelled", endReason: "token_inactive", attempts: 0 });
  });
});

describe("retry backoff", () => {
  it("doubles from 5 s with up to 20% jitter; the base is capped at 5 minutes", () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, () => 0))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelayMs(1, () => 0.5)).toBe(5_500);
    expect(retryDelayMs(4, () => 0.999_999)).toBe(48_000);
    // Unreachable at today's MAX_DELIVERY_ATTEMPTS, but pinned: the cap applies before jitter.
    expect(retryDelayMs(7, () => 0)).toBe(300_000);
    expect(retryDelayMs(20, () => 0)).toBe(300_000);
    expect(retryDelayMs(20, () => 0.5)).toBe(330_000);
  });

  it("every scheduled retry waits between its base and 20% more", async () => {
    const { s, jobId } = await oneJob();
    let nowMs = s.NOW;
    const waits: number[] = [];
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      const c = await claim(s, jobId, nowMs);
      await s.t.mutation(internal.notificationJobs.record, {
        jobId,
        leaseId: c.leaseId,
        result: { kind: "retryable", reason: "ServiceUnavailable" },
        nowMs,
      });
      const row = (await job(s, jobId))!;
      if (row.state !== "retryable_failure") break;
      waits.push(row.nextAttemptAtMs - nowMs);
      nowMs = row.nextAttemptAtMs;
      await keepFresh(s, nowMs);
    }
    expect(waits).toHaveLength(MAX_DELIVERY_ATTEMPTS - 1);
    waits.forEach((w, i) => {
      const base = 5_000 * 2 ** i;
      expect(w).toBeGreaterThanOrEqual(base);
      expect(w).toBeLessThanOrEqual(base * 1.2);
    });
  });
});
