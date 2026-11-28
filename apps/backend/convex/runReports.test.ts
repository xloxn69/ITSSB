import { REPORTED_DELAY_SHOWN_FOR_MS, type RunReportRequest, type RunReportResult } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * `POST /device/v1/run-reports` (docs/08 §9.3) and where a report shows:
 * the family's `tracking.myRun` (category and minutes only), and staff run
 * attendance and diagnostics.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const STUDENT = "test|student";
const GUARDIAN = "test|guardian";
const STRANGER = "test|stranger";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_A = "g".repeat(64);
const GRANT_B = "h".repeat(64);
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana Driver" });
    const studentUser = await ctx.db.insert("users", { tokenIdentifier: STUDENT, role: "family", displayName: "Sam" });
    const guardianUser = await ctx.db.insert("users", { tokenIdentifier: GUARDIAN, role: "family", displayName: "Pat" });
    await ctx.db.insert("users", { tokenIdentifier: STRANGER, role: "family", displayName: "Lee" });
    const version = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const otherVersion = await ctx.db.insert("routeVersions", { label: "Route 9 Morning", path: [] });
    const stopA = await ctx.db.insert("stops", { routeVersionId: version, label: "Oak & Pine", latitude: 34.1, longitude: -83.98, sequence: 0 });
    // A stop nobody is assigned to: the driver screen still needs it.
    await ctx.db.insert("stops", { routeVersionId: version, label: "Cedar Loop", latitude: 34.11, longitude: -83.97, sequence: 1 });
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example", userId: studentUser });
    const assignment = await ctx.db.insert("assignments", { studentId, routeVersionId: version, stopId: stopA, status: "approved" });
    await ctx.db.insert("guardianLinks", { guardianUserId: guardianUser, studentId, status: "approved" });
    const deviceA = await ctx.db.insert("devices", {
      label: "Pi A",
      credentialHash: await sha256Hex(SECRET_A),
      revoked: false,
      busLabel: "Bus 12",
    });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: await sha256Hex(SECRET_B), revoked: false });
    const run = await ctx.db.insert("runs", {
      deviceId: deviceA,
      routeVersionId: version,
      state: "active",
      startRequestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      startedAtMs: NOW - 30 * MIN,
      startCapturedAtMs: NOW - 30 * MIN,
      driverUserId: driver,
    });
    return { driver, deviceA, deviceB, version, otherVersion, run, assignment };
  });
  for (const [grant, deviceId] of [
    [GRANT_A, ids.deviceA],
    [GRANT_B, ids.deviceB],
  ] as const) {
    await t.mutation(internal.driverGrants.insert, {
      tokenHash: await sha256Hex(grant),
      deviceId,
      driverUserId: ids.driver,
      routeVersionIds: [ids.version],
      ttlMs: 8 * HOUR,
      nowMs: NOW - HOUR,
    });
  }
  return { t, ...ids };
}
type T = Awaited<ReturnType<typeof setup>>["t"];

function report(runId: string, patch: Partial<RunReportRequest> = {}): RunReportRequest {
  return {
    schemaVersion: 1,
    requestId: "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
    driverOperatingGrant: GRANT_A,
    runId,
    capturedAtMs: NOW - 5 * MIN,
    category: "traffic",
    expectedDelayMinutes: 10,
    ...patch,
  };
}

async function send(t: T, body: unknown, secret = SECRET_A) {
  const res = await t.fetch("/device/v1/run-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as RunReportResult & { error?: { code: string } } };
}

const rows = (t: T) => t.run((ctx) => ctx.db.query("runReports").collect());
const audits = (t: T) => t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "run.report"));

async function rejectedWith(t: T, body: unknown, code: string, secret?: string) {
  const r = await send(t, body, secret);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe("rejected");
  if (r.body.status === "rejected") expect(r.body.code).toBe(code);
  expect(await rows(t)).toHaveLength(0);
}

