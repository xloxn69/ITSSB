import { demoTelemetryEvent, myRouteReady, myRunNoActiveRun, myRunReady } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const NOW = demoTelemetryEvent.capturedAtMs + 400;

const STUDENT = "test|student";
const GUARDIAN = "test|guardian";
const STRANGER = "test|stranger";

/** Fictional organization: one route version, one stop, one student, one guardian. */
async function setup({ withRun = true, revoked = false } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const [studentUser, guardianUser] = await Promise.all([
      ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" }),
      ctx.db.insert("users", { tokenIdentifier: GUARDIAN, role: "family", displayName: "Pat" }),
      ctx.db.insert("users", { tokenIdentifier: STRANGER, role: "family", displayName: "Lee" }),
    ]);
    const routeVersionId = await ctx.db.insert("routeVersions", {
      label: "Route 17 Morning",
      path: [
        { latitude: 34.092, longitude: -83.995 },
        { latitude: 34.105, longitude: -83.975 },
      ],
    });
    const stopId = await ctx.db.insert("stops", {
      routeVersionId,
      label: "Oak & Pine",
      latitude: 34.105,
      longitude: -83.975,
    });
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId,
      stopId,
      status: revoked ? "revoked" : "approved",
    });
    await ctx.db.insert("guardianLinks", { guardianUserId: guardianUser, studentId, status: "approved" });
    const deviceId = await ctx.db.insert("devices", {
      label: "Bench Pi",
      credentialHash: "x",
      revoked: false,
      busLabel: "Bus 12",
    });
    const runId = withRun
      ? await ctx.db.insert("runs", {
          deviceId,
          routeVersionId,
          state: "active",
          startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
          startedAtMs: NOW - 60_000,
        })
      : null;
    return { assignmentId, deviceId, runId, routeVersionId };
  });
  return { t, ...ids };
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

describe("tracking.myRun", () => {
  it("returns the student's own run in the docs/08 shape", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [{ ...demoTelemetryEvent, runId }],
      nowMs: NOW,
    });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.run.lastPosition).toMatchObject({
      eventId: demoTelemetryEvent.eventId,
      capturedAtMs: demoTelemetryEvent.capturedAtMs,
      receivedAtMs: NOW,
      latitude: 34.1,
      longitude: -83.98,
      horizontalAccuracyM: null,
    });
    expect(r.run.busLabel).toBe("Bus 12");
    expect(r.run.liveRevision).toBe(1);
    expect(r.run.lastDeviceContactAtMs).toBe(NOW);
    // Never guessed: no health reporting, progress model, or ETA yet.
    expect(r.run.gpsStatus).toBeNull();
    expect(r.run.eta).toBeNull();
    expect(r.run.assignedStop.status).toBe("unknown");
    // Fixture has non-null gpsStatus/eta/nextStopId; compare the rest of the shape.
    const { gpsStatus: _g, eta: _e, nextStopId: _n, ...run } = r.run;
    if (myRunReady.status !== "ready") throw new Error("fixture");
    const { gpsStatus: _fg, eta: _fe, nextStopId: _fn, ...fixtureRun } = myRunReady.run;
    expect(shape({ ...r, run })).toEqual(shape({ ...myRunReady, run: fixtureRun }));
  });

  it("liveRevision advances only when the live position is replaced", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    const later = {
      ...demoTelemetryEvent,
      runId,
      eventId: "7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      sequence: 43,
      runSequence: 919,
      capturedAtMs: demoTelemetryEvent.capturedAtMs + 5000,
    };
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [later], nowMs: NOW + 5000 });
    // Older observation: stored as history, does not replace the live state.
    await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [{ ...demoTelemetryEvent, runId }],
      nowMs: NOW + 6000,
    });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.run.liveRevision).toBe(1);
    expect(r.run.lastPosition?.eventId).toBe(later.eventId);
  });

  it("an active run without telemetry has an explicit null position", async () => {
    const { t, assignmentId } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.run.lastPosition).toBeNull();
    expect(r.run.lastDeviceContactAtMs).toBeNull();
    expect(r.run.liveRevision).toBe(0);
  });

  it("an approved guardian sees the linked student's run", async () => {
    const { t, assignmentId } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.tracking.myRun, { assignmentId });
    expect(r.status).toBe("ready");
  });

  it("reports no_active_run without inventing a run", async () => {
    const { t, assignmentId } = await setup({ withRun: false });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
    expect(r).toMatchObject({ status: "no_active_run", run: null, assignmentId });
    expect(shape(r)).toEqual(shape(myRunNoActiveRun));
  });

  it("denies an unrelated signed-in person with no protected fields", async () => {
    const { t, assignmentId } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: STRANGER }).query(api.tracking.myRun, { assignmentId });
    expect(r).toEqual({
      schemaVersion: 1,
      status: "access_unavailable",
      serverNowMs: expect.any(Number),
      reason: "not_permitted",
    });
  });

  it("denies a signed-out caller", async () => {
    const { t, assignmentId } = await setup();
    const r = await t.query(api.tracking.myRun, { assignmentId });
    expect(r).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
  });

  it("denies a revoked assignment and a malformed ID identically", async () => {
    const { t, assignmentId } = await setup({ revoked: true });
    const student = t.withIdentity({ tokenIdentifier: STUDENT });
    const revoked = await student.query(api.tracking.myRun, { assignmentId });
    const malformed = await student.query(api.tracking.myRun, { assignmentId: "demo_assignment_001" });
    expect(revoked).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
    expect(malformed).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
  });
});

describe("tracking.serverTime", () => {
  it("returns the current server time without sign-in", async () => {
    const t = convexTest(schema, modules);
    const before = Date.now();
    const r = await t.mutation(api.tracking.serverTime, {});
    expect(r.schemaVersion).toBe(1);
    expect(r.serverNowMs).toBeGreaterThanOrEqual(before);
    expect(r.serverNowMs).toBeLessThanOrEqual(Date.now());
  });
});

describe("tracking.myRoute", () => {
  it("returns the approved path and stop in the docs/08 shape", async () => {
    const { t, assignmentId, routeVersionId } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.tracking.myRoute, { assignmentId });
    expect(r).toMatchObject({ status: "ready", routeVersionId, routeLabel: "Route 17 Morning" });
    expect(shape(r)).toEqual(shape(myRouteReady));
  });

  it("denies an unrelated person", async () => {
    const { t, assignmentId } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: STRANGER }).query(api.tracking.myRoute, { assignmentId });
    expect(r).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
    expect(r).not.toHaveProperty("path");
  });
});

describe("tracking.myAssignments", () => {
  it("lists own and linked assignments, and nothing for a stranger", async () => {
    const { t, assignmentId } = await setup();
    const own = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myAssignments, {});
    const linked = await t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.tracking.myAssignments, {});
    const none = await t.withIdentity({ tokenIdentifier: STRANGER }).query(api.tracking.myAssignments, {});
    expect(own).toMatchObject({ status: "ready", assignments: [{ assignmentId, relationship: "self" }] });
    expect(linked).toMatchObject({
      status: "ready",
      assignments: [{ assignmentId, relationship: "guardian", studentDisplayName: "Sam Example" }],
    });
    expect(none).toMatchObject({ status: "ready", assignments: [] });
  });

  it("omits revoked assignments", async () => {
    const { t } = await setup({ revoked: true });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myAssignments, {});
    expect(r).toMatchObject({ status: "ready", assignments: [] });
  });

  it("denies a signed-out caller", async () => {
    const { t } = await setup();
    const r = await t.query(api.tracking.myAssignments, {});
    expect(r).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
  });
});
