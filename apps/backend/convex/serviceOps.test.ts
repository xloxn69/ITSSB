import { localDate } from "@itssb/contracts";
import { demoTelemetryEvent } from "@itssb/contracts/fixtures";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * Staff service operations (docs/12 §7, docs/14 §5): cancel a run, move a
 * route to a replacement bus, keep a service calendar, and schedule device
 * maintenance windows. Every action is staff-only and audited.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const DRIVER = "test|driver";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const SECRET_C = "c".repeat(64);
const GRANT_B = "g".repeat(64);
const GRANT_C = "h".repeat(64);
const TZ = "America/New_York";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: DRIVER, role: "driver", displayName: "Dana" });
    const route = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const device = async (label: string, secret: string, revoked = false) =>
      ctx.db.insert("devices", { label, credentialHash: await sha256Hex(secret), revoked });
    const deviceA = await device("Pi A", SECRET_A);
    const deviceB = await device("Pi B", SECRET_B);
    const deviceC = await device("Pi C", SECRET_C);
    const revokedDevice = await device("Old Pi", "d".repeat(64), true);
    for (const [hash, deviceId] of [
      [await sha256Hex(GRANT_B), deviceB],
      [await sha256Hex(GRANT_C), deviceC],
    ] as const) {
      await ctx.db.insert("driverGrants", {
        tokenHash: hash,
        deviceId,
        driverUserId: driver,
        routeVersionIds: [route],
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 8 * HOUR,
        revoked: false,
      });
    }
    const runId = await ctx.db.insert("runs", {
      deviceId: deviceA,
      routeVersionId: route,
      state: "active",
      startRequestId: "start-a",
      startedAtMs: Date.now() - HOUR,
      serviceDate: localDate(Date.now(), TZ),
      serviceTimezone: TZ,
    });
    return { staffId, route, deviceA, deviceB, deviceC, revokedDevice, runId };
  });
  return { t, staff: t.withIdentity({ tokenIdentifier: STAFF }), driver: t.withIdentity({ tokenIdentifier: DRIVER }), ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const audit = (t: T) => t.run((ctx) => ctx.db.query("auditLog").collect());
const getRun = (t: T, id: Id<"runs">) => t.run((ctx) => ctx.db.get(id));

async function startOn(t: T, secret: string, grant: string, routeVersionId: string) {
  const capturedAtMs = Date.now() - 1000;
  const res = await t.fetch("/device/v1/trip-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      type: "startRun",
      driverOperatingGrant: grant,
      routeVersionId,
      serviceDate: localDate(capturedAtMs, TZ),
      serviceTimezone: TZ,
      capturedAtMs,
    }),
  });
  return { status: res.status, body: (await res.json()) as { runId?: string; error?: { code: string } } };
}

// ── Cancellation ──────────────────────────────────────────────────────

