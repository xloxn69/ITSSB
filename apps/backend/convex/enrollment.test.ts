import { normalizeToken } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Fictional people and places only.
const STAFF = "test|staff";
const DRIVER = "test|driver";
const FAMILY = "test|existing-family";
const APPLICANT = "test|new-student";
const GUARDIAN = "test|new-guardian";
const OTHER = "test|someone-else";

const ROUTE_TOKEN = "AAAA-BBBB-CCCC-DDDD-EEEE";
const EXPIRED_TOKEN = "FFFF-GGGG-HHHH-JJJJ-KKKK";
const GUARDIAN_TOKEN = "MMMM-NNNN-PPPP-QQQQ-RRRR";
const CHECKIN_TOKEN = "SSSS-TTTT-VVVV-WWWW-XXXX";
const REVOKED_TOKEN = "YYYY-ZZZZ-0000-1111-2222";
const ADDRESS = "12 Fictional Lane, Exampletown";

const HOUR = 60 * 60 * 1000;

async function hash(token: string) {
  return await sha256Hex(normalizeToken(token) as string);
}

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const hashes = {
    route: await hash(ROUTE_TOKEN),
    expired: await hash(EXPIRED_TOKEN),
    guardian: await hash(GUARDIAN_TOKEN),
    checkin: await hash(CHECKIN_TOKEN),
    revoked: await hash(REVOKED_TOKEN),
  };
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    await ctx.db.insert("users", { tokenIdentifier: DRIVER, role: "driver", displayName: "Dana Driver" });
    await ctx.db.insert("users", { tokenIdentifier: FAMILY, role: "family", displayName: "Pat Parent" });

    const routeId = await ctx.db.insert("routes", { label: "Route 17 Morning", direction: "to_school", createdAtMs: now });
    const versionId = await ctx.db.insert("routeVersions", {
      label: "Route 17 Morning",
      path: [
        { latitude: 34.1, longitude: -83.98 },
        { latitude: 34.11, longitude: -83.98 },
      ],
      routeId,
      versionNumber: 1,
    });
    await ctx.db.patch(routeId, { currentVersionId: versionId });
    const stopA = await ctx.db.insert("stops", {
      routeVersionId: versionId,
      label: "Oak & Pine",
      latitude: 34.1,
      longitude: -83.98,
      sequence: 0,
    });
    const stopB = await ctx.db.insert("stops", {
      routeVersionId: versionId,
      label: "Maple Court",
      latitude: 34.11,
      longitude: -83.98,
      sequence: 1,
    });

    const otherRouteId = await ctx.db.insert("routes", { label: "Route 4 Afternoon", direction: "from_school", createdAtMs: now });
    const otherVersionId = await ctx.db.insert("routeVersions", {
      label: "Route 4 Afternoon",
      path: [
        { latitude: 34.2, longitude: -83.9 },
        { latitude: 34.21, longitude: -83.9 },
      ],
      routeId: otherRouteId,
      versionNumber: 1,
    });
    await ctx.db.patch(otherRouteId, { currentVersionId: otherVersionId });
    const otherStop = await ctx.db.insert("stops", {
      routeVersionId: otherVersionId,
      label: "Birch Row",
      latitude: 34.2,
      longitude: -83.9,
      sequence: 0,
    });

    // An already-enrolled fictional student whose guardian will link.
    const studentId = await ctx.db.insert("students", { displayName: "Sam Example" });
    const assignmentId = await ctx.db.insert("assignments", {
      studentId,
      routeVersionId: versionId,
      stopId: stopA,
      status: "approved",
    });

    const base = { issuedByUserId: staffId, issuedAtMs: now - HOUR, revoked: false };
    await ctx.db.insert("scopedTokens", {
      ...base,
      tokenHash: hashes.route,
      purpose: "route_enrollment",
      routeId,
      expiresAtMs: now + 24 * HOUR,
      singleUse: false,
    });
    await ctx.db.insert("scopedTokens", {
      ...base,
      tokenHash: hashes.expired,
      purpose: "route_enrollment",
      routeId,
      expiresAtMs: now - 1,
      singleUse: false,
    });
    await ctx.db.insert("scopedTokens", {
      ...base,
      tokenHash: hashes.revoked,
      purpose: "route_enrollment",
      routeId,
      expiresAtMs: now + 24 * HOUR,
      singleUse: false,
      revoked: true,
    });
    await ctx.db.insert("scopedTokens", {
      ...base,
      tokenHash: hashes.guardian,
      purpose: "guardian_link",
      studentId,
      expiresAtMs: now + 24 * HOUR,
      singleUse: true,
    });
    await ctx.db.insert("scopedTokens", {
      ...base,
      tokenHash: hashes.checkin,
      purpose: "trip_check_in",
      expiresAtMs: now + HOUR,
      singleUse: false,
    });
    return { staffId, routeId, versionId, stopA, stopB, otherRouteId, otherStop, studentId, assignmentId };
  });
  return { t, ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const as = (t: T, who: string) => t.withIdentity({ tokenIdentifier: who });

function requestArgs(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "c7d0b1a2-0000-4000-8000-000000000001",
    token: ROUTE_TOKEN,
    studentName: "Alex Fictional",
    address: ADDRESS,
    stopId: null as string | null,
    note: null as string | null,
    ...overrides,
  };
}

