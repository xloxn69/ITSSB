import { normalizeToken } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * Trip check-in, roster, staff fallback, seat notes, corrections and scoped
 * removal (docs/09 §6–§10). Fictional people and places only. Times are
 * relative to the real clock because the functions use `Date.now()`.
 */

const modules = import.meta.glob("./**/*.ts");
const HOUR = 60 * 60 * 1000;
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_A = "g".repeat(64);
const GRANT_B = "h".repeat(64);
const GRANT_REVOKED = "r".repeat(64);
const GRANT_EXPIRED = "e".repeat(64);

const STUDENT_1 = "test|student-one";
const STUDENT_2 = "test|student-two";
const STUDENT_OTHER_ROUTE = "test|student-other-route";
const GUARDIAN = "test|guardian";
const STAFF = "test|staff";
const DRIVER = "test|driver";
const PENDING = "test|pending-applicant";

const CHALLENGE = "AAAA-BBBB-CCCC-DDDD-EEEE";
const EXPIRED_CHALLENGE = "FFFF-GGGG-HHHH-JJJJ-KKKK";
const OTHER_RUN_CHALLENGE = "MMMM-NNNN-PPPP-QQQQ-RRRR";
const ENROLLMENT_TOKEN = "SSSS-TTTT-VVVV-WWWW-XXXX";

const hash = async (token: string) => await sha256Hex(normalizeToken(token) as string);

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const h = {
    challenge: await hash(CHALLENGE),
    expired: await hash(EXPIRED_CHALLENGE),
    otherRun: await hash(OTHER_RUN_CHALLENGE),
    enrollment: await hash(ENROLLMENT_TOKEN),
    secretA: await sha256Hex(SECRET_A),
    secretB: await sha256Hex(SECRET_B),
    grantA: await sha256Hex(GRANT_A),
    grantB: await sha256Hex(GRANT_B),
    grantRevoked: await sha256Hex(GRANT_REVOKED),
    grantExpired: await sha256Hex(GRANT_EXPIRED),
  };
  const ids = await t.run(async (ctx) => {
    const staff = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: DRIVER, role: "driver", displayName: "Dana Driver" });
    const s1User = await ctx.db.insert("users", { tokenIdentifier: STUDENT_1, role: "family", displayName: "Alex One" });
    const s2User = await ctx.db.insert("users", { tokenIdentifier: STUDENT_2, role: "family", displayName: "Blake Two" });
    const s3User = await ctx.db.insert("users", { tokenIdentifier: STUDENT_OTHER_ROUTE, role: "family", displayName: "Casey Three" });
    const guardian = await ctx.db.insert("users", { tokenIdentifier: GUARDIAN, role: "family", displayName: "Pat Parent" });

    const routeA = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [] });
    const routeB = await ctx.db.insert("routeVersions", { label: "Route 4 Morning", path: [] });
    const stop1 = await ctx.db.insert("stops", { routeVersionId: routeA, label: "Oak & Pine", latitude: 34.1, longitude: -83.98, sequence: 0 });
    const stop2 = await ctx.db.insert("stops", { routeVersionId: routeA, label: "Maple Court", latitude: 34.11, longitude: -83.98, sequence: 1 });
    const stopB = await ctx.db.insert("stops", { routeVersionId: routeB, label: "Birch Row", latitude: 34.2, longitude: -83.9, sequence: 0 });

    const student1 = await ctx.db.insert("students", { displayName: "Alex One", userId: s1User });
    const student2 = await ctx.db.insert("students", { displayName: "Blake Two", userId: s2User });
    const student3 = await ctx.db.insert("students", { displayName: "Casey Three", userId: s3User });
    const noPhone = await ctx.db.insert("students", { displayName: "Drew NoPhone" });
    const a1 = await ctx.db.insert("assignments", { studentId: student1, routeVersionId: routeA, stopId: stop2, status: "approved" });
    const a2 = await ctx.db.insert("assignments", { studentId: student2, routeVersionId: routeA, stopId: stop1, status: "approved" });
    const a3 = await ctx.db.insert("assignments", { studentId: student3, routeVersionId: routeB, stopId: stopB, status: "approved" });
    const aNoPhone = await ctx.db.insert("assignments", { studentId: noPhone, routeVersionId: routeA, stopId: stop1, status: "approved" });
    await ctx.db.insert("guardianLinks", { guardianUserId: guardian, studentId: student1, status: "approved" });

    const deviceA = await ctx.db.insert("devices", { label: "Pi A", credentialHash: h.secretA, revoked: false });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: h.secretB, revoked: false });
    const grant = (tokenHash: string, deviceId: Id<"devices">, routeVersionIds: Id<"routeVersions">[], extra = {}) =>
      ctx.db.insert("driverGrants", {
        tokenHash,
        deviceId,
        driverUserId: driver,
        routeVersionIds,
        issuedAtMs: now - HOUR,
        expiresAtMs: now + 8 * HOUR,
        revoked: false,
        ...extra,
      });
    await grant(h.grantA, deviceA, [routeA]);
    await grant(h.grantB, deviceB, [routeB]);
    await grant(h.grantRevoked, deviceA, [routeA], { revoked: true });
    await grant(h.grantExpired, deviceA, [routeA], { issuedAtMs: now - 10 * HOUR, expiresAtMs: now - 2 * HOUR });

    const runA = await ctx.db.insert("runs", {
      deviceId: deviceA,
      routeVersionId: routeA,
      state: "active",
      startRequestId: "start-a",
      startedAtMs: now - 3 * HOUR,
      driverUserId: driver,
    });
    const runB = await ctx.db.insert("runs", {
      deviceId: deviceB,
      routeVersionId: routeB,
      state: "active",
      startRequestId: "start-b",
      startedAtMs: now - HOUR,
      driverUserId: driver,
    });
    const token = (tokenHash: string, purpose: "trip_check_in" | "route_enrollment", extra: Record<string, unknown>) =>
      ctx.db.insert("scopedTokens", {
        tokenHash,
        purpose,
        issuedByDeviceId: deviceA,
        issuedAtMs: now - 60_000,
        expiresAtMs: now + 10 * 60_000,
        revoked: false,
        singleUse: false,
        ...extra,
      });
    await token(h.challenge, "trip_check_in", { runId: runA });
    await token(h.expired, "trip_check_in", { runId: runA, expiresAtMs: now - 1 });
    await token(h.otherRun, "trip_check_in", { runId: runB });
    const routeRow = await ctx.db.insert("routes", { label: "Route 17 Morning", direction: "to_school", createdAtMs: now, currentVersionId: routeA });
    await token(h.enrollment, "route_enrollment", { routeId: routeRow });
    return { staff, driver, routeA, routeB, a1, a2, a3, aNoPhone, student1, deviceA, deviceB, runA, runB };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const as = (t: T, who: string) => t.withIdentity({ tokenIdentifier: who });