describe("runOps.cancelRun", () => {
  it("cancels an active run with who and why, and frees the route", async () => {
    const { t, staff, runId, staffId, route, deviceB } = await setup();
    const result = await staff.mutation(api.runOps.cancelRun, { runId, reason: "Bus broke down at Elm St" });
    expect(result).toMatchObject({ status: "ok" });
    const run = await getRun(t, runId);
    expect(run).toMatchObject({
      state: "cancelled",
      cancelledByUserId: staffId,
      cancelReason: "Bus broke down at Elm St",
    });
    expect(run?.endedAtMs).toEqual(run?.cancelledAtMs);
    expect((await audit(t)).map((a) => [a.action, a.resourceId, a.result])).toEqual([
      ["runs.cancel", runId, "allowed"],
    ]);
    // The route is free again: another authorized bus can start it.
    const started = await startOn(t, SECRET_B, GRANT_B, route);
    expect(started.status).toBe(200);
    expect(deviceB).toBeTruthy();
  });

  it("stops accepting positions for a cancelled run", async () => {
    const { t, staff, runId } = await setup();
    await staff.mutation(api.runOps.cancelRun, { runId, reason: "Weather" });
    const res = await t.fetch("/device/v1/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify({
        schemaVersion: 1,
        events: [{ ...demoTelemetryEvent, eventId: crypto.randomUUID(), runId, capturedAtMs: Date.now() - 1000 }],
      }),
    });
    const body = (await res.json()) as { results: { status: string; code?: string }[] };
    expect(body.results[0]).toMatchObject({ status: "rejected", code: "RUN_NOT_AUTHORIZED" });
  });

  it("requires a reason and changes nothing without one", async () => {
    const { t, staff, runId } = await setup();
    expect(await staff.mutation(api.runOps.cancelRun, { runId, reason: "   " })).toMatchObject({
      status: "refused",
      code: "reason_required",
    });
    expect((await getRun(t, runId))?.state).toBe("active");
  });

  it("refuses a run that already ended, and an unknown run", async () => {
    const { t, staff, runId } = await setup();
    await t.run((ctx) => ctx.db.patch(runId, { state: "completed", endedAtMs: Date.now() }));
    expect(await staff.mutation(api.runOps.cancelRun, { runId, reason: "x" })).toMatchObject({
      status: "refused",
      code: "not_active",
    });
    expect((await getRun(t, runId))?.state).toBe("completed");
    expect(await staff.mutation(api.runOps.cancelRun, { runId: "nope", reason: "x" })).toMatchObject({
      status: "refused",
      code: "not_found",
    });
  });

  it("a driver cannot cancel, and the attempt is audited", async () => {
    const { t, driver, runId } = await setup();
    expect(await driver.mutation(api.runOps.cancelRun, { runId, reason: "x" })).toMatchObject({
      status: "access_unavailable",
      reason: "not_permitted",
    });
    expect((await getRun(t, runId))?.state).toBe("active");
    expect((await audit(t)).map((a) => [a.action, a.result])).toEqual([["runs.cancel", "denied"]]);
  });
});

// ── Replacement bus ───────────────────────────────────────────────────

describe("runOps.replaceDevice", () => {
  it("cancels the run on the old bus and links the replacement bus's new run to it", async () => {
    const { t, staff, runId, route, deviceB } = await setup();
    expect(
      await staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: deviceB, reason: "Flat tire" }),
    ).toMatchObject({ status: "ok" });
    const old = await getRun(t, runId);
    expect(old).toMatchObject({ state: "cancelled", cancelReason: "Flat tire", replacementDeviceId: deviceB });

    const started = await startOn(t, SECRET_B, GRANT_B, route);
    expect(started.status).toBe(200);
    const newRunId = started.body.runId as Id<"runs">;
    expect(await getRun(t, newRunId)).toMatchObject({ replacesRunId: runId });
    expect(await getRun(t, runId)).toMatchObject({ replacedByRunId: newRunId });
    expect((await audit(t)).map((a) => a.action)).toEqual(["runs.replaceDevice", "runs.start"]);
  });

  it("a different bus starting the route is not linked as the replacement", async () => {
    const { t, staff, runId, route, deviceB } = await setup();
    await staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: deviceB, reason: "Flat tire" });
    const started = await startOn(t, SECRET_C, GRANT_C, route);
    expect(started.status).toBe(200);
    expect(await getRun(t, started.body.runId as Id<"runs">)).not.toHaveProperty("replacesRunId");
    expect(await getRun(t, runId)).not.toHaveProperty("replacedByRunId");
  });

  it("refuses a revoked, missing, busy, or identical replacement bus and changes nothing", async () => {
    const { t, staff, runId, deviceA, deviceC, revokedDevice, route } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("runs", { deviceId: deviceC, routeVersionId: `${route}-other`, state: "active", startRequestId: "c" }),
    );
    for (const [replacementDeviceId, code] of [
      [revokedDevice, "device_unavailable"],
      ["nope", "device_unavailable"],
      [deviceC, "device_busy"],
      [deviceA, "same_device"],
    ] as const) {
      expect(
        await staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId, reason: "Flat tire" }),
      ).toMatchObject({ status: "refused", code });
    }
    expect((await getRun(t, runId))?.state).toBe("active");
  });

  it("requires a reason", async () => {
    const { staff, runId, deviceB } = await setup();
    expect(await staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: deviceB, reason: "" })).toMatchObject({
      status: "refused",
      code: "reason_required",
    });
  });
});