describe("enrollment invitation preview", () => {
  it("shows the route and its approved stops, and nothing else", async () => {
    const { t, stopA, stopB } = await setup();
    const result = await as(t, APPLICANT).query(api.enrollment.previewInvitation, { token: ROUTE_TOKEN });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "ready",
      serverNowMs: expect.any(Number),
      routeLabel: "Route 17 Morning",
      direction: "to_school",
      expiresAtMs: expect.any(Number),
      stops: [
        { stopId: stopA, label: "Oak & Pine", sequence: 0, instructions: null },
        { stopId: stopB, label: "Maple Court", sequence: 1, instructions: null },
      ],
    });
  });

  it("accepts the code without dashes and in lower case", async () => {
    const { t } = await setup();
    const result = await as(t, APPLICANT).query(api.enrollment.previewInvitation, {
      token: ROUTE_TOKEN.replace(/-/g, "").toLowerCase(),
    });
    expect(result.status).toBe("ready");
  });

  it.each([
    ["expired", EXPIRED_TOKEN, "expired"],
    ["revoked", REVOKED_TOKEN, "invalid"],
    ["unknown", "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", "invalid"],
    ["malformed", "not a token", "invalid"],
    ["guardian invitation", GUARDIAN_TOKEN, "wrong_purpose"],
    ["check-in challenge", CHECKIN_TOKEN, "wrong_purpose"],
  ])("rejects a %s token", async (_name, token, problem) => {
    const { t } = await setup();
    expect(await as(t, APPLICANT).query(api.enrollment.previewInvitation, { token })).toMatchObject({
      status: "token_problem",
      problem,
    });
  });

  it("needs a sign-in", async () => {
    const { t } = await setup();
    expect(await t.query(api.enrollment.previewInvitation, { token: ROUTE_TOKEN })).toMatchObject({
      status: "access_unavailable",
      reason: "unauthenticated",
    });
  });
});