describe("POST /device/v1/run-reports", () => {
  it("stores the report on the run, audits the driver, and answers a retry with the same report", async () => {
    const { t, run, driver, deviceA } = await setup();
    const first = await send(t, report(run));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("accepted");
    const again = await send(t, report(run));
    expect(again.body.status).toBe("already_recorded");
    if (first.body.status !== "accepted" || again.body.status !== "already_recorded") throw new Error("not stored");
    expect(again.body.report).toEqual(first.body.report);
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ runId: run, deviceId: deviceA, driverUserId: driver, category: "traffic", expectedDelayMinutes: 10 });
    const allowed = (await audits(t)).filter((a) => a.result === "allowed");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ actor: { kind: "user", userId: driver }, viaDeviceId: deviceA, source: "driver_device" });
  });

  it("refuses the same requestId with different content and keeps the first report", async () => {
    const { t, run } = await setup();
    await send(t, report(run));
    const r = await send(t, report(run, { expectedDelayMinutes: 25 }));
    expect(r.body.status).toBe("rejected");
    if (r.body.status === "rejected") expect(r.body.code).toBe("request_id_conflict");
    const stored = await rows(t);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.expectedDelayMinutes).toBe(10);
  });

  it("never stores free text sent alongside the category", async () => {
    const { t, run } = await setup();
    const r = await send(t, { ...report(run), explanation: "Sam Example was hurt", message: "x" });
    expect(r.body.status).toBe("accepted");
    const [row] = await rows(t);
    expect(Object.keys(row ?? {})).not.toContain("explanation");
    expect(JSON.stringify(row)).not.toContain("Sam Example");
  });

  it("refuses another device's report on this bus's run", async () => {
    const { t, run } = await setup();
    await rejectedWith(t, report(run, { driverOperatingGrant: GRANT_B }), "run_not_authorized", SECRET_B);
    const denied = (await audits(t)).filter((a) => a.result === "denied");
    expect(denied).toHaveLength(1);
  });

  it("refuses another device's grant presented by this device", async () => {
    const { t, run } = await setup();
    await rejectedWith(t, report(run, { driverOperatingGrant: GRANT_B }), "grant_not_authorized");
  });

  it("refuses a revoked grant", async () => {
    const { t, run } = await setup();
    await t.run(async (ctx) => {
      const g = await ctx.db.query("driverGrants").collect();
      for (const row of g) await ctx.db.patch(row._id, { revoked: true });
    });
    await rejectedWith(t, report(run), "grant_not_authorized");
  });

  it("refuses an expired grant", async () => {
    const { t, run } = await setup();
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("driverGrants").collect()) await ctx.db.patch(row._id, { expiresAtMs: NOW - MIN });
    });
    await rejectedWith(t, report(run, { capturedAtMs: NOW - 2 * MIN }), "grant_not_authorized");
  });

  it("refuses a report made before the grant was issued", async () => {
    const { t, run } = await setup();
    await rejectedWith(t, report(run, { capturedAtMs: NOW - 2 * HOUR }), "grant_not_authorized");
  });

  it.each(["scheduled", "cancelled"] as const)("refuses a report on a %s run", async (state) => {
    const { t, run } = await setup();
    await t.run((ctx) => ctx.db.patch(run, { state }));
    await rejectedWith(t, report(run), "run_not_authorized");
  });

  it("refuses a report made before the run started", async () => {
    const { t, run } = await setup();
    await rejectedWith(t, report(run, { capturedAtMs: NOW - 45 * MIN }), "run_not_authorized");
  });

  it("refuses a run on a route the grant does not cover", async () => {
    const { t, run, otherVersion } = await setup();
    await t.run((ctx) => ctx.db.patch(run, { routeVersionId: otherVersion }));
    await rejectedWith(t, report(run), "run_not_authorized");
  });

  it("refuses an unknown run id", async () => {
    const { t } = await setup();
    await rejectedWith(t, report("not_a_run"), "run_not_authorized");
  });

  it("accepts a report queued offline during the run that arrives after the run ended", async () => {
    const { t, run } = await setup();
    await t.run((ctx) => ctx.db.patch(run, { state: "completed", endedAtMs: NOW - MIN, endCapturedAtMs: NOW - 2 * MIN }));
    expect((await send(t, report(run))).body.status).toBe("accepted");
    // But not one made after the bus ended the run.
    const late = await send(t, report(run, { requestId: "1b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d", capturedAtMs: NOW - MIN }));
    expect(late.body.status).toBe("rejected");
  });

  it("refuses a capture time in the future", async () => {
    const { t, run } = await setup();
    await rejectedWith(t, report(run, { capturedAtMs: NOW + 10 * MIN }), "capture_time_out_of_range");
  });

  it("answers 401 to a revoked device credential and 400 to a category outside the list", async () => {
    const { t, run, deviceA } = await setup();
    expect((await send(t, { ...report(run), category: "late" })).status).toBe(400);
    await t.run((ctx) => ctx.db.patch(deviceA, { revoked: true }));
    expect((await send(t, report(run))).status).toBe(401);
    expect(await rows(t)).toHaveLength(0);
  });
});