const scan = (t: T, who: string, runId: string, token = CHALLENGE, requestId = `scan-${who.replace(/\W/g, "")}-0001`) =>
  as(t, who).mutation(api.checkIns.record, { requestId, token, runId });

async function post(t: T, path: string, secret: string | null, body: unknown) {
  const res = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string } } };
}

describe("checkIns:record (student QR claim)", () => {
  it("two students can use the same challenge, each for themselves", async () => {
    const { t, runA } = await setup();
    const one = await scan(t, STUDENT_1, runA);
    const two = await scan(t, STUDENT_2, runA);
    expect(one).toMatchObject({ status: "accepted", checkIn: { status: "boarded", source: "student_qr_claim" } });
    expect(two).toMatchObject({ status: "accepted", checkIn: { status: "boarded", source: "student_qr_claim" } });
    const rows = await t.run((ctx) => ctx.db.query("checkIns").collect());
    expect(new Set(rows.map((r) => r.studentId)).size).toBe(2);
  });

  it("repeat scans make one logical record and return it", async () => {
    const { t, runA } = await setup();
    const first = (await scan(t, STUDENT_1, runA)) as { checkIn: { checkInId: string } };
    const sameRequest = await scan(t, STUDENT_1, runA);
    const newRequest = await scan(t, STUDENT_1, runA, CHALLENGE, "scan-student1-second");
    expect(sameRequest).toMatchObject({ status: "accepted", checkIn: { checkInId: first.checkIn.checkInId } });
    expect(newRequest).toMatchObject({ status: "already_recorded", checkIn: { checkInId: first.checkIn.checkInId } });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(1);
  });

  it("a lost response is reconciled by the same requestId, even after the challenge expires", async () => {
    const { t, runA } = await setup();
    const first = (await scan(t, STUDENT_1, runA)) as { checkIn: { checkInId: string } };
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("scopedTokens").collect()) await ctx.db.patch(row._id, { expiresAtMs: Date.now() - 1 });
    });
    expect(await scan(t, STUDENT_1, runA)).toMatchObject({ status: "accepted", checkIn: { checkInId: first.checkIn.checkInId } });
  });

  it("a requestId reused for another run is a conflict", async () => {
    const { t, runA, runB } = await setup();
    await scan(t, STUDENT_1, runA);
    expect(await scan(t, STUDENT_1, runB, OTHER_RUN_CHALLENGE)).toMatchObject({ status: "rejected", code: "request_id_conflict" });
  });

  it.each([
    ["expired challenge", EXPIRED_CHALLENGE, "expired"],
    ["enrollment invitation", ENROLLMENT_TOKEN, "wrong_purpose"],
    ["unknown code", "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", "invalid"],
    ["garbage", "https://evil.example/x", "invalid"],
  ])("rejects a %s and records nothing", async (_n, token, problem) => {
    const { t, runA } = await setup();
    expect(await scan(t, STUDENT_1, runA, token)).toMatchObject({ status: "token_problem", problem });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(0);
  });

  it("rejects another run's challenge", async () => {
    const { t, runA } = await setup();
    expect(await scan(t, STUDENT_1, runA, OTHER_RUN_CHALLENGE)).toMatchObject({ status: "rejected", code: "wrong_run" });
  });

  it("rejects a student not assigned to the run's route", async () => {
    const { t, runA } = await setup();
    expect(await scan(t, STUDENT_OTHER_ROUTE, runA)).toMatchObject({ status: "rejected", code: "not_assigned" });
  });

  it("a guardian cannot check a student in remotely", async () => {
    const { t, runA } = await setup();
    expect(await scan(t, GUARDIAN, runA)).toMatchObject({ status: "rejected", code: "not_assigned" });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(0);
  });

  it("a pending or signed-out account cannot check in", async () => {
    const { t, runA } = await setup();
    expect(await scan(t, PENDING, runA)).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
    expect(await t.mutation(api.checkIns.record, { requestId: "anon-000001", token: CHALLENGE, runId: runA })).toMatchObject({
      status: "access_unavailable",
    });
  });

  it("once the run ends, the visible challenge no longer works", async () => {
    const { t, runA } = await setup();
    await t.run((ctx) => ctx.db.patch(runA, { state: "completed", endedAtMs: Date.now() }));
    expect(await scan(t, STUDENT_1, runA)).toMatchObject({ status: "rejected", code: "run_not_active" });
  });

  it("the student and linked guardian see the record with its source; others do not", async () => {
    const { t, runA, a1 } = await setup();
    await scan(t, STUDENT_1, runA);
    for (const who of [STUDENT_1, GUARDIAN]) {
      expect(await as(t, who).query(api.checkIns.forAssignment, { assignmentId: a1 })).toMatchObject({
        status: "ready",
        runId: runA,
        checkIn: { status: "boarded", source: "student_qr_claim" },
      });
    }
    expect(await as(t, STUDENT_2).query(api.checkIns.forAssignment, { assignmentId: a1 })).toMatchObject({
      status: "access_unavailable",
      reason: "not_permitted",
    });
  });
});