describe("enrollment:request", () => {
  it("records a pending request that grants no tracking", async () => {
    const { t, stopA } = await setup();
    const result = await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    expect(result).toMatchObject({ status: "submitted", requestStatus: "pending" });

    // A pending applicant has no approved account, so tracking is unavailable.
    expect(await as(t, APPLICANT).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "access_unavailable",
    });
    const mine = await as(t, APPLICANT).query(api.enrollment.myRequests, {});
    expect(mine).toMatchObject({
      status: "ready",
      requests: [
        {
          routeLabel: "Route 17 Morning",
          studentName: "Alex Fictional",
          requestedStopLabel: "Oak & Pine",
          status: "pending",
          decidedAtMs: null,
          decisionReason: null,
        },
      ],
    });
    // The applicant's own view never echoes the private address.
    expect(JSON.stringify(mine)).not.toContain(ADDRESS);
  });

  it("a pending request by an existing family account adds no trackable assignment", async () => {
    const { t, stopA } = await setup();
    await as(t, FAMILY).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    expect(await as(t, FAMILY).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "ready",
      assignments: [],
    });
  });

  it("is idempotent for a retried requestId and refuses a changed one", async () => {
    const { t, stopA, stopB } = await setup();
    const first = await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    const retry = await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    expect(retry).toMatchObject({ status: "submitted" });
    expect((retry as { enrollmentRequestId: string }).enrollmentRequestId).toBe(
      (first as { enrollmentRequestId: string }).enrollmentRequestId,
    );
    const changed = await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: stopB }));
    expect(changed).toMatchObject({ status: "refused", code: "request_id_conflict" });
    const again = await as(t, APPLICANT).mutation(
      api.enrollment.request,
      requestArgs({ requestId: "c7d0b1a2-0000-4000-8000-000000000002", stopId: stopA }),
    );
    expect(again).toMatchObject({ status: "refused", code: "already_requested" });
    expect(await t.run((ctx) => ctx.db.query("enrollmentRequests").collect())).toHaveLength(1);
  });

  it("a requestId is scoped to its applicant", async () => {
    const { t, stopA } = await setup();
    await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    const other = await as(t, OTHER).mutation(api.enrollment.request, requestArgs({ stopId: stopA }));
    expect(other).toMatchObject({ status: "submitted" });
    expect(await t.run((ctx) => ctx.db.query("enrollmentRequests").collect())).toHaveLength(2);
  });

  it("rejects a stop from another route or a made-up stop ID", async () => {
    const { t, otherStop } = await setup();
    for (const stopId of [otherStop, "not-a-stop-id"]) {
      expect(await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId }))).toMatchObject({
        status: "refused",
        code: "stop_not_eligible",
      });
    }
    expect(await t.run((ctx) => ctx.db.query("enrollmentRequests").collect())).toHaveLength(0);
  });

  it("allows no stop, for manual review, without fabricating one", async () => {
    const { t } = await setup();
    await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ stopId: null }));
    const [row] = await t.run((ctx) => ctx.db.query("enrollmentRequests").collect());
    expect(row?.requestedStopId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("stops").collect())).toHaveLength(3);
  });

  it.each([
    ["expired", EXPIRED_TOKEN, "expired"],
    ["revoked", REVOKED_TOKEN, "invalid"],
    ["guardian invitation", GUARDIAN_TOKEN, "wrong_purpose"],
    ["check-in challenge", CHECKIN_TOKEN, "wrong_purpose"],
  ])("rejects a %s token and records nothing", async (_name, token, problem) => {
    const { t } = await setup();
    expect(await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs({ token }))).toMatchObject({
      status: "token_problem",
      problem,
    });
    expect(await t.run((ctx) => ctx.db.query("enrollmentRequests").collect())).toHaveLength(0);
  });

  it.each([
    ["empty name", { studentName: "  " }],
    ["long name", { studentName: "x".repeat(81) }],
    ["empty address", { address: "" }],
    ["long address", { address: "x".repeat(201) }],
    ["long note", { note: "x".repeat(301) }],
    ["bad requestId", { requestId: "" }],
  ])("refuses %s", async (_name, overrides) => {
    const { t } = await setup();
    expect(await as(t, APPLICANT).mutation(api.enrollment.request, requestArgs(overrides))).toMatchObject({
      status: "refused",
      code: "invalid_details",
    });
  });

  it("needs a sign-in", async () => {
    const { t } = await setup();
    expect(await t.mutation(api.enrollment.request, requestArgs())).toMatchObject({
      status: "access_unavailable",
      reason: "unauthenticated",
    });
  });
});

async function submitted(t: T, who = APPLICANT, stopId: string | null = null) {
  const r = await as(t, who).mutation(api.enrollment.request, requestArgs({ stopId }));
  return (r as { enrollmentRequestId: string }).enrollmentRequestId;
}