async function stored(t: T, run: Id<"runs">, patch: { capturedAtMs: number; receivedAtMs: number; requestId?: string; minutes?: number | null }) {
  await t.run(async (ctx) => {
    const r = await ctx.db.get(run);
    const grant = (await ctx.db.query("driverGrants").collect())[0]!;
    await ctx.db.insert("runReports", {
      runId: run,
      deviceId: r!.deviceId,
      driverUserId: grant.driverUserId,
      grantId: grant._id,
      requestId: patch.requestId ?? crypto.randomUUID(),
      category: "mechanical",
      expectedDelayMinutes: patch.minutes === undefined ? 15 : patch.minutes,
      capturedAtMs: patch.capturedAtMs,
      receivedAtMs: patch.receivedAtMs,
    });
  });
}

describe("tracking.myRun reportedDelay", () => {
  it("shows the student and guardian the newest report, category and minutes only, with no ETA needed", async () => {
    const { t, run, assignment } = await setup();
    await send(t, report(run));
    for (const who of [STUDENT, GUARDIAN]) {
      const r = await t.withIdentity({ tokenIdentifier: who }).query(api.tracking.myRun, { assignmentId: assignment });
      expect(r.status).toBe("ready");
      if (r.status !== "ready") return;
      expect(r.run.eta).toBeNull();
      expect(r.run.reportedDelay).toEqual({
        category: "traffic",
        minutes: 10,
        reportedAtMs: NOW - 5 * MIN,
        validUntilMs: NOW - 5 * MIN + REPORTED_DELAY_SHOWN_FOR_MS,
        source: "driver",
      });
    }
  });

  it("gives an account outside the run nothing", async () => {
    const { t, run, assignment } = await setup();
    await send(t, report(run));
    const r = await t.withIdentity({ tokenIdentifier: STRANGER }).query(api.tracking.myRun, { assignmentId: assignment });
    expect(r.status).toBe("access_unavailable");
    expect(JSON.stringify(r)).not.toContain("traffic");
  });

  it("dates a report that sat offline by when it was made, and picks the newest made on the bus", async () => {
    const { t, run, assignment } = await setup();
    await stored(t, run, { capturedAtMs: NOW - 20 * MIN, receivedAtMs: NOW - MIN, minutes: 30 });
    await stored(t, run, { capturedAtMs: NOW - 25 * MIN, receivedAtMs: NOW - 24 * MIN, minutes: 5 });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId: assignment });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.run.reportedDelay).toMatchObject({ minutes: 30, reportedAtMs: NOW - 20 * MIN });
  });

  it("stops showing a report once it is older than REPORTED_DELAY_SHOWN_FOR_MS", async () => {
    const { t, run, assignment } = await setup();
    await stored(t, run, { capturedAtMs: NOW - REPORTED_DELAY_SHOWN_FOR_MS - MIN, receivedAtMs: NOW - 2 * MIN });
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId: assignment });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.run.reportedDelay).toBeNull();
  });

  it("is null on an active run with no report", async () => {
    const { t, assignment } = await setup();
    const r = await t.withIdentity({ tokenIdentifier: STUDENT }).query(api.tracking.myRun, { assignmentId: assignment });
    if (r.status !== "ready") throw new Error(r.status);
    expect(r.run.reportedDelay).toBeNull();
  });
});

describe("staff views and the driver roster", () => {
  it("shows staff the report with the driver's name on run attendance and diagnostics", async () => {
    const { t, run, deviceA } = await setup();
    await send(t, report(run));
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const view = await staff.query(api.checkIns.runAttendance, { runId: run });
    if (view.status !== "ready") throw new Error(view.status);
    expect(view.reports).toEqual([expect.objectContaining({ category: "traffic", expectedDelayMinutes: 10, driverName: "Dana Driver" })]);
    const diag = await staff.query(api.fleet.diagnostics, {});
    if (diag.status !== "ready") throw new Error(diag.status);
    const pi = diag.devices.find((d) => d.deviceId === deviceA);
    expect(pi?.lastRunReport).toMatchObject({ runId: run, category: "traffic" });
  });

  it("does not show staff reports to a family account", async () => {
    const { t, run } = await setup();
    await send(t, report(run));
    const view = await t.withIdentity({ tokenIdentifier: GUARDIAN }).query(api.checkIns.runAttendance, { runId: run });
    expect(view.status).toBe("access_unavailable");
  });

  it("sends the driver roster every approved stop of the run's route, with or without students", async () => {
    const { t, run } = await setup();
    const res = await t.fetch("/device/v1/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify({ schemaVersion: 1, driverOperatingGrant: GRANT_A, runId: run }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stops: { label: string; sequence: number; latitude: number }[] };
    expect(body.stops.map((s) => [s.label, s.sequence])).toEqual([
      ["Oak & Pine", 0],
      ["Cedar Loop", 1],
    ]);
  });
});
