import { MAX_ROUTE_PATH_POINTS } from "@itssb/contracts";
import { demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { approvedVersionForNewRun, isApprovedForNewRuns } from "./lib/routeVersions";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const STAFF = "test|staff";
const DRIVER = "test|driver";
const FAMILY = "test|family";

/** Fictional path, about 100 m between points, with a stop on it. */
const PATH = [
  { latitude: 34.1, longitude: -83.98 },
  { latitude: 34.1009, longitude: -83.98 },
  { latitude: 34.1018, longitude: -83.98 },
];
const STOPS = [{ label: "Oak & Pine", latitude: 34.1018, longitude: -83.98, instructions: "North corner" }];

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    await ctx.db.insert("users", { tokenIdentifier: DRIVER, role: "driver", displayName: "Dana Driver" });
    await ctx.db.insert("users", { tokenIdentifier: FAMILY, role: "family", displayName: "Pat Parent" });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: "x", revoked: false });
    return { staffId, deviceId };
  });
  const draftId = await t.mutation(internal.routes.recordDraft, {
    label: "Route 17 Morning",
    direction: "to_school",
    path: PATH,
    stops: STOPS,
    recordedByDeviceId: ids.deviceId,
  });
  return { t, draftId: draftId as string, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
type Ids = { draftId: string; deviceId: string };

/** Every new staff function, called with arguments that would succeed for staff. */
const STAFF_CALLS: [string, (t: T, ids: Ids) => Promise<unknown>][] = [
  ["routes.list", (t) => t.query(api.routes.list, {})],
  ["routes.listDrafts", (t) => t.query(api.routes.listDrafts, {})],
  ["routes.getDraft", (t, { draftId }) => t.query(api.routes.getDraft, { draftId })],
  ["routes.approveDraft", (t, { draftId }) => t.mutation(api.routes.approveDraft, { draftId })],
  ["routes.rejectDraft", (t, { draftId }) => t.mutation(api.routes.rejectDraft, { draftId, reason: "Gap" })],
  ["fleet.listDevices", (t) => t.query(api.fleet.listDevices, {})],
  ["fleet.setBusLabel", (t, { deviceId }) => t.mutation(api.fleet.setBusLabel, { deviceId, busLabel: "Bus 9" })],
  ["fleet.revokeDevice", (t, { deviceId }) => t.mutation(api.fleet.revokeDevice, { deviceId })],
  ["fleet.listDrivers", (t) => t.query(api.fleet.listDrivers, {})],
];

describe("access denial on every staff function", () => {
  for (const [name, call] of STAFF_CALLS) {
    it(`${name}: signed out is unauthenticated`, async () => {
      const { t, ...ids } = await setup();
      expect(await call(t, ids)).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
    });

    for (const who of [DRIVER, FAMILY, "test|unprovisioned"]) {
      it(`${name}: ${who} is not permitted and changes nothing`, async () => {
        const { t, ...ids } = await setup();
        const result = await call(t.withIdentity({ tokenIdentifier: who }) as T, ids);
        expect(result).toEqual({
          schemaVersion: 1,
          status: "access_unavailable",
          serverNowMs: expect.any(Number),
          // A verified but unlinked identity is signed in: not permitted, never "sign in again".
          reason: "not_permitted",
        });
        const state = await t.run(async (ctx) => ({
          draft: await ctx.db.get(ids.draftId as Id<"routeDrafts">),
          device: await ctx.db.get(ids.deviceId as Id<"devices">),
          versions: await ctx.db.query("routeVersions").collect(),
        }));
        expect(state.draft?.status).toBe("submitted");
        expect(state.device).toMatchObject({ revoked: false });
        expect(state.device?.busLabel).toBeUndefined();
        expect(state.versions).toHaveLength(0);
      });
    }
  }

  it("records a denied mutation by a signed-in non-staff person in the audit log", async () => {
    const { t, draftId } = await setup();
    await t.withIdentity({ tokenIdentifier: DRIVER }).mutation(api.routes.approveDraft, { draftId });
    const rows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(rows).toEqual([expect.objectContaining({ action: "route.approve", result: "denied", resourceId: draftId })]);
  });
});

describe("route review and approval", () => {
  it("approval creates v1, and a new run pins it", async () => {
    const { t, draftId, staffId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const detail = await staff.query(api.routes.getDraft, { draftId });
    expect(detail).toMatchObject({ status: "ready", draft: { status: "submitted", checks: [] } });

    const approved = await staff.mutation(api.routes.approveDraft, { draftId });
    expect(approved).toMatchObject({ status: "approved", versionNumber: 1 });
    if (approved.status !== "approved") throw new Error("not approved");

    const pinned = await t.run(async (ctx) => {
      const routeId = ctx.db.normalizeId("routes", approved.routeId)!;
      const versionId = await approvedVersionForNewRun(ctx, routeId);
      const version = versionId ? await ctx.db.get(versionId) : null;
      const stops = await ctx.db
        .query("stops")
        .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId!))
        .collect();
      return { versionId, version, stops };
    });
    expect(pinned.versionId).toBe(approved.routeVersionId);
    expect(pinned.version).toMatchObject({ path: PATH, approvedByUserId: staffId, versionNumber: 1 });
    expect(pinned.stops).toEqual([expect.objectContaining({ label: "Oak & Pine", sequence: 0, instructions: "North corner" })]);

    const routes = await staff.query(api.routes.list, {});
    expect(routes).toMatchObject({
      status: "ready",
      routes: [
        {
          label: "Route 17 Morning",
          currentVersion: { routeVersionId: approved.routeVersionId, versionNumber: 1, approvedByName: "Riley Staff", stopCount: 1 },
        },
      ],
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit).toEqual([expect.objectContaining({ action: "route.approve", result: "allowed" })]);
  });

  it("approving twice returns the same version and creates nothing new", async () => {
    const { t, draftId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const first = await staff.mutation(api.routes.approveDraft, { draftId });
    const second = await staff.mutation(api.routes.approveDraft, { draftId });
    expect(second).toMatchObject({ status: "approved" });
    expect(second).toMatchObject({ routeVersionId: (first as { routeVersionId: string }).routeVersionId });
    const counts = await t.run(async (ctx) => ({
      versions: (await ctx.db.query("routeVersions").collect()).length,
      routes: (await ctx.db.query("routes").collect()).length,
      stops: (await ctx.db.query("stops").collect()).length,
    }));
    expect(counts).toEqual({ versions: 1, routes: 1, stops: 1 });
  });

  it("a revision becomes v2 for new runs; a running run and v1 are untouched", async () => {
    const { t, draftId, deviceId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const v1 = await staff.mutation(api.routes.approveDraft, { draftId });
    if (v1.status !== "approved") throw new Error("not approved");
    const runId = await t.run(async (ctx) => {
      const routeId = ctx.db.normalizeId("routes", v1.routeId)!;
      const version = await approvedVersionForNewRun(ctx, routeId);
      return await ctx.db.insert("runs", {
        deviceId: deviceId as Id<"devices">,
        routeVersionId: version!,
        state: "active",
        startRequestId: "0b6f3c1e-2f7a-4b8e-9c1d-5a6b7c8d9e0f",
      });
    });

    const revised = await t.mutation(internal.routes.recordDraft, {
      routeId: v1.routeId as Id<"routes">,
      label: "Route 17 Morning",
      direction: "to_school",
      path: [...PATH, { latitude: 34.1027, longitude: -83.98 }],
      stops: [...STOPS, { label: "Maple & 3rd", latitude: 34.1027, longitude: -83.98 }],
    });
    const v2 = await staff.mutation(api.routes.approveDraft, { draftId: revised });
    expect(v2).toMatchObject({ status: "approved", routeId: v1.routeId, versionNumber: 2 });
    if (v2.status !== "approved") throw new Error("not approved");

    const after = await t.run(async (ctx) => ({
      run: await ctx.db.get(runId),
      v1: await ctx.db.get(v1.routeVersionId as Id<"routeVersions">),
      v1Stops: await ctx.db
        .query("stops")
        .withIndex("by_route_version", (q) => q.eq("routeVersionId", v1.routeVersionId as Id<"routeVersions">))
        .collect(),
      next: await approvedVersionForNewRun(ctx, v1.routeId as Id<"routes">),
    }));
    expect(after.run?.routeVersionId).toBe(v1.routeVersionId);
    const allowed = await t.run(async (ctx) => ({
      v1: await isApprovedForNewRuns(ctx, v1.routeVersionId as Id<"routeVersions">),
      v2: await isApprovedForNewRuns(ctx, v2.routeVersionId as Id<"routeVersions">),
      legacy: await isApprovedForNewRuns(ctx, await ctx.db.insert("routeVersions", { label: "Old", path: PATH })),
    }));
    expect(allowed).toEqual({ v1: false, v2: true, legacy: true });
    expect(after.v1?.path).toEqual(PATH);
    expect(after.v1Stops).toHaveLength(1);
    expect(after.next).toBe(v2.routeVersionId);
  });

  it("refuses a revision while students are assigned to the current version", async () => {
    const { t, draftId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const v1 = await staff.mutation(api.routes.approveDraft, { draftId });
    if (v1.status !== "approved") throw new Error("not approved");
    await t.run(async (ctx) => {
      const versionId = v1.routeVersionId as Id<"routeVersions">;
      const stop = (await ctx.db
        .query("stops")
        .withIndex("by_route_version", (q) => q.eq("routeVersionId", versionId))
        .first())!;
      const studentId = await ctx.db.insert("students", { displayName: "Sam Example" });
      await ctx.db.insert("assignments", { studentId, routeVersionId: versionId, stopId: stop._id, status: "approved" });
    });
    const revised = await t.mutation(internal.routes.recordDraft, {
      routeId: v1.routeId as Id<"routes">,
      label: "Route 17 Morning",
      direction: "to_school",
      path: PATH,
      stops: STOPS,
    });
    expect(await staff.mutation(api.routes.approveDraft, { draftId: revised })).toMatchObject({
      status: "refused",
      code: "route_has_assignments",
    });
    const next = await t.run((ctx) => approvedVersionForNewRun(ctx, v1.routeId as Id<"routes">));
    expect(next).toBe(v1.routeVersionId);
  });

  it("refuses a revision in the other direction from its route", async () => {
    const { t, draftId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const v1 = await staff.mutation(api.routes.approveDraft, { draftId });
    if (v1.status !== "approved") throw new Error("not approved");
    const flipped = await t.mutation(internal.routes.recordDraft, {
      routeId: v1.routeId as Id<"routes">,
      label: "Route 17 Afternoon",
      direction: "from_school",
      path: PATH,
      stops: STOPS,
    });
    expect(await staff.mutation(api.routes.approveDraft, { draftId: flipped })).toMatchObject({
      status: "refused",
      code: "direction_mismatch",
    });
    const route = await t.run((ctx) => ctx.db.get(v1.routeId as Id<"routes">));
    expect(route).toMatchObject({ direction: "to_school", currentVersionId: v1.routeVersionId });
  });

  it("blocks approval of a draft without stops or with too many points", async () => {
    const { t } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const noStops = await t.mutation(internal.routes.recordDraft, {
      label: "Route 4",
      direction: "from_school",
      path: PATH,
      stops: [],
    });
    const huge = await t.mutation(internal.routes.recordDraft, {
      label: "Route 5",
      direction: "from_school",
      path: Array.from({ length: MAX_ROUTE_PATH_POINTS + 1 }, (_, i) => ({ latitude: 34 + i * 1e-5, longitude: -84 })),
      stops: STOPS,
    });
    for (const draftId of [noStops, huge]) {
      expect(await staff.mutation(api.routes.approveDraft, { draftId })).toMatchObject({
        status: "refused",
        code: "blocking_checks",
      });
    }
    expect(await t.run((ctx) => ctx.db.query("routeVersions").collect())).toHaveLength(0);
  });

  it("flags a gap and an off-path stop as warnings", async () => {
    const { t } = await setup();
    const draftId = await t.mutation(internal.routes.recordDraft, {
      label: "Route 6",
      direction: "to_school",
      path: [PATH[0]!, { latitude: 34.11, longitude: -83.98 }],
      stops: [{ label: "Far stop", latitude: 34.2, longitude: -83.98 }],
    });
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.routes.getDraft, { draftId });
    expect(result).toMatchObject({
      status: "ready",
      draft: {
        checks: [
          { code: "path_gap", severity: "warning" },
          { code: "stop_off_path", severity: "warning" },
        ],
      },
    });
  });

  it("rejection needs a reason, records it, and cannot be approved afterwards", async () => {
    const { t, draftId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    expect(await staff.mutation(api.routes.rejectDraft, { draftId, reason: "  " })).toMatchObject({
      code: "reason_required",
    });
    expect(await staff.mutation(api.routes.rejectDraft, { draftId, reason: "Stop on wrong side" })).toMatchObject({
      status: "rejected",
    });
    expect(await staff.mutation(api.routes.approveDraft, { draftId })).toMatchObject({ code: "already_decided" });
    expect(await staff.query(api.routes.listDrafts, {})).toMatchObject({
      drafts: [{ status: "rejected", decisionReason: "Stop on wrong side", reviewerName: "Riley Staff" }],
    });
  });

  it("an unknown draft is not found for staff", async () => {
    const { t } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    expect(await staff.query(api.routes.getDraft, { draftId: "nope" })).toMatchObject({ status: "not_found" });
    expect(await staff.mutation(api.routes.approveDraft, { draftId: "nope" })).toMatchObject({ code: "not_found" });
  });
});

describe("fleet", () => {
  it("lists devices without credentials, with the active run and last contact", async () => {
    const { t, deviceId } = await setup();
    await t.run(async (ctx) => {
      const routeVersionId = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: PATH });
      const runId = await ctx.db.insert("runs", {
        deviceId: deviceId as Id<"devices">,
        routeVersionId,
        state: "active",
        startRequestId: "5b1f1d0e-0000-4000-8000-000000000001",
        startedAtMs: 1_000,
      });
      await ctx.db.insert("liveState", {
        runId,
        eventId: "e1",
        capturedAtMs: 1_500,
        receivedAtMs: 1_600,
        latitude: 34.1,
        longitude: -83.98,
        speedMps: null,
        headingDegrees: null,
      });
    });
    const result = await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.listDevices, {});
    expect(result).toMatchObject({
      status: "ready",
      devices: [
        { label: "Bench Pi", busLabel: null, revoked: false, lastContactAtMs: 1_600, activeRun: { routeLabel: "Route 17 Morning", startedAtMs: 1_000 } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("credentialHash");
  });

  it("sets a bus label, validates it, and revokes idempotently with one audit row", async () => {
    const { t, deviceId } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    expect(await staff.mutation(api.fleet.setBusLabel, { deviceId, busLabel: "" })).toMatchObject({ code: "invalid_label" });
    expect(await staff.mutation(api.fleet.setBusLabel, { deviceId, busLabel: " Bus 12 " })).toMatchObject({ status: "ok" });
    expect(await staff.mutation(api.fleet.revokeDevice, { deviceId })).toMatchObject({ status: "ok" });
    expect(await staff.mutation(api.fleet.revokeDevice, { deviceId })).toMatchObject({ status: "ok" });
    const device = await t.run((ctx) => ctx.db.get(deviceId as Id<"devices">));
    expect(device).toMatchObject({ busLabel: "Bus 12", revoked: true });
    const revokes = (await t.run((ctx) => ctx.db.query("auditLog").collect())).filter((r) => r.action === "device.revoke");
    expect(revokes).toHaveLength(1);
  });

  it("after staff revoke a device, its next upload is rejected and nothing is stored", async () => {
    const { t, deviceId } = await setup();
    const runId = await t.run(async (ctx) =>
      ctx.db.insert("runs", {
        deviceId: deviceId as Id<"devices">,
        routeVersionId: "legacy",
        state: "active",
        startRequestId: "5b1f1d0e-0000-4000-8000-000000000002",
      }),
    );
    await t.withIdentity({ tokenIdentifier: STAFF }).mutation(api.fleet.revokeDevice, { deviceId });
    // The HTTP route's credential lookup happened before the revoke; the
    // committing mutation must still refuse.
    await expect(
      t.mutation(internal.telemetry.ingestBatch, {
        deviceId: deviceId as Id<"devices">,
        events: [{ ...demoTelemetryEvent, runId }],
        nowMs: demoTelemetryEvent.capturedAtMs + 400,
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    expect(await t.run((ctx) => ctx.db.query("liveState").collect())).toHaveLength(0);
  });

  it("lists drivers only", async () => {
    const { t } = await setup();
    expect(await t.withIdentity({ tokenIdentifier: STAFF }).query(api.fleet.listDrivers, {})).toMatchObject({
      drivers: [{ displayName: "Dana Driver" }],
    });
  });
});