describe("staff approval", () => {
  it("approving creates the account link, student, and assignment, then tracking works", async () => {
    const { t, stopB } = await setup();
    const enrollmentRequestId = await submitted(t);
    const result = await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopB });
    expect(result).toMatchObject({ status: "approved", assignmentId: expect.any(String), guardianLinkId: null });

    const access = await as(t, APPLICANT).query(api.tracking.myAssignments, {});
    expect(access).toMatchObject({
      status: "ready",
      assignments: [{ relationship: "self", studentDisplayName: "Alex Fictional", stopLabel: "Maple Court" }],
    });
    const user = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_token", (q) => q.eq("tokenIdentifier", APPLICANT))
        .unique(),
    );
    expect(user?.role).toBe("family");
    const mine = await as(t, APPLICANT).query(api.enrollment.myRequests, {});
    expect(mine).toMatchObject({ requests: [{ status: "approved", decidedAtMs: expect.any(Number) }] });
  });

  it("refuses a stop that is not in the route's current version", async () => {
    const { t, otherStop } = await setup();
    const enrollmentRequestId = await submitted(t);
    expect(
      await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: otherStop }),
    ).toMatchObject({ status: "refused", code: "stop_not_eligible" });
    expect(await t.run((ctx) => ctx.db.query("assignments").collect())).toHaveLength(1);
  });

  it("refuses to decide twice", async () => {
    const { t, stopA } = await setup();
    const enrollmentRequestId = await submitted(t);
    await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopA });
    expect(await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopA })).toMatchObject({
      status: "refused",
      code: "already_decided",
    });
    expect(
      await as(t, STAFF).mutation(api.enrollment.reject, { enrollmentRequestId, reason: "Late change" }),
    ).toMatchObject({ status: "refused", code: "already_decided" });
    expect(await t.run((ctx) => ctx.db.query("assignments").collect())).toHaveLength(2);
  });

  it("reuses the student record for a second route", async () => {
    const { t, stopA, otherRouteId, otherStop, staffId } = await setup();
    const first = await submitted(t);
    await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId: first, stopId: stopA });
    const otherToken = "3333-4444-5555-6666-7777";
    const otherHash = await hash(otherToken);
    await t.run(async (ctx) => {
      await ctx.db.insert("scopedTokens", {
        tokenHash: otherHash,
        purpose: "route_enrollment",
        routeId: otherRouteId,
        issuedByUserId: staffId,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + HOUR,
        revoked: false,
        singleUse: false,
      });
    });
    const r = await as(t, APPLICANT).mutation(
      api.enrollment.request,
      requestArgs({ requestId: "c7d0b1a2-0000-4000-8000-000000000009", token: otherToken, stopId: otherStop }),
    );
    const second = (r as { enrollmentRequestId: string }).enrollmentRequestId;
    await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId: second, stopId: otherStop });
    const students = await t.run((ctx) => ctx.db.query("students").collect());
    expect(students.filter((s) => s.displayName === "Alex Fictional")).toHaveLength(1);
    const access = await as(t, APPLICANT).query(api.tracking.myAssignments, {});
    expect((access as { assignments: unknown[] }).assignments).toHaveLength(2);
  });

  it("refuses when the applicant's sign-in is a staff or driver account", async () => {
    const { t, stopA } = await setup();
    const enrollmentRequestId = await submitted(t, DRIVER, stopA);
    expect(await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopA })).toMatchObject({
      status: "refused",
      code: "account_conflict",
    });
  });

  it("rejection needs a reason, is shown to the applicant, and grants nothing", async () => {
    const { t } = await setup();
    const enrollmentRequestId = await submitted(t);
    expect(await as(t, STAFF).mutation(api.enrollment.reject, { enrollmentRequestId, reason: " " })).toMatchObject({
      status: "refused",
      code: "reason_required",
    });
    expect(
      await as(t, STAFF).mutation(api.enrollment.reject, { enrollmentRequestId, reason: "Outside the service area" }),
    ).toMatchObject({ status: "rejected" });
    expect(await as(t, APPLICANT).query(api.enrollment.myRequests, {})).toMatchObject({
      requests: [{ status: "rejected", decisionReason: "Outside the service area" }],
    });
    expect(await as(t, APPLICANT).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "access_unavailable",
    });
  });

  it("staff review shows the private address; the audit log never holds it or a token", async () => {
    const { t, stopA } = await setup();
    const enrollmentRequestId = await submitted(t, APPLICANT, stopA);
    const review = await as(t, STAFF).query(api.enrollment.listRequests, {});
    expect(review).toMatchObject({
      status: "ready",
      requests: [{ enrollmentRequestId, address: ADDRESS, requestedStopId: stopA, status: "pending" }],
    });
    await as(t, STAFF).mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopA });
    const rows = JSON.stringify(await t.run((ctx) => ctx.db.query("auditLog").collect()));
    expect(rows).toContain("enrollment.approve");
    expect(rows).toContain("enrollment.request");
    expect(rows).not.toContain(ADDRESS);
    expect(rows).not.toContain(normalizeToken(ROUTE_TOKEN));
  });
});

