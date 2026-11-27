import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RAW_GPS_RETENTION_MS } from "./retention";
import schema from "./schema";

/**
 * Raw GPS retention (docs/11 §9): positions of runs that ended more than the
 * retention period ago are deleted in bounded batches; active and recent runs
 * are never touched; the run record and the audit log stay; each sweep is
 * recorded so cleanup is observable.
 */

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 27, 8, 0, 0);

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

async function run(
  t: T,
  deviceId: Id<"devices">,
  state: "active" | "completed" | "cancelled",
  endedAtMs: number | undefined,
  points: number,
) {
  return t.run(async (ctx) => {
    const runId = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId: "rv_fictional",
      state,
      startRequestId: `req-${Math.random()}`,
      ...(endedAtMs === undefined ? {} : { endedAtMs }),
    });
    const capturedBase = (endedAtMs ?? NOW) - points * 5_000;
    for (let i = 0; i < points; i++) {
      await ctx.db.insert("telemetryEvents", {
        eventId: `${runId}-${i}`,
        runId,
        deviceId,
        bootId: "boot",
        sequence: i,
        runSequence: i,
        capturedAtMs: capturedBase + i * 5_000,
        receivedAtMs: capturedBase + i * 5_000,
        latitude: 34.1,
        longitude: -83.98,
        speedMps: null,
        headingDegrees: null,
        horizontalAccuracyM: null,
        fixMode: 3,
      });
    }
    await ctx.db.insert("liveState", {
      runId,
      eventId: `${runId}-last`,
      capturedAtMs: capturedBase,
      receivedAtMs: capturedBase,
      latitude: 34.1,
      longitude: -83.98,
      speedMps: null,
      headingDegrees: null,
    });
    return runId;
  });
}

async function setup() {
  const t = newTest();
  const deviceId = await t.run((ctx) =>
    ctx.db.insert("devices", { label: "Bench Pi (fictional)", credentialHash: "x", revoked: false }),
  );
  return { t, deviceId };
}

const counts = (t: T, runId: Id<"runs">) =>
  t.run(async (ctx) => ({
    telemetry: (
      await ctx.db
        .query("telemetryEvents")
        .withIndex("by_run_captured", (q) => q.eq("runId", runId))
        .collect()
    ).length,
    live: (
      await ctx.db
        .query("liveState")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .collect()
    ).length,
    run: await ctx.db.get(runId),
  }));

describe("retention.purgeRawGps", () => {
  it("deletes positions of runs that ended before the cutoff and keeps the run record", async () => {
    const { t, deviceId } = await setup();
    const old = await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 4);
    const oldCancelled = await run(t, deviceId, "cancelled", NOW - RAW_GPS_RETENTION_MS - DAY, 2);
    await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW });
    for (const id of [old, oldCancelled]) {
      const c = await counts(t, id);
      expect(c.telemetry).toBe(0);
      expect(c.live).toBe(0);
      expect(c.run).not.toBeNull();
    }
  });

  it("never touches an active run or one that ended inside the retention period", async () => {
    const { t, deviceId } = await setup();
    const active = await run(t, deviceId, "active", undefined, 3);
    // Active for a long time: its old points are still current trip data.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("telemetryEvents")
        .withIndex("by_run_captured", (q) => q.eq("runId", active))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { receivedAtMs: NOW - 90 * DAY });
    });
    const recent = await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS + DAY, 3);
    await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW });
    expect(await counts(t, active)).toMatchObject({ telemetry: 3, live: 1 });
    expect(await counts(t, recent)).toMatchObject({ telemetry: 3, live: 1 });
  });

  it("works in bounded batches and continues until done", async () => {
    const { t, deviceId } = await setup();
    const old = await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 7);
    const first = await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW, batchSize: 3 });
    expect(first).toMatchObject({ deletedTelemetry: 3, done: false });
    expect((await counts(t, old)).telemetry).toBe(4);
    let result = first;
    for (let i = 0; i < 5 && !result.done; i++) {
      result = await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW, batchSize: 3 });
    }
    expect(result.done).toBe(true);
    expect(await counts(t, old)).toMatchObject({ telemetry: 0, live: 0 });
  });

  it("records every sweep in the audit log as a system action, and keeps audit rows", async () => {
    const { t, deviceId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("auditLog", {
        actor: { kind: "system" },
        action: "fictional.oldAction",
        resourceType: "runs",
        result: "allowed",
        atMs: NOW - 400 * DAY,
      }),
    );
    await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 2);
    await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action)).toEqual(["fictional.oldAction", "retention.purgeRawGps"]);
    expect(audit[1]).toMatchObject({
      actor: { kind: "system" },
      resourceType: "retention",
      resourceId: "rawGps",
      reason: "telemetry:2,live:1",
      result: "allowed",
      atMs: NOW,
    });
  });

  it("records nothing when there is nothing to delete", async () => {
    const { t, deviceId } = await setup();
    await run(t, deviceId, "completed", NOW - DAY, 2);
    expect(await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW })).toMatchObject({
      deletedTelemetry: 0,
      deletedLive: 0,
      done: true,
    });
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
  });

  it("a run with no end time is never treated as expired", async () => {
    const { t, deviceId } = await setup();
    const legacy = await run(t, deviceId, "completed", undefined, 2);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("telemetryEvents").collect();
      for (const r of rows) await ctx.db.patch(r._id, { receivedAtMs: NOW - 90 * DAY });
    });
    await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW });
    expect((await counts(t, legacy)).telemetry).toBe(2);
  });

  it("resumes after the scan limit instead of restarting, so every expired run is cleaned", async () => {
    const { t, deviceId } = await setup();
    const runs: Id<"runs">[] = [];
    for (let i = 0; i < 7; i++) runs.push(await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 1));
    let cursor: number | undefined;
    let calls = 0;
    for (; calls < 10; calls++) {
      const r = await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW, scanLimit: 3, cursor });
      cursor = r.cursor ?? undefined;
      if (r.done) break;
    }
    expect(calls).toBeLessThan(5);
    for (const id of runs) expect((await counts(t, id)).telemetry).toBe(0);
  });

  it("a run whose history needs several batches is finished before moving on", async () => {
    const { t, deviceId } = await setup();
    const big = await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 5);
    const next = await run(t, deviceId, "completed", NOW - RAW_GPS_RETENTION_MS - DAY, 1);
    let cursor: number | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await t.mutation(internal.retention.purgeRawGps, { nowMs: NOW, batchSize: 2, cursor });
      cursor = r.cursor ?? undefined;
      if (r.done) break;
    }
    expect(await counts(t, big)).toMatchObject({ telemetry: 0, live: 0 });
    expect(await counts(t, next)).toMatchObject({ telemetry: 0, live: 0 });
  });
});
