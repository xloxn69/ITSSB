import { endOfLocalDayMs, localDate } from "@itssb/contracts";
import { demoTelemetryEvent, myRunCancelled, myRunNoService, myRunReady } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * D14 (docs/13 §4): after staff cancel or replace a run, or a run completes,
 * families get today's status for their own route from `tracking:myRun`,
 * never a finished run's position, and never another route's or another
 * day's run. Service-calendar notices reach families on their date only.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const STUDENT = "test|student";
const STRANGER = "test|stranger";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_B = "g".repeat(64);
const TZ = "America/New_York";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const studentUser = await ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" });
    await ctx.db.insert("users", { tokenIdentifier: STRANGER, role: "family", displayName: "Lee" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana" });
    const route = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const otherRoute = await ctx.db.insert("routeVersions", { label: "Route 4 Morning", path: [] });
    const stopId = await ctx.db.insert("stops", { routeVersionId: route, label: "Oak & Pine", latitude: 34.1, longitude: -83.98 });
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    const assignmentId = await ctx.db.insert("assignments", { studentId, routeVersionId: route, stopId, status: "approved" });
    const deviceA = await ctx.db.insert("devices", {
      label: "Pi A",
      credentialHash: await sha256Hex(SECRET_A),
      revoked: false,
      busLabel: "Bus 12",
    });
    const deviceB = await ctx.db.insert("devices", {
      label: "Pi B",
      credentialHash: await sha256Hex(SECRET_B),
      revoked: false,
      busLabel: "Bus 30",
    });
    await ctx.db.insert("driverGrants", {
      tokenHash: await sha256Hex(GRANT_B),
      deviceId: deviceB,
      driverUserId: driver,
      routeVersionIds: [route],
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 8 * HOUR,
      revoked: false,
    });
    return { staffId, route, otherRoute, assignmentId, deviceA, deviceB };
  });
  return {
    t,
    staff: t.withIdentity({ tokenIdentifier: STAFF }),
    student: t.withIdentity({ tokenIdentifier: STUDENT }),
    ...ids,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** An active run on `routeVersionId` for `serviceDate`, with one accepted position. */
async function activeRun(s: Setup, routeVersionId: string, serviceDate = localDate(Date.now(), TZ)) {
  const runId = await s.t.run((ctx) =>
    ctx.db.insert("runs", {
      deviceId: s.deviceA,
      routeVersionId,
      state: "active",
      startRequestId: crypto.randomUUID(),
      startedAtMs: Date.now() - HOUR,
      serviceDate,
      serviceTimezone: TZ,
    }),
  );
  await s.t.mutation(internal.telemetry.ingestBatch, {
    deviceId: s.deviceA,
    events: [{ ...demoTelemetryEvent, eventId: crypto.randomUUID(), runId, capturedAtMs: Date.now() - 1000 }],
    nowMs: Date.now(),
  });
  return runId;
}

const complete = (s: Setup, runId: Id<"runs">, endedAtMs = Date.now()) =>
  s.t.run((ctx) => ctx.db.patch(runId, { state: "completed", endedAtMs }));

async function startReplacement(s: Setup) {
  const capturedAtMs = Date.now() - 1000;
  const res = await s.t.fetch("/device/v1/trip-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_B}` },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      type: "startRun",
      driverOperatingGrant: GRANT_B,
      routeVersionId: s.route,
      serviceDate: localDate(capturedAtMs, TZ),
      serviceTimezone: TZ,
      capturedAtMs,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { runId: string }).runId;
}

/** Same keys, recursively, as the canonical fixture (values and IDs differ). */
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

describe("D14: tracking.myRun after a run ends", () => {
  it("a staff-cancelled run is reported cancelled, with no position and no staff reason", async () => {
    const s = await setup();
    const runId = await activeRun(s, s.route);
    const before = Date.now();
    await s.staff.mutation(api.runOps.cancelRun, { runId, reason: "Driver called in sick at the depot" });
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({
      status: "no_active_run",
      run: null,
      endedRun: {
        runId,
        state: "cancelled",
        serviceDate: localDate(Date.now(), TZ),
        replacement: null,
        validUntilMs: endOfLocalDayMs(localDate(Date.now(), TZ), TZ),
      },
      serviceNotice: null,
    });
    if (r.status !== "no_active_run") return;
    expect(r.endedRun?.endedAtMs).toBeGreaterThanOrEqual(before);
    expect(shape(r)).toEqual(shape(myRunCancelled));
    // Its last position is never shown as current, and staff's free text stays with staff.
    const wire = JSON.stringify(r);
    expect(wire).not.toContain("latitude");
    expect(wire).not.toContain("sick");
  });

  it("a replacement sent but not started is pending; once started, families track the replacement", async () => {
    const s = await setup();
    const runId = await activeRun(s, s.route);
    await s.staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: s.deviceB, reason: "Flat tire" });
    const pending = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(pending).toMatchObject({ status: "no_active_run", endedRun: { runId, state: "cancelled", replacement: "pending" } });

    const replacementId = await startReplacement(s);
    const live = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(live).toMatchObject({ status: "ready", run: { runId: replacementId, state: "active", busLabel: "Bus 30" } });
    expect(Object.keys(live).toSorted()).toEqual(Object.keys(myRunReady).toSorted());
  });

  it("a completed run is reported completed", async () => {
    const s = await setup();
    const runId = await activeRun(s, s.route);
    const endedAtMs = Date.now() - 5 * 60_000;
    await complete(s, runId, endedAtMs);
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({ status: "no_active_run", endedRun: { runId, state: "completed", endedAtMs, replacement: null } });
    expect(JSON.stringify(r)).not.toContain("latitude");
  });

  it("the most recent ended run of the day wins", async () => {
    const s = await setup();
    const cancelled = await activeRun(s, s.route);
    await s.staff.mutation(api.runOps.cancelRun, { runId: cancelled, reason: "Weather" });
    const later = await activeRun(s, s.route);
    await complete(s, later, Date.now() + 1000);
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({ endedRun: { runId: later, state: "completed" } });
  });

  it("another route's cancelled run is not shown", async () => {
    const s = await setup();
    const other = await activeRun(s, s.otherRoute);
    await s.staff.mutation(api.runOps.cancelRun, { runId: other, reason: "Weather" });
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({ status: "no_active_run", endedRun: null });
  });

  it("a previous day's cancelled or completed run is not shown", async () => {
    const s = await setup();
    const yesterday = localDate(Date.now() - DAY, TZ);
    const cancelled = await activeRun(s, s.route, yesterday);
    await s.staff.mutation(api.runOps.cancelRun, { runId: cancelled, reason: "Weather" });
    await complete(s, await activeRun(s, s.route, yesterday));
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({ status: "no_active_run", endedRun: null });
  });

  it("an unrelated account is denied with no trip status", async () => {
    const s = await setup();
    const runId = await activeRun(s, s.route);
    await s.staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: s.deviceB, reason: "Flat tire" });
    await s.staff.mutation(api.calendar.setDay, {
      serviceDate: localDate(Date.now(), TZ),
      timezone: TZ,
      status: "no_service",
      notice: "No buses today.",
    });
    const r = await s.t.withIdentity({ tokenIdentifier: STRANGER }).query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toEqual({ schemaVersion: 1, status: "access_unavailable", serverNowMs: expect.any(Number), reason: "not_permitted" });
  });
});