describe("guardian linking", () => {
  const linkArgs = (overrides: Record<string, unknown> = {}) => ({
    requestId: "a1b2c3d4-0000-4000-8000-000000000001",
    token: GUARDIAN_TOKEN,
    guardianName: "Jordan Guardian",
    ...overrides,
  });

  it("a pending link reveals nothing and grants nothing; approval links only that student", async () => {
    const { t } = await setup();
    const r = await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs());
    expect(r).toMatchObject({ status: "submitted", requestStatus: "pending" });
    const pending = await as(t, GUARDIAN).query(api.guardianLinks.myRequests, {});
    expect(pending).toMatchObject({ requests: [{ status: "pending", studentDisplayName: null }] });
    expect(JSON.stringify(pending)).not.toContain("Sam Example");
    expect(await as(t, GUARDIAN).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "access_unavailable",
    });

    const linkRequestId = (r as { linkRequestId: string }).linkRequestId;
    expect(await as(t, STAFF).mutation(api.guardianLinks.approve, { linkRequestId })).toMatchObject({
      status: "approved",
      guardianLinkId: expect.any(String),
    });
    expect(await as(t, GUARDIAN).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "ready",
      assignments: [{ relationship: "guardian", studentDisplayName: "Sam Example" }],
    });
    expect(await as(t, GUARDIAN).query(api.guardianLinks.myRequests, {})).toMatchObject({
      requests: [{ status: "approved", studentDisplayName: "Sam Example" }],
    });
  });

  it("the invitation is single use: a second account cannot reuse it", async () => {
    const { t } = await setup();
    await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs());
    // The same person retrying gets the same request back.
    expect(await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs())).toMatchObject({
      status: "submitted",
    });
    expect(await as(t, OTHER).mutation(api.guardianLinks.request, linkArgs())).toMatchObject({
      status: "token_problem",
      problem: "already_used",
    });
    expect(await t.run((ctx) => ctx.db.query("guardianLinkRequests").collect())).toHaveLength(1);
  });

  it.each([
    ["enrollment invitation", ROUTE_TOKEN, "wrong_purpose"],
    ["check-in challenge", CHECKIN_TOKEN, "wrong_purpose"],
    ["student's name instead of a code", "Sam Example", "invalid"],
  ])("rejects a %s", async (_name, token, problem) => {
    const { t } = await setup();
    expect(await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs({ token }))).toMatchObject({
      status: "token_problem",
      problem,
    });
    expect(await t.run((ctx) => ctx.db.query("guardianLinkRequests").collect())).toHaveLength(0);
  });

  it("rejects an expired guardian invitation", async () => {
    const { t, studentId, staffId } = await setup();
    const token = "8888-9999-AAAA-BBBB-CCCC";
    const tokenHash = await hash(token);
    await t.run(async (ctx) => {
      await ctx.db.insert("scopedTokens", {
        tokenHash,
        purpose: "guardian_link",
        studentId,
        issuedByUserId: staffId,
        issuedAtMs: Date.now() - 2 * HOUR,
        expiresAtMs: Date.now() - HOUR,
        revoked: false,
        singleUse: true,
      });
    });
    expect(await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs({ token }))).toMatchObject({
      status: "token_problem",
      problem: "expired",
    });
  });

  it("revocation stops tracking at once and keeps history", async () => {
    const { t } = await setup();
    const r = await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs());
    const linkRequestId = (r as { linkRequestId: string }).linkRequestId;
    const approved = await as(t, STAFF).mutation(api.guardianLinks.approve, { linkRequestId });
    const guardianLinkId = (approved as { guardianLinkId: string }).guardianLinkId;
    expect(await as(t, STAFF).mutation(api.guardianLinks.revoke, { guardianLinkId, reason: "" })).toMatchObject({
      status: "refused",
      code: "reason_required",
    });
    expect(
      await as(t, STAFF).mutation(api.guardianLinks.revoke, { guardianLinkId, reason: "Linked in error" }),
    ).toMatchObject({ status: "revoked" });
    expect(await as(t, GUARDIAN).query(api.tracking.myAssignments, {})).toMatchObject({
      status: "ready",
      assignments: [],
    });
    const link = await t.run((ctx) => ctx.db.get(guardianLinkId as Id<"guardianLinks">));
    expect(link).toMatchObject({ status: "revoked", revokeReason: "Linked in error" });
  });

  it("rejecting a link request grants nothing", async () => {
    const { t } = await setup();
    const r = await as(t, GUARDIAN).mutation(api.guardianLinks.request, linkArgs());
    const linkRequestId = (r as { linkRequestId: string }).linkRequestId;
    expect(
      await as(t, STAFF).mutation(api.guardianLinks.reject, { linkRequestId, reason: "Not on school records" }),
    ).toMatchObject({ status: "rejected" });
    expect(await t.run((ctx) => ctx.db.query("guardianLinks").collect())).toHaveLength(0);
  });
});