// ── Service calendar ──────────────────────────────────────────────────

const tomorrow = () => localDate(Date.now() + DAY, TZ);

describe("calendar", () => {
  it("records a no-service day and a late start with a family-facing notice", async () => {
    const { t, staff } = await setup();
    const day = tomorrow();
    expect(
      await staff.mutation(api.calendar.setDay, { serviceDate: day, timezone: TZ, status: "no_service", notice: "Snow day" }),
    ).toMatchObject({ status: "ok" });
    // Setting the same date again replaces the entry; there is one per date.
    expect(
      await staff.mutation(api.calendar.setDay, {
        serviceDate: day,
        timezone: TZ,
        status: "late_start",
        lateStartMinutes: 120,
        notice: "Two-hour delay",
      }),
    ).toMatchObject({ status: "ok" });
    const list = await staff.query(api.calendar.listDays, {});
    expect(list).toMatchObject({
      status: "ready",
      days: [{ serviceDate: day, status: "late_start", lateStartMinutes: 120, notice: "Two-hour delay", setByName: "Riley Staff" }],
    });
    expect((await audit(t)).map((a) => [a.action, a.resourceId])).toEqual([
      ["calendar.setDay", day],
      ["calendar.setDay", day],
    ]);
  });

  it("refuses past dates, bad dates, bad time zones, missing notices, and bad delays", async () => {
    const { staff } = await setup();
    const yesterday = localDate(Date.now() - DAY, TZ);
    const cases: [Record<string, unknown>, string][] = [
      [{ serviceDate: yesterday, status: "no_service", notice: "x" }, "past_date"],
      [{ serviceDate: "2026-02-30", status: "no_service", notice: "x" }, "invalid_date"],
      [{ serviceDate: "tomorrow", status: "no_service", notice: "x" }, "invalid_date"],
      [{ serviceDate: tomorrow(), status: "no_service", notice: "x", timezone: "Mars/Base" }, "invalid_timezone"],
      [{ serviceDate: tomorrow(), status: "no_service", notice: "  " }, "notice_required"],
      [{ serviceDate: tomorrow(), status: "late_start", notice: "x" }, "invalid_delay"],
      [{ serviceDate: tomorrow(), status: "late_start", notice: "x", lateStartMinutes: 0 }, "invalid_delay"],
      [{ serviceDate: tomorrow(), status: "late_start", notice: "x", lateStartMinutes: 241 }, "invalid_delay"],
    ];
    for (const [args, code] of cases) {
      const result = await staff.mutation(api.calendar.setDay, {
        timezone: TZ,
        ...args,
      } as Parameters<typeof staff.mutation<typeof api.calendar.setDay>>[1]);
      expect({ args, result }).toMatchObject({ result: { status: "refused", code } });
    }
    expect(await staff.query(api.calendar.listDays, {})).toMatchObject({ days: [] });
  });

  it("removes a day, and only staff can change the calendar", async () => {
    const { staff, driver } = await setup();
    const day = tomorrow();
    await staff.mutation(api.calendar.setDay, { serviceDate: day, timezone: TZ, status: "no_service", notice: "Holiday" });
    expect(
      await driver.mutation(api.calendar.setDay, { serviceDate: day, timezone: TZ, status: "no_service", notice: "x" }),
    ).toMatchObject({ status: "access_unavailable" });
    expect(await driver.mutation(api.calendar.removeDay, { serviceDate: day })).toMatchObject({ status: "access_unavailable" });
    expect(await driver.query(api.calendar.listDays, {})).toMatchObject({ status: "access_unavailable" });
    expect(await staff.mutation(api.calendar.removeDay, { serviceDate: day })).toMatchObject({ status: "ok" });
    expect(await staff.query(api.calendar.listDays, {})).toMatchObject({ days: [] });
    expect(await staff.mutation(api.calendar.removeDay, { serviceDate: day })).toMatchObject({
      status: "refused",
      code: "not_found",
    });
  });
});