describe("D14: service-calendar notices in tracking.myRun", () => {
  it("today's no-service day reaches the family; tomorrow's entry does not", async () => {
    const s = await setup();
    const today = localDate(Date.now(), TZ);
    await s.staff.mutation(api.calendar.setDay, {
      serviceDate: today,
      timezone: TZ,
      status: "no_service",
      notice: "No buses today: teacher workday.",
    });
    await s.staff.mutation(api.calendar.setDay, {
      serviceDate: localDate(Date.now() + DAY, TZ),
      timezone: TZ,
      status: "late_start",
      lateStartMinutes: 30,
      notice: "Buses run 30 minutes late tomorrow.",
    });
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({
      status: "no_active_run",
      endedRun: null,
      serviceNotice: {
        serviceDate: today,
        status: "no_service",
        lateStartMinutes: null,
        notice: "No buses today: teacher workday.",
        validUntilMs: endOfLocalDayMs(today, TZ),
      },
    });
    expect(shape(r)).toEqual(shape(myRunNoService));
  });

  it("a late start shows its minutes, including while the trip runs", async () => {
    const s = await setup();
    await s.staff.mutation(api.calendar.setDay, {
      serviceDate: localDate(Date.now(), TZ),
      timezone: TZ,
      status: "late_start",
      lateStartMinutes: 20,
      notice: "Buses run 20 minutes late because of fog.",
    });
    const before = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(before).toMatchObject({ status: "no_active_run", serviceNotice: { status: "late_start", lateStartMinutes: 20 } });
    await activeRun(s, s.route);
    const during = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(during).toMatchObject({ status: "ready", serviceNotice: { status: "late_start", lateStartMinutes: 20 } });
  });

  it("yesterday's entry is not today's notice", async () => {
    const s = await setup();
    const yesterday = localDate(Date.now() - DAY, TZ);
    await s.t.run((ctx) =>
      ctx.db.insert("serviceDays", {
        serviceDate: yesterday,
        timezone: TZ,
        status: "no_service",
        notice: "Snow day.",
        setByUserId: s.staffId,
        setAtMs: Date.now() - DAY,
      }),
    );
    const r = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(r).toMatchObject({ status: "no_active_run", serviceNotice: null });
  });
});