const action = (type: string, extra: Record<string, unknown>, requestId = `act-${type}-0001`) => ({
  schemaVersion: 1,
  requestId,
  driverOperatingGrant: GRANT_A,
  capturedAtMs: Date.now() - 60_000,
  type,
  ...extra,
});

describe("device roster and QR codes", () => {
  it("issues a check-in challenge for the device's active run that students can use", async () => {
    const { t, runA } = await setup();
    const res = await post(t, "/device/v1/qr-codes", SECRET_A, {
      schemaVersion: 1,
      driverOperatingGrant: GRANT_A,
      purpose: "trip_check_in",
      runId: runA,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purpose: "trip_check_in", linkPath: "/checkin", expiresAtMs: expect.any(Number) });
    expect(await scan(t, STUDENT_2, runA, res.body.token as string)).toMatchObject({ status: "accepted" });
  });

  it("issues an enrollment invitation that cannot be used to check in", async () => {
    const { t, runA, routeA } = await setup();
    const res = await post(t, "/device/v1/qr-codes", SECRET_A, {
      schemaVersion: 1,
      driverOperatingGrant: GRANT_A,
      purpose: "route_enrollment",
      routeVersionId: routeA,
    });
    expect(res.status).toBe(200);
    expect(await scan(t, STUDENT_2, runA, res.body.token as string)).toMatchObject({ status: "token_problem", problem: "wrong_purpose" });
  });

  it.each([
    ["another device's run", SECRET_A, GRANT_A, "runB", 403, "RUN_NOT_AUTHORIZED"],
    ["a revoked grant", SECRET_A, GRANT_REVOKED, "runA", 403, "GRANT_NOT_AUTHORIZED"],
    ["an expired grant", SECRET_A, GRANT_EXPIRED, "runA", 403, "GRANT_NOT_AUTHORIZED"],
    ["another device's grant", SECRET_A, GRANT_B, "runA", 403, "GRANT_NOT_AUTHORIZED"],
    ["no device credential", null, GRANT_A, "runA", 401, "UNAUTHENTICATED"],
  ])("refuses a challenge with %s", async (_n, secret, grant, run, status, code) => {
    const ids = await setup();
    const res = await post(ids.t, "/device/v1/qr-codes", secret, {
      schemaVersion: 1,
      driverOperatingGrant: grant,
      purpose: "trip_check_in",
      runId: run === "runA" ? ids.runA : ids.runB,
    });
    expect(res.status).toBe(status);
    expect(res.body.error?.code).toBe(code);
  });

  it("the roster lists the run's students in stop order, without private fields", async () => {
    const { t, runA } = await setup();
    await scan(t, STUDENT_1, runA);
    const res = await post(t, "/device/v1/roster", SECRET_A, { schemaVersion: 1, driverOperatingGrant: GRANT_A, runId: runA });
    expect(res.status).toBe(200);
    const students = res.body.students as { studentDisplayName: string; checkIn: unknown }[];
    expect(students.map((s) => s.studentDisplayName)).toEqual(["Blake Two", "Drew NoPhone", "Alex One"]);
    expect(students.find((s) => s.studentDisplayName === "Alex One")?.checkIn).toMatchObject({ source: "student_qr_claim" });
    expect(JSON.stringify(res.body)).not.toMatch(/Casey|Pat Parent|address/i);
  });

  it("the roster refuses another device's run and a revoked grant", async () => {
    const { t, runA, runB } = await setup();
    expect((await post(t, "/device/v1/roster", SECRET_A, { schemaVersion: 1, driverOperatingGrant: GRANT_A, runId: runB })).status).toBe(403);
    expect((await post(t, "/device/v1/roster", SECRET_A, { schemaVersion: 1, driverOperatingGrant: GRANT_REVOKED, runId: runA })).status).toBe(403);
  });
});