describe("staff-issued invitations", () => {
  it("staff can create an enrollment invitation that previews as valid", async () => {
    const { t, routeId } = await setup();
    const created = await as(t, STAFF).action(api.enrollment.createRouteInvitation, { routeId, ttlMs: 24 * HOUR });
    expect(created).toMatchObject({ status: "created", token: expect.any(String) });
    const token = (created as { token: string }).token;
    expect(normalizeToken(token)).not.toBeNull();
    expect(await as(t, APPLICANT).query(api.enrollment.previewInvitation, { token })).toMatchObject({
      status: "ready",
    });
    // Only the hash is stored.
    const rows = JSON.stringify(await t.run((ctx) => ctx.db.query("scopedTokens").collect()));
    expect(rows).not.toContain(normalizeToken(token));
  });

  it("refuses an out-of-range lifetime", async () => {
    const { t, routeId } = await setup();
    for (const ttlMs of [0, 60 * 1000, 31 * 24 * HOUR]) {
      expect(await as(t, STAFF).action(api.enrollment.createRouteInvitation, { routeId, ttlMs })).toMatchObject({
        status: "refused",
        code: "invalid_ttl",
      });
    }
  });

  it("revoking an invitation makes it invalid", async () => {
    const { t, routeId } = await setup();
    const created = await as(t, STAFF).action(api.enrollment.createRouteInvitation, { routeId, ttlMs: 24 * HOUR });
    const { token, invitationId } = created as { token: string; invitationId: string };
    expect(await as(t, STAFF).mutation(api.enrollment.revokeInvitation, { invitationId })).toMatchObject({
      status: "revoked",
    });
    expect(await as(t, APPLICANT).query(api.enrollment.previewInvitation, { token })).toMatchObject({
      status: "token_problem",
      problem: "invalid",
    });
  });

  it("staff can create a guardian invitation for one student", async () => {
    const { t, studentId } = await setup();
    const created = await as(t, STAFF).action(api.guardianLinks.createInvitation, { studentId, ttlMs: 24 * HOUR });
    expect(created).toMatchObject({ status: "created" });
    const listed = await as(t, STAFF).query(api.enrollment.listInvitations, {});
    expect(listed).toMatchObject({ status: "ready" });
    expect(JSON.stringify(listed)).not.toContain(normalizeToken((created as { token: string }).token));
  });
});

type Ids = Omit<Awaited<ReturnType<typeof setup>>, "t">;