describe("D14: one bad calendar entry or run never fails tracking.myRun", () => {
  it("a notice saved with a far numeric offset (+16:00) is shown, with and without a running trip", async () => {
    const s = await setup();
    const zone = "+16:00";
    const today = localDate(Date.now(), zone);
    expect(
      await s.staff.mutation(api.calendar.setDay, { serviceDate: today, timezone: zone, status: "no_service", notice: "Closed." }),
    ).toMatchObject({ status: "ok" });
    const noTrip = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(noTrip).toMatchObject({
      status: "no_active_run",
      serviceNotice: { serviceDate: today, validUntilMs: endOfLocalDayMs(today, zone) },
    });
    await activeRun(s, s.route);
    const live = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(live).toMatchObject({ status: "ready", run: { state: "active" }, serviceNotice: { serviceDate: today } });
  });

  it("a stored entry or ended run whose time zone can't be computed is dropped; the rest still renders", async () => {
    const s = await setup();
    // Rows written before validation, or by a future validator change: never trusted to compute.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("serviceDays", {
        serviceDate: localDate(Date.now(), TZ),
        timezone: "Not/AZone",
        status: "no_service",
        notice: "Closed.",
        setByUserId: s.staffId,
        setAtMs: Date.now(),
      });
      await ctx.db.insert("runs", {
        deviceId: s.deviceA,
        routeVersionId: s.route,
        state: "cancelled",
        startRequestId: crypto.randomUUID(),
        serviceDate: localDate(Date.now(), TZ),
        serviceTimezone: "Not/AZone",
        endedAtMs: Date.now(),
        cancelledAtMs: Date.now(),
      });
    });
    const noTrip = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(noTrip).toMatchObject({ status: "no_active_run", endedRun: null, serviceNotice: null });
    await activeRun(s, s.route);
    const live = await s.student.query(api.tracking.myRun, { assignmentId: s.assignmentId });
    expect(live).toMatchObject({ status: "ready", run: { state: "active" }, serviceNotice: null });
  });
});