describe("driver roster actions", () => {
  it("staff fallback records a student with no phone, idempotently", async () => {
    const { t, runA, aNoPhone } = await setup();
    const body = action("recordAttendance", { runId: runA, assignmentId: aNoPhone, status: "boarded" });
    const first = await post(t, "/device/v1/roster-actions", SECRET_A, body);
    expect(first.body).toMatchObject({ status: "accepted", checkIn: { source: "staff_recorded", status: "boarded" } });
    const retry = await post(t, "/device/v1/roster-actions", SECRET_A, body);
    expect(retry.body).toMatchObject({ status: "accepted" });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(1);
    const changed = await post(t, "/device/v1/roster-actions", SECRET_A, { ...body, status: "not_boarded" });
    expect(changed.body).toMatchObject({ status: "rejected", code: "request_id_conflict" });
  });

  it("a queued offline action keeps its capture time and is accepted later with a then-valid grant", async () => {
    const { t, runA, aNoPhone } = await setup();
    const capturedAtMs = Date.now() - 3 * HOUR; // grant expired 2 h ago; valid at capture
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("recordAttendance", { runId: runA, assignmentId: aNoPhone, status: "boarded" }),
      driverOperatingGrant: GRANT_EXPIRED,
      capturedAtMs: capturedAtMs - 2 * HOUR,
    });
    expect(res.body).toMatchObject({ status: "rejected", code: "run_not_authorized" }); // before the run started
    const ok = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("recordAttendance", { runId: runA, assignmentId: aNoPhone, status: "boarded" }, "act-queued-0002"),
      driverOperatingGrant: GRANT_EXPIRED,
      capturedAtMs: Date.now() - 2.5 * HOUR,
    });
    expect(ok.body).toMatchObject({ status: "accepted", checkIn: { recordedAtMs: expect.any(Number) } });
  });

  it("a queued action captured after its grant expired is rejected, not silently accepted", async () => {
    const { t, runA, aNoPhone } = await setup();
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("recordAttendance", { runId: runA, assignmentId: aNoPhone, status: "boarded" }),
      driverOperatingGrant: GRANT_EXPIRED,
      capturedAtMs: Date.now() - HOUR,
    });
    expect(res.body).toMatchObject({ status: "rejected", code: "grant_not_authorized" });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(0);
  });

  it("a correction keeps the original record and becomes current", async () => {
    const { t, runA, a1, staff } = await setup();
    const scanned = (await scan(t, STUDENT_1, runA)) as { checkIn: { checkInId: string } };
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, action("correctAttendance", {
      runId: runA,
      assignmentId: a1,
      status: "not_boarded",
      correctsCheckInId: scanned.checkIn.checkInId,
      reason: "Scanned at the stop but stayed home",
    }));
    expect(res.body).toMatchObject({ status: "accepted", checkIn: { source: "staff_correction", status: "not_boarded" } });
    expect(await t.run((ctx) => ctx.db.query("checkIns").collect())).toHaveLength(2);
    const view = await as(t, STAFF).query(api.checkIns.runAttendance, { runId: runA });
    const alex = (view as { students: { studentDisplayName: string; current: unknown; history: unknown[] }[] }).students.find(
      (s) => s.studentDisplayName === "Alex One",
    );
    expect(alex?.current).toMatchObject({ source: "staff_correction", status: "not_boarded" });
    expect(alex?.history).toHaveLength(2);
    void staff;
  });

  it("seat notes: a newer change wins and an older queued one is superseded", async () => {
    const { t, a1 } = await setup();
    const newer = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("setSeatNote", { assignmentId: a1, seatLabel: "4A", driverNote: "Sits near the front" }),
      capturedAtMs: Date.now() - 1000,
    });
    expect(newer.body).toMatchObject({ status: "accepted" });
    const older = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("setSeatNote", { assignmentId: a1, seatLabel: "9C", driverNote: null }, "act-seat-older"),
      capturedAtMs: Date.now() - 60 * 60_000,
    });
    expect(older.body).toMatchObject({ status: "superseded" });
    const row = await t.run((ctx) => ctx.db.get(a1));
    expect(row).toMatchObject({ seatLabel: "4A", driverNote: "Sits near the front" });
    // Seat notes are staff data: families never receive them.
    const family = await as(t, STUDENT_1).query(api.tracking.myAssignments, {});
    expect(JSON.stringify(family)).not.toContain("4A");
  });

  it("removal revokes one assignment, keeps the student, links and history, and is audited", async () => {
    const { t, runA, a1, student1 } = await setup();
    await scan(t, STUDENT_1, runA);
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, action("removeAssignment", { assignmentId: a1, reason: "Moved schools" }));
    expect(res.body).toMatchObject({ status: "accepted" });
    const state = await t.run(async (ctx) => ({
      assignment: await ctx.db.get(a1),
      student: await ctx.db.get(student1),
      links: await ctx.db.query("guardianLinks").collect(),
      checkIns: await ctx.db.query("checkIns").collect(),
      audit: await ctx.db.query("auditLog").collect(),
    }));
    expect(state.assignment).toMatchObject({ status: "revoked", revokeReason: "Moved schools" });
    expect(state.student).not.toBeNull();
    expect(state.links[0]?.status).toBe("approved");
    expect(state.checkIns).toHaveLength(1);
    expect(state.audit.find((r) => r.action === "assignment.remove")).toMatchObject({
      source: "driver_device",
      reason: "Moved schools",
      capturedAtMs: expect.any(Number),
    });
    expect(await as(t, STUDENT_1).query(api.tracking.myAssignments, {})).toMatchObject({ assignments: [] });
  });

  it("a driver cannot remove another route's student", async () => {
    const { t, a3 } = await setup();
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, action("removeAssignment", { assignmentId: a3, reason: "x" }));
    expect(res.body).toMatchObject({ status: "rejected", code: "assignment_not_authorized" });
    expect((await t.run((ctx) => ctx.db.get(a3)))?.status).toBe("approved");
  });

  it("a removal queued offline under a grant revoked since is rejected and the student keeps access", async () => {
    const { t, a1 } = await setup();
    const res = await post(t, "/device/v1/roster-actions", SECRET_A, {
      ...action("removeAssignment", { assignmentId: a1, reason: "Moved" }),
      driverOperatingGrant: GRANT_REVOKED,
    });
    expect(res.body).toMatchObject({ status: "rejected", code: "grant_not_authorized" });
    expect(await as(t, STUDENT_1).query(api.tracking.myAssignments, {})).toMatchObject({
      assignments: [{ assignmentId: a1 }],
    });
  });

  it("refuses a capture time in the future or too old", async () => {
    const { t, runA, aNoPhone } = await setup();
    for (const capturedAtMs of [Date.now() + 10 * 60_000, Date.now() - 30 * HOUR]) {
      const res = await post(t, "/device/v1/roster-actions", SECRET_A, {
        ...action("recordAttendance", { runId: runA, assignmentId: aNoPhone, status: "boarded" }, `act-time-${capturedAtMs}`),
        capturedAtMs,
      });
      expect(res.body).toMatchObject({ status: "rejected" });
    }
  });

  it("rejects malformed bodies at the request level", async () => {
    const { t } = await setup();
    expect((await post(t, "/device/v1/roster-actions", SECRET_A, "{nope")).status).toBe(400);
    expect((await post(t, "/device/v1/roster-actions", SECRET_A, { schemaVersion: 1, type: "patchRow" })).status).toBe(400);
    expect((await post(t, "/device/v1/roster-actions", null, action("recordAttendance", {}))).status).toBe(401);
  });
});

