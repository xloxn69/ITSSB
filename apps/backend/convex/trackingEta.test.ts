import { ETA_VALID_FOR_MS, POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** Fictional coordinates only. */
const BASE = { latitude: 34.1, longitude: -83.99 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((BASE.latitude * Math.PI) / 180);
const at = (east: number, north = 0) => ({
  latitude: BASE.latitude + north / M_PER_DEG_LAT,
  longitude: BASE.longitude + east / M_PER_DEG_LON,
});

const NOW = 1_795_609_085_000;
const STUDENT = "test|student";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const studentUser = await ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" });
    const routeVersionId = await ctx.db.insert("routeVersions", {
      label: "Route 17 Morning",
      path: Array.from({ length: 401 }, (_, i) => at(i * 10)),
    });
    const stopIds: Id<"stops">[] = [];
    for (const [sequence, east] of [1000, 2500, 3500].entries()) {
      stopIds.push(
        await ctx.db.insert("stops", { routeVersionId, label: `Stop ${sequence + 1}`, sequence, ...at(east) }),
      );
    }
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId,
      stopId: stopIds[2]!,
      status: "approved",
    });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: "x", revoked: false });
    const runId = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId,
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: NOW - 120_000,
    });
    return { assignmentId, deviceId, runId, stopIds };
  });
  return { t, ...ids };
}

let seq = 0;
function event(runId: string, east: number, capturedAtMs: number, north = 0) {
  seq += 1;
  return {
    eventId: crypto.randomUUID(),
    bootId: "3cd44c56-c96b-4b83-a970-5414990bc25a",
    sequence: seq,
    runSequence: seq,
    runId,
    capturedAtMs,
    ...at(east, north),
    speedMps: 8,
    headingDegrees: 90,
    horizontalAccuracyM: 5,
    fixMode: 3 as const,
  };
}

async function myRun(t: Awaited<ReturnType<typeof setup>>["t"], assignmentId: string, nowMs: number) {
  vi.setSystemTime(nowMs);
  const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId });
  if (r.status !== "ready") throw new Error(r.status);
  return r.run;
}

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

describe("baseline ETA in tracking.myRun", () => {
  it("returns an ETA with its generation time, source event, and validity", async () => {
    const { t, assignmentId, deviceId, runId, stopIds } = await setup();
    const a = event(runId, 100, NOW - 10_000);
    const b = event(runId, 200, NOW - 5_000);
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [a, b], nowMs: NOW });
    const run = await myRun(t, assignmentId, NOW + 1_000);
    expect(run.eta).toMatchObject({
      generatedAtMs: NOW,
      validUntilMs: b.capturedAtMs + ETA_VALID_FOR_MS,
      sourceEventId: b.eventId,
      algorithmVersion: "baseline-v1",
      lowerArrivalAtMs: null,
      upperArrivalAtMs: null,
    });
    expect(run.eta!.arrivalAtMs).toBeGreaterThan(b.capturedAtMs);
    expect(run.nextStopId).toBe(stopIds[0]);
    expect(run.assignedStop.status).toBe("upcoming");
  });

  it("withholds the ETA once its validity ends or the position is stale", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    const b = event(runId, 200, NOW - 5_000);
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [b], nowMs: NOW });
    expect((await myRun(t, assignmentId, b.capturedAtMs + ETA_VALID_FOR_MS - 1)).eta).not.toBeNull();
    const expired = await myRun(t, assignmentId, b.capturedAtMs + ETA_VALID_FOR_MS);
    expect(expired.eta).toBeNull();
    expect(expired.lastPosition?.eventId).toBe(b.eventId);
    expect((await myRun(t, assignmentId, b.capturedAtMs + POSITION_STALE_AFTER_MS)).eta).toBeNull();
  });

  it("stores a prediction made from an already-old position but never shows it", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    const old = event(runId, 200, NOW - 90_000);
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [old], nowMs: NOW });
    const rows = await t.run((ctx) => ctx.db.query("etaPredictions").collect());
    expect(rows.length).toBeGreaterThan(0);
    expect((await myRun(t, assignmentId, NOW)).eta).toBeNull();
  });

  it("stores one prediction per stop ahead, only for the batch's newest event", async () => {
    const { t, deviceId, runId, stopIds } = await setup();
    const events = [event(runId, 100, NOW - 15_000), event(runId, 150, NOW - 10_000), event(runId, 200, NOW - 5_000)];
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events, nowMs: NOW });
    const rows = await t.run((ctx) => ctx.db.query("etaPredictions").collect());
    expect(rows.map((r) => r.sourceEventId)).toEqual([events[2]!.eventId, events[2]!.eventId, events[2]!.eventId]);
    expect(rows.map((r) => r.stopId).toSorted()).toEqual([...stopIds].toSorted());
    expect(rows.every((r) => r.generatedAtMs === NOW && r.routeVersionId !== undefined)).toBe(true);
  });

  it("an off-route latest position withdraws the earlier ETA", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [event(runId, 200, NOW - 10_000)],
      nowMs: NOW - 9_000,
    });
    await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [event(runId, 250, NOW - 5_000, 200)],
      nowMs: NOW,
    });
    const run = await myRun(t, assignmentId, NOW);
    expect(run.lastPosition).not.toBeNull();
    expect(run.eta).toBeNull();
  });

  it("advances stop status and the next stop as the bus moves", async () => {
    const { t, assignmentId, deviceId, runId, stopIds } = await setup();
    let captured = NOW - 400_000;
    const events = [];
    for (let d = 100; d <= 1200; d += 50) events.push(event(runId, d, (captured += 5_000)));
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events, nowMs: captured + 500 });
    const run = await myRun(t, assignmentId, captured + 1_000);
    expect(run.nextStopId).toBe(stopIds[1]);
    expect(run.assignedStop.status).toBe("upcoming");
    expect(run.eta).not.toBeNull();
  });

  it("shows no ETA while the bus is at the assigned stop", async () => {
    const { t, assignmentId, deviceId, runId } = await setup();
    let captured = NOW - 600_000;
    const events = [];
    for (let d = 100; d <= 3500; d += 50) events.push(event(runId, d, (captured += 5_000)));
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: events.slice(0, 40), nowMs: captured });
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: events.slice(40), nowMs: captured });
    const run = await myRun(t, assignmentId, captured + 500);
    expect(run.assignedStop.status).toBe("at_stop");
    expect(run.eta).toBeNull();
  });

  it("late history for a completed run creates no prediction", async () => {
    const { t, deviceId, runId } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(runId, { state: "completed", endedAtMs: NOW, endCapturedAtMs: NOW, lastRunSequence: 10_000 }),
    );
    const late = event(runId, 200, NOW - 5_000);
    const [result] = await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [late], nowMs: NOW });
    expect(result).toMatchObject({ status: "accepted", liveStateApplied: false });
    expect(await t.run((ctx) => ctx.db.query("etaPredictions").collect())).toEqual([]);
  });
});