// ── Maintenance windows ───────────────────────────────────────────────

const slot = (deviceId: string, startOffset: number, hours: number, reason = "Software update") => ({
  deviceId,
  startsAtMs: Date.now() + startOffset,
  endsAtMs: Date.now() + startOffset + hours * HOUR,
  reason,
});

describe("maintenance windows", () => {
  it("schedules, lists, and cancels a window", async () => {
    const { t, staff, deviceB } = await setup();
    const result = await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceB, HOUR, 2));
    expect(result).toMatchObject({ status: "ok" });
    const list = await staff.query(api.fleet.listMaintenance, {});
    expect(list).toMatchObject({
      status: "ready",
      windows: [{ deviceId: deviceB, deviceLabel: "Pi B", reason: "Software update", scheduledByName: "Riley Staff" }],
    });
    if (list.status !== "ready") throw new Error("expected ready");
    const windowId = list.windows[0]!.windowId;
    expect(await staff.mutation(api.fleet.cancelMaintenance, { windowId })).toMatchObject({ status: "ok" });
    expect(await staff.query(api.fleet.listMaintenance, {})).toMatchObject({ windows: [] });
    expect((await audit(t)).map((a) => a.action)).toEqual(["maintenance.schedule", "maintenance.cancel"]);
  });

  it("refuses overlapping, inverted, overlong, past, missing-reason, and revoked-device windows", async () => {
    const { staff, deviceB, revokedDevice } = await setup();
    await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceB, HOUR, 2));
    const cases: [ReturnType<typeof slot>, string][] = [
      [slot(deviceB, 2 * HOUR, 2), "overlaps"],
      [{ ...slot(deviceB, 10 * HOUR, 1), endsAtMs: Date.now() + 9 * HOUR }, "invalid_window"],
      [slot(deviceB, 10 * HOUR, 13), "invalid_window"],
      [slot(deviceB, -HOUR, 2), "invalid_window"],
      [slot(deviceB, 10 * HOUR, 1, " "), "reason_required"],
      [slot(revokedDevice, HOUR, 1), "device_unavailable"],
      [slot("nope", HOUR, 1), "device_unavailable"],
    ];
    for (const [args, code] of cases) {
      const result = await staff.mutation(api.fleet.scheduleMaintenance, args);
      expect({ args, result }).toMatchObject({ result: { status: "refused", code } });
    }
  });

  it("refuses a window starting now on a bus that is running", async () => {
    const { staff, deviceA } = await setup();
    expect(await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceA, 0, 1))).toMatchObject({
      status: "refused",
      code: "device_busy",
    });
    // A later window on the same bus is fine; the run should be over by then.
    expect(await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceA, 4 * HOUR, 1))).toMatchObject({
      status: "ok",
    });
  });

  it("a cancelled window no longer blocks a new one, and non-staff can't schedule", async () => {
    const { staff, driver, deviceB } = await setup();
    await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceB, HOUR, 2));
    const list = await staff.query(api.fleet.listMaintenance, {});
    if (list.status !== "ready") throw new Error("expected ready");
    await staff.mutation(api.fleet.cancelMaintenance, { windowId: list.windows[0]!.windowId });
    expect(await staff.mutation(api.fleet.scheduleMaintenance, slot(deviceB, 2 * HOUR, 2))).toMatchObject({ status: "ok" });
    expect(await driver.mutation(api.fleet.scheduleMaintenance, slot(deviceB, 20 * HOUR, 1))).toMatchObject({
      status: "access_unavailable",
    });
  });
});
