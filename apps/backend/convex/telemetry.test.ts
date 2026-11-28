import { demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "a".repeat(64);
const NOW = demoTelemetryEvent.capturedAtMs + 400;

async function setup() {
  const t = convexTest(schema, modules);
  const { deviceId, otherDeviceId, runId } = await t.run(async (ctx) => {
    const { sha256Hex } = await import("./lib/deviceAuth");
    const bench = await ctx.db.insert("devices", {
      label: "Bench Pi",
      credentialHash: await sha256Hex(SECRET),
      revoked: false,
    });
    const other = await ctx.db.insert("devices", {
      label: "Other Pi",
      credentialHash: "x",
      revoked: false,
    });
    const run = await ctx.db.insert("runs", {
      deviceId: bench,
      routeVersionId: "demo_route_version_003",
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: NOW - 60_000,
    });
    return { deviceId: bench, otherDeviceId: other, runId: run };
  });
  const event = { ...demoTelemetryEvent, runId };
  return { t, deviceId, otherDeviceId, runId, event };
}

describe("telemetry.ingestBatch", () => {
  it("accepts a valid event and sets live state", async () => {
    const { t, deviceId, event } = await setup();
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [event],
      nowMs: NOW,
    });
    expect(r).toEqual({
      eventId: event.eventId,
      status: "accepted",
      receivedAtMs: NOW,
      liveStateApplied: true,
    });
  });

  it("is idempotent: a retried event is a duplicate with the original receipt", async () => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [event],
      nowMs: NOW + 5000,
    });
    expect(r).toMatchObject({ status: "duplicate", receivedAtMs: NOW, liveStateApplied: true });
    const count = await t.run(async (ctx) => (await ctx.db.query("telemetryEvents").collect()).length);
    expect(count).toBe(1);
  });

  it("rejects a reused eventId with different content", async () => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [{ ...event, latitude: event.latitude + 0.01 }],
      nowMs: NOW,
    });
    expect(r).toMatchObject({ status: "rejected", code: "EVENT_CONTENT_CONFLICT" });
  });

  it("stores late observations without replacing the newer live position", async () => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const late = {
      ...event,
      eventId: "0b7d1c3e-1111-4a2b-9c3d-222222222222",
      sequence: 41,
      runSequence: 917,
      capturedAtMs: event.capturedAtMs - 5000,
    };
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [late],
      nowMs: NOW,
    });
    expect(r).toMatchObject({ status: "accepted", liveStateApplied: false });
  });

  it("rejects events for a run owned by another device", async () => {
    const { t, otherDeviceId, event } = await setup();
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId: otherDeviceId,
      events: [event],
      nowMs: NOW,
    });
    expect(r).toMatchObject({ status: "rejected", code: "RUN_NOT_AUTHORIZED" });
  });

  it("returns one result per event, keeping order", async () => {
    const { t, deviceId, event } = await setup();
    const results = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [event, { ...event, eventId: "not-a-uuid" }],
      nowMs: NOW,
    });
    expect(results.map((r) => r.status)).toEqual(["accepted", "rejected"]);
  });
});

describe("runs.live access", () => {
  it("returns nothing to signed-out callers", async () => {
    const { t, deviceId, event, runId } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    expect(await t.query(api.runs.live, { runId })).toBeNull();
  });

  it("returns nothing to a signed-in family account without a link", async () => {
    const { t, deviceId, event, runId } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    await t.run((ctx) =>
      ctx.db.insert("users", { tokenIdentifier: "test|family", role: "family", displayName: "Fam" }),
    );
    const asFamily = t.withIdentity({ tokenIdentifier: "test|family" });
    expect(await asFamily.query(api.runs.live, { runId })).toBeNull();
  });

  it("returns position with its capture time to staff", async () => {
    const { t, deviceId, event, runId } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    await t.run((ctx) =>
      ctx.db.insert("users", { tokenIdentifier: "test|staff", role: "staff", displayName: "Staff" }),
    );
    const asStaff = t.withIdentity({ tokenIdentifier: "test|staff" });
    const live = await asStaff.query(api.runs.live, { runId });
    expect(live?.position).toMatchObject({
      latitude: event.latitude,
      capturedAtMs: event.capturedAtMs,
      receivedAtMs: NOW,
    });
  });
});

// ── Acceptance gaps (docs/13 §4: D03, D10) ──────────────────────────────

const liveRow = (t: Awaited<ReturnType<typeof setup>>["t"]) => t.run((ctx) => ctx.db.query("liveState").collect());

describe("acceptance: mixed batches and live-state integrity", () => {
  it("D03: one batch with an accepted, a duplicate and a rejected event answers each explicitly, in order", async () => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const fresh = {
      ...event,
      eventId: "5f0c2d1e-3333-4b4c-8d5e-444444444444",
      sequence: event.sequence + 1,
      runSequence: event.runSequence + 1,
      capturedAtMs: event.capturedAtMs + 100,
    };
    const bad = { ...fresh, eventId: "6a1b2c3d-5555-4e6f-8a7b-666666666666", latitude: 91 };
    const results = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [fresh, event, bad],
      nowMs: NOW + 200,
    });
    expect(results).toEqual([
      { eventId: fresh.eventId, status: "accepted", receivedAtMs: NOW + 200, liveStateApplied: true },
      // The live position moved on to `fresh` in this same batch.
      { eventId: event.eventId, status: "duplicate", receivedAtMs: NOW, liveStateApplied: false },
      { eventId: bad.eventId, status: "rejected", code: "INVALID_COORDINATES", message: expect.any(String) },
    ]);
    const stored = await t.run((ctx) => ctx.db.query("telemetryEvents").collect());
    expect(stored.map((e) => e.eventId).toSorted()).toEqual([event.eventId, fresh.eventId].toSorted());
  });

  it.each([
    ["latitude out of range", { latitude: 91 }, "INVALID_COORDINATES"],
    ["a non-finite longitude", { longitude: Number.POSITIVE_INFINITY }, "INVALID_COORDINATES"],
    ["a capture time in the future", { capturedAtMs: NOW + 10 * 60_000 }, "CLOCK_OUT_OF_RANGE"],
  ])("D10: an invalid newer event (%s) leaves the run's live state unchanged", async (_n, change, code) => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const before = await liveRow(t);
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [
        {
          ...event,
          eventId: "7b2c3d4e-7777-4f8a-9b0c-888888888888",
          sequence: event.sequence + 1,
          runSequence: event.runSequence + 1,
          capturedAtMs: event.capturedAtMs + 100,
          ...change,
        },
      ],
      nowMs: NOW + 200,
    });
    expect(r).toMatchObject({ status: "rejected", code });
    expect(await liveRow(t)).toEqual(before);
  });

  it("D10: a duplicate eventId with newer, different content leaves the run's live state unchanged", async () => {
    const { t, deviceId, event } = await setup();
    await t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [event], nowMs: NOW });
    const before = await liveRow(t);
    expect(before).toHaveLength(1);
    const [r] = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: [{ ...event, capturedAtMs: event.capturedAtMs + 100, latitude: event.latitude + 0.001 }],
      nowMs: NOW + 200,
    });
    expect(r).toMatchObject({ status: "rejected", code: "EVENT_CONTENT_CONFLICT" });
    expect(await liveRow(t)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("telemetryEvents").collect())).toHaveLength(1);
  });
});
