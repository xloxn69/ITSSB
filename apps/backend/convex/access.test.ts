import { demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

/**
 * Who may read a run (docs/11 §2): staff, the assigned student's own
 * account, and a guardian with an approved link to that student. Everyone
 * else gets the same `null` as for a run that does not exist.
 */

const modules = import.meta.glob("./**/*.ts");
const NOW = demoTelemetryEvent.capturedAtMs + 400;

const STUDENT = "test|student";
const GUARDIAN = "test|guardian";
const OTHER_GUARDIAN = "test|other-guardian";
const OTHER_STUDENT = "test|other-student";
const STAFF = "test|staff";
const UNPROVISIONED = "test|signed-in-but-unknown";

type Options = {
  assignmentStatus?: "approved" | "revoked";
  linkStatus?: "approved" | "revoked";
};

/**
 * Two fictional students on two different route versions. The run under
 * test is on route A; the "other" student and their guardian ride route B.
 */
async function setup({ assignmentStatus = "approved", linkStatus = "approved" }: Options = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const user = (tokenIdentifier: string, role: "family" | "staff" = "family") =>
      ctx.db.insert("users", { tokenIdentifier, role, displayName: tokenIdentifier });
    const studentUser = await user(STUDENT);
    const guardianUser = await user(GUARDIAN);
    const otherStudentUser = await user(OTHER_STUDENT);
    const otherGuardianUser = await user(OTHER_GUARDIAN);
    await user(STAFF, "staff");

    const route = async (label: string) => {
      const routeVersionId = await ctx.db.insert("routeVersions", { label, path: [] });
      const stopId = await ctx.db.insert("stops", {
        routeVersionId,
        label: `${label} stop`,
        latitude: 34.1,
        longitude: -83.98,
      });
      return { routeVersionId, stopId };
    };
    const a = await route("Route A");
    const b = await route("Route B");

    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    await ctx.db.insert("assignments", { studentId, ...a, status: assignmentStatus });
    await ctx.db.insert("guardianLinks", { guardianUserId: guardianUser, studentId, status: linkStatus });

    const otherStudentId = await ctx.db.insert("students", {
      displayName: "Riley Example",
      userId: otherStudentUser,
    });
    await ctx.db.insert("assignments", { studentId: otherStudentId, ...b, status: "approved" });
    await ctx.db.insert("guardianLinks", {
      guardianUserId: otherGuardianUser,
      studentId: otherStudentId,
      status: "approved",
    });

    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: "x", revoked: false });
    const runId = await ctx.db.insert("runs", {
      deviceId,
      routeVersionId: a.routeVersionId,
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: NOW - 60_000,
    });
    return { deviceId, runId };
  });
  await t.mutation(internal.telemetry.ingestBatch, {
    deviceId: ids.deviceId,
    events: [{ ...demoTelemetryEvent, runId: ids.runId }],
    nowMs: NOW,
  });
  return { t, ...ids };
}

const liveAs = async (tokenIdentifier: string | null, options?: Options) => {
  const { t, runId } = await setup(options);
  const caller = tokenIdentifier ? t.withIdentity({ tokenIdentifier }) : t;
  return await caller.query(api.runs.live, { runId });
};

describe("runs.live: who may read a run", () => {
  it("staff can read it", async () => {
    expect((await liveAs(STAFF))?.position?.capturedAtMs).toBe(demoTelemetryEvent.capturedAtMs);
  });

  it("the assigned student can read it", async () => {
    expect((await liveAs(STUDENT))?.position?.capturedAtMs).toBe(demoTelemetryEvent.capturedAtMs);
  });

  it("an approved guardian of the assigned student can read it", async () => {
    expect((await liveAs(GUARDIAN))?.position?.capturedAtMs).toBe(demoTelemetryEvent.capturedAtMs);
  });

  it("a guardian of another student cannot read it", async () => {
    expect(await liveAs(OTHER_GUARDIAN)).toBeNull();
  });

  it("a student on another route cannot read it", async () => {
    expect(await liveAs(OTHER_STUDENT)).toBeNull();
  });

  it("a guardian whose link was revoked cannot read it", async () => {
    expect(await liveAs(GUARDIAN, { linkStatus: "revoked" })).toBeNull();
  });

  it("nobody in the family can read it once the assignment is revoked", async () => {
    expect(await liveAs(STUDENT, { assignmentStatus: "revoked" })).toBeNull();
    expect(await liveAs(GUARDIAN, { assignmentStatus: "revoked" })).toBeNull();
  });

  it("a signed-in identity with no approved account cannot read it", async () => {
    expect(await liveAs(UNPROVISIONED)).toBeNull();
  });

  it("a signed-out caller cannot read it", async () => {
    expect(await liveAs(null)).toBeNull();
  });
});

describe("telemetry.ingestBatch: credential rechecked at commit", () => {
  it("refuses a device revoked after the HTTP credential lookup", async () => {
    const { t, deviceId, runId } = await setup();
    await t.run((ctx) => ctx.db.patch(deviceId, { revoked: true }));
    const late = {
      ...demoTelemetryEvent,
      runId,
      eventId: "0b7d1c3e-1111-4a2b-9c3d-333333333333",
      sequence: 43,
      runSequence: 919,
      capturedAtMs: demoTelemetryEvent.capturedAtMs + 5000,
    };
    await expect(
      t.mutation(internal.telemetry.ingestBatch, { deviceId, events: [late], nowMs: NOW + 5000 }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    const stored = await t.run((ctx) => ctx.db.query("telemetryEvents").collect());
    expect(stored.map((e) => e.eventId)).not.toContain(late.eventId);
  });
});