describe("staff attendance and removal", () => {
  it("staff can record attendance for a student with no phone, and remove an assignment with a reason", async () => {
    const { t, runA, aNoPhone, a2 } = await setup();
    expect(
      await as(t, STAFF).mutation(api.checkIns.staffRecord, { runId: runA, assignmentId: aNoPhone, status: "boarded" }),
    ).toMatchObject({ status: "accepted", checkIn: { source: "staff_recorded" } });
    expect(
      await as(t, STAFF).mutation(api.routes.removeAssignment, { requestId: "rm-000001", assignmentId: a2, reason: " " }),
    ).toMatchObject({ status: "refused", code: "reason_required" });
    expect(
      await as(t, STAFF).mutation(api.routes.removeAssignment, { requestId: "rm-000001", assignmentId: a2, reason: "Family request" }),
    ).toMatchObject({ status: "accepted" });
    expect((await t.run((ctx) => ctx.db.get(a2)))?.status).toBe("revoked");
  });

  it("recent runs show counts", async () => {
    const { t, runA } = await setup();
    await scan(t, STUDENT_1, runA);
    const res = await as(t, STAFF).query(api.checkIns.recentRuns, {});
    expect(res).toMatchObject({ status: "ready" });
    const run = (res as { runs: { runId: string; assignedCount: number; boardedCount: number }[] }).runs.find((r) => r.runId === runA);
    expect(run).toMatchObject({ assignedCount: 3, boardedCount: 1 });
  });

  type Ids = Omit<Awaited<ReturnType<typeof setup>>, "t">;
  const STAFF_CALLS: [string, (t: T, ids: Ids) => Promise<unknown>][] = [
    ["checkIns.runAttendance", (t, { runA }) => t.query(api.checkIns.runAttendance, { runId: runA })],
    ["checkIns.recentRuns", (t) => t.query(api.checkIns.recentRuns, {})],
    ["checkIns.staffRecord", (t, { runA, aNoPhone }) => t.mutation(api.checkIns.staffRecord, { runId: runA, assignmentId: aNoPhone, status: "boarded" })],
    ["routes.removeAssignment", (t, { a2 }) => t.mutation(api.routes.removeAssignment, { requestId: "rm-000009", assignmentId: a2, reason: "x" })],
  ];
  for (const [name, call] of STAFF_CALLS) {
    for (const who of [null, DRIVER, STUDENT_1, GUARDIAN, PENDING]) {
      it(`${name}: ${who ?? "signed out"} is denied and changes nothing`, async () => {
        const { t, ...ids } = await setup();
        const result = await call(who ? (as(t, who) as unknown as T) : t, ids);
        expect(result).toMatchObject({ status: "access_unavailable" });
        const state = await t.run(async (ctx) => ({
          checkIns: (await ctx.db.query("checkIns").collect()).length,
          revoked: (await ctx.db.query("assignments").collect()).filter((a) => a.status === "revoked").length,
        }));
        expect(state).toEqual({ checkIns: 0, revoked: 0 });
      });
    }
  }
});
