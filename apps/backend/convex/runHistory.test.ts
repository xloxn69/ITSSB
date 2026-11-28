import { localDate, type RunAttendanceResult } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * D14 (docs/13 §4): staff see a run's explicit history on
 * `checkIns:runAttendance`: start, cancellation, replacement links, end,
 * and the students removed from its route while it was going, in time
 * order. Staff only; another route's removals never appear. Fictional
 * people and places only. The clock is faked so every step has its own time.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const FAMILY = "test|family";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_A = "g".repeat(64);
const GRANT_B = "h".repeat(64);
const TZ = "America/New_York";
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0); // a fictional school morning

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const familyUser = await ctx.db.insert("users", { tokenIdentifier: FAMILY, role: "family", displayName: "Sam" });
    const dana = await ctx.db.insert("users", { tokenIdentifier: "test|dana", role: "driver", displayName: "Dana Driver" });
    const morgan = await ctx.db.insert("users", { tokenIdentifier: "test|morgan", role: "driver", displayName: "Morgan Driver" });
    const route = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const otherRoute = await ctx.db.insert("routeVersions", { label: "Route 4 Morning", path: [] });
    const stop = await ctx.db.insert("stops", { routeVersionId: route, label: "Oak & Pine", latitude: 34.1, longitude: -83.98 });
    const otherStop = await ctx.db.insert("stops", { routeVersionId: otherRoute, label: "Birch Row", latitude: 34.2, longitude: -83.9 });
    const assign = async (name: string, routeVersionId = route, stopId = stop) => {
      const studentId = await ctx.db.insert("students", { displayName: name, ...(name === "Sam Example" ? { userId: familyUser } : {}) });
      return await ctx.db.insert("assignments", { studentId, routeVersionId, stopId, status: "approved" });
    };
    const sam = await assign("Sam Example");
    const casey = await assign("Casey Sample");
    const jordan = await assign("Jordan Later");
    const lee = await assign("Lee Elsewhere", otherRoute, otherStop);
    const deviceA = await ctx.db.insert("devices", { label: "Pi A", credentialHash: await sha256Hex(SECRET_A), revoked: false, busLabel: "Bus 12" });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: await sha256Hex(SECRET_B), revoked: false, busLabel: "Bus 30" });
    for (const [secret, deviceId, driverUserId] of [
      [GRANT_A, deviceA, dana],
      [GRANT_B, deviceB, morgan],
    ] as const) {
      await ctx.db.insert("driverGrants", {
        tokenHash: await sha256Hex(secret),
        deviceId,
        driverUserId,
        routeVersionIds: [route],
        issuedAtMs: T0 - HOUR,
        expiresAtMs: T0 + 8 * HOUR,
        revoked: false,
      });
    }
    return { route, sam, casey, jordan, lee, deviceB };
  });
  return { t, staff: t.withIdentity({ tokenIdentifier: STAFF }), family: t.withIdentity({ tokenIdentifier: FAMILY }), ...ids };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function post(s: Setup, path: string, secret: string, body: unknown) {
  const res = await s.t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function startRun(s: Setup, secret: string, grant: string) {
  const capturedAtMs = Date.now();
  const res = await post(s, "/device/v1/trip-events", secret, {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    type: "startRun",
    driverOperatingGrant: grant,
    routeVersionId: s.route,
    serviceDate: localDate(capturedAtMs, TZ),
    serviceTimezone: TZ,
    capturedAtMs,
  });
  expect(res).toMatchObject({ status: "accepted" });
  return res.runId as string;
}

const staffRemove = (s: Setup, assignmentId: string, reason: string) =>
  s.staff.mutation(api.routes.removeAssignment, { requestId: crypto.randomUUID(), assignmentId, reason });

const at = (ms: number) => vi.setSystemTime(T0 + ms);

/**
 * Bus 12 starts Route 17; staff remove a student; the driver removes
 * another while offline; staff send Bus 30; the queued removal syncs after
 * the cancel; another route and a later removal happen too; Bus 30 starts
 * and finishes.
 */
async function cancelAndReplace() {
  const s = await setup();
  const original = await startRun(s, SECRET_A, GRANT_A);
  at(10 * MIN);
  expect(await staffRemove(s, s.casey, "Moved to Route 4")).toMatchObject({ status: "accepted" });
  at(15 * MIN);
  expect(await staffRemove(s, s.lee, "Other route change")).toMatchObject({ status: "accepted" });
  at(30 * MIN);
  expect(
    await s.staff.mutation(api.runOps.replaceDevice, { runId: original, replacementDeviceId: s.deviceB, reason: "Flat tire" }),
  ).toMatchObject({ status: "ok" });
  // Made on Bus 12 at +20 min while offline, received at +40 min, after the cancel.
  at(40 * MIN);
  const queued = await post(s, "/device/v1/roster-actions", SECRET_A, {
    schemaVersion: 1,
    requestId: "act-remove-queued-0001",
    driverOperatingGrant: GRANT_A,
    capturedAtMs: T0 + 20 * MIN,
    type: "removeAssignment",
    assignmentId: s.sam,
    reason: "Family moved away",
  });
  expect(queued).toMatchObject({ status: "accepted" });
  at(45 * MIN);
  expect(await staffRemove(s, s.jordan, "Between runs")).toMatchObject({ status: "accepted" });
  at(50 * MIN);
  const replacement = await startRun(s, SECRET_B, GRANT_B);
  at(90 * MIN);
  const ended = await post(s, "/device/v1/trip-events", SECRET_B, {
    schemaVersion: 1,
    requestId: crypto.randomUUID(),
    type: "endRun",
    driverOperatingGrant: GRANT_B,
    runId: replacement,
    capturedAtMs: Date.now(),
    lastRunSequence: null,
  });
  expect(ended).toMatchObject({ status: "accepted", state: "completed" });
  return { ...s, original, replacement };
}

function historyOf(r: RunAttendanceResult) {
  if (r.status !== "ready") throw new Error(`expected ready, got ${r.status}`);
  return r.history ?? [];
}

describe("D14: staff run history on checkIns.runAttendance", () => {
  it("a cancelled and replaced run lists who did what, why, and the replacement, in time order", async () => {
    const s = await cancelAndReplace();
    const history = historyOf(await s.staff.query(api.checkIns.runAttendance, { runId: s.original }));
    expect(history).toEqual([
      { kind: "started", atMs: T0, driverName: "Dana Driver", busLabel: "Bus 12" },
      {
        kind: "assignment_removed",
        atMs: T0 + 10 * MIN,
        receivedAtMs: T0 + 10 * MIN,
        studentDisplayName: "Casey Sample",
        byName: "Riley Staff",
        reason: "Moved to Route 4",
        source: "staff_web",
      },
      {
        kind: "assignment_removed",
        atMs: T0 + 20 * MIN,
        receivedAtMs: T0 + 40 * MIN,
        studentDisplayName: "Sam Example",
        byName: "Dana Driver",
        reason: "Family moved away",
        source: "driver_device",
      },
      { kind: "cancelled", atMs: T0 + 30 * MIN, byName: "Riley Staff", reason: "Flat tire", replacementBusLabel: "Bus 30" },
      { kind: "replaced_by", atMs: T0 + 50 * MIN, run: { runId: s.replacement, busLabel: "Bus 30", state: "completed" } },
    ]);
  });

  it("the replacement run links back to the run it replaced and says who ended it", async () => {
    const s = await cancelAndReplace();
    const history = historyOf(await s.staff.query(api.checkIns.runAttendance, { runId: s.replacement }));
    expect(history).toEqual([
      { kind: "started", atMs: T0 + 50 * MIN, driverName: "Morgan Driver", busLabel: "Bus 30" },
      { kind: "replaces", atMs: T0 + 50 * MIN, run: { runId: s.original, busLabel: "Bus 12", state: "cancelled" } },
      { kind: "ended", atMs: T0 + 90 * MIN, driverName: "Morgan Driver", busLabel: "Bus 30" },
    ]);
  });

  it("a replacement sent but not started shows the bus and no link", async () => {
    const s = await setup();
    const runId = await startRun(s, SECRET_A, GRANT_A);
    at(5 * MIN);
    await s.staff.mutation(api.runOps.replaceDevice, { runId, replacementDeviceId: s.deviceB, reason: "Flat tire" });
    const history = historyOf(await s.staff.query(api.checkIns.runAttendance, { runId }));
    expect(history.map((e) => e.kind)).toEqual(["started", "cancelled"]);
    expect(history[1]).toMatchObject({ replacementBusLabel: "Bus 30" });
  });

  it("a non-staff caller gets access_unavailable and no history", async () => {
    const s = await cancelAndReplace();
    const r = await s.family.query(api.checkIns.runAttendance, { runId: s.original });
    expect(r).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
    expect(JSON.stringify(r)).not.toContain("Flat tire");
    const anon = await s.t.query(api.checkIns.runAttendance, { runId: s.original });
    expect(anon).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
  });

  it("families get nothing new: their trip status carries no history or staff reason", async () => {
    const s = await cancelAndReplace();
    const wire = JSON.stringify(await s.family.query(api.tracking.myRun, { assignmentId: s.sam }));
    expect(wire).not.toContain("history");
    expect(wire).not.toContain("Flat tire");
  });
});