/** Every staff-only enrollment function, with arguments that would succeed for staff. */
const STAFF_CALLS: [string, (t: T, ids: Ids) => Promise<unknown>][] = [
  ["enrollment.createRouteInvitation", (t, { routeId }) => t.action(api.enrollment.createRouteInvitation, { routeId, ttlMs: 24 * HOUR })],
  ["enrollment.listInvitations", (t) => t.query(api.enrollment.listInvitations, {})],
  ["enrollment.listRequests", (t) => t.query(api.enrollment.listRequests, {})],
  ["guardianLinks.createInvitation", (t, { studentId }) => t.action(api.guardianLinks.createInvitation, { studentId, ttlMs: 24 * HOUR })],
  ["guardianLinks.listRequests", (t) => t.query(api.guardianLinks.listRequests, {})],
  ["students.list", (t) => t.query(api.students.list, {})],
  ["audit.list", (t) => t.query(api.audit.list, {})],
];

describe("access denial on every staff enrollment function", () => {
  for (const [name, call] of STAFF_CALLS) {
    for (const who of [null, DRIVER, FAMILY, APPLICANT]) {
      it(`${name}: ${who ?? "signed out"} is denied and changes nothing`, async () => {
        const { t, ...ids } = await setup();
        const before = await t.run(async (ctx) => (await ctx.db.query("scopedTokens").collect()).length);
        const result = await call(who ? (as(t, who) as unknown as T) : t, ids);
        expect(result).toMatchObject({
          status: "access_unavailable",
          reason: who === null || who === APPLICANT ? "unauthenticated" : "not_permitted",
        });
        expect(await t.run(async (ctx) => (await ctx.db.query("scopedTokens").collect()).length)).toBe(before);
      });
    }
  }

  it("decision mutations deny non-staff and leave the request pending", async () => {
    const { t, stopA, studentId, assignmentId } = await setup();
    const enrollmentRequestId = await submitted(t, APPLICANT, stopA);
    const link = await as(t, GUARDIAN).mutation(api.guardianLinks.request, {
      requestId: "a1b2c3d4-0000-4000-8000-000000000001",
      token: GUARDIAN_TOKEN,
      guardianName: "Jordan Guardian",
    });
    const linkRequestId = (link as { linkRequestId: string }).linkRequestId;
    const existingLink = await t.run(async (ctx) => {
      const guardian = await ctx.db.insert("users", { tokenIdentifier: "test|g2", role: "family", displayName: "G Two" });
      return await ctx.db.insert("guardianLinks", { guardianUserId: guardian, studentId, status: "approved" });
    });
    for (const who of [DRIVER, FAMILY, APPLICANT, GUARDIAN]) {
      const caller = as(t, who);
      for (const result of [
        await caller.mutation(api.enrollment.approve, { enrollmentRequestId, stopId: stopA }),
        await caller.mutation(api.enrollment.reject, { enrollmentRequestId, reason: "x" }),
        await caller.mutation(api.guardianLinks.approve, { linkRequestId }),
        await caller.mutation(api.guardianLinks.reject, { linkRequestId, reason: "x" }),
        await caller.mutation(api.guardianLinks.revoke, { guardianLinkId: existingLink, reason: "x" }),
        await caller.mutation(api.enrollment.revokeInvitation, { invitationId: "x" }),
      ]) {
        expect(result).toMatchObject({ status: "access_unavailable" });
      }
    }
    const state = await t.run(async (ctx) => ({
      requests: await ctx.db.query("enrollmentRequests").collect(),
      links: await ctx.db.query("guardianLinkRequests").collect(),
      link: await ctx.db.get(existingLink),
      assignment: await ctx.db.get(assignmentId),
    }));
    expect(state.requests.map((r) => r.status)).toEqual(["pending"]);
    expect(state.links.map((r) => r.status)).toEqual(["pending"]);
    expect(state.link?.status).toBe("approved");
    // A denied signed-in attempt is audited.
    const denials = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(denials.some((r) => r.action === "enrollment.approve" && r.result === "denied")).toBe(true);
  });
});
