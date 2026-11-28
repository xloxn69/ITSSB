import { localDate } from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import { MAX_GRANT_TTL_MS } from "./driverGrants";
import schema from "./schema";

/**
 * Staff operations that used to need the command line (docs/12 §1, §3):
 * add a driver, issue / list / revoke driver operating grants, invite and
 * admit another staff member, and bootstrap the very first staff account.
 * Fictional people and places only.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const DRIVER_LOGIN = "test|driver";
const FAMILY = "test|family";
const NEWCOMER = "test|newcomer";
const DEVICE_SECRET = "d".repeat(64);
const TZ = "America/New_York";
const HOUR = 60 * 60 * 1000;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    await ctx.db.insert("users", { tokenIdentifier: DRIVER_LOGIN, role: "driver", displayName: "Signed-in Driver" });
    const familyId = await ctx.db.insert("users", { tokenIdentifier: FAMILY, role: "family", displayName: "Pat Parent" });
    const driverId = await ctx.db.insert("users", { tokenIdentifier: "unlinked:dana", role: "driver", displayName: "Dana Driver" });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi", credentialHash: await sha256Hex(DEVICE_SECRET), revoked: false });
    const revokedDeviceId = await ctx.db.insert("devices", { label: "Old Pi", credentialHash: "x", revoked: true });
    // An approved route with a current version, and the version it superseded.
    const routeId = await ctx.db.insert("routes", { label: "Route 17 Morning", direction: "to_school", createdAtMs: Date.now() });
    const oldVersionId = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [], routeId, versionNumber: 1 });
    const versionId = await ctx.db.insert("routeVersions", { label: "Route 17 Morning", path: [], routeId, versionNumber: 2 });
    await ctx.db.patch(routeId, { currentVersionId: versionId });
    // A route nobody has approved a version for yet.
    const unapprovedRouteId = await ctx.db.insert("routes", { label: "Route 9", direction: "to_school", createdAtMs: Date.now() });
    const unapprovedVersionId = await ctx.db.insert("routeVersions", { label: "Route 9", path: [], routeId: unapprovedRouteId });
    return { staffId, familyId, driverId, deviceId, revokedDeviceId, versionId, oldVersionId, unapprovedVersionId };
  });
  return { t, staff: t.withIdentity({ tokenIdentifier: STAFF }), ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];
const as = (t: T, tokenIdentifier: string) => t.withIdentity({ tokenIdentifier });
const auditRows = (t: T) => t.run((ctx) => ctx.db.query("auditLog").collect());
const NON_STAFF = [DRIVER_LOGIN, FAMILY, NEWCOMER];

async function postStart(t: T, grant: string, routeVersionId: string, requestId: string) {
  const capturedAtMs = Date.now() - 1000;
  const res = await t.fetch("/device/v1/trip-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_SECRET}` },
    body: JSON.stringify({
      schemaVersion: 1,
      requestId,
      type: "startRun",
      driverOperatingGrant: grant,
      routeVersionId,
      serviceDate: localDate(capturedAtMs, TZ),
      serviceTimezone: TZ,
      capturedAtMs,
    }),
  });
  return { status: res.status, body: (await res.json()) as { status?: string; runId?: string; error?: { code: string } } };
}

// MARK: Add a driver

describe("fleet.addDriver", () => {
  it("creates an unlinked driver person, listed with the drivers, and audits it", async () => {
    const { t, staff, staffId } = await setup();
    const r = await staff.mutation(api.fleet.addDriver, { displayName: "  Morgan Driver  " });
    if (r.status !== "created") throw new Error(`expected created, got ${r.status}`);
    const row = await t.run((ctx) => ctx.db.get(r.userId as Id<"users">));
    expect(row).toMatchObject({ role: "driver", displayName: "Morgan Driver", tokenIdentifier: `unlinked:${r.userId}` });
    // A second driver gets its own placeholder, so by_token lookups stay unique.
    const r2 = await staff.mutation(api.fleet.addDriver, { displayName: "Morgan Driver" });
    if (r2.status !== "created") throw new Error("expected created");
    expect(r2.userId).not.toBe(r.userId);
    const list = await staff.query(api.fleet.listDrivers, {});
    expect(list.status === "ready" && list.drivers.map((d) => d.userId)).toContain(r.userId);
    expect((await auditRows(t)).filter((a) => a.action === "driver.add")[0]).toMatchObject({
      actor: { kind: "user", userId: staffId },
      resourceId: r.userId,
      result: "allowed",
    });
  });

  it("refuses an empty or too long name", async () => {
    const { staff } = await setup();
    expect(await staff.mutation(api.fleet.addDriver, { displayName: "  " })).toMatchObject({ status: "refused", code: "invalid_name" });
    expect(await staff.mutation(api.fleet.addDriver, { displayName: "x".repeat(81) })).toMatchObject({ status: "refused", code: "invalid_name" });
  });

  it("denies signed-out and non-staff callers and writes nothing", async () => {
    const { t } = await setup();
    const before = (await t.run((ctx) => ctx.db.query("users").collect())).length;
    expect(await t.mutation(api.fleet.addDriver, { displayName: "Eve" })).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
    for (const who of NON_STAFF) {
      expect(await as(t, who).mutation(api.fleet.addDriver, { displayName: "Eve" })).toMatchObject({ status: "access_unavailable" });
    }
    expect((await t.run((ctx) => ctx.db.query("users").collect())).length).toBe(before);
  });
});

// MARK: Driver grants

describe("driverGrants.issueForDriver", () => {
  it("issues a grant once that starts a real run, and stops working after revoke", async () => {
    const { t, staff, staffId, driverId, deviceId, versionId } = await setup();
    const r = await staff.action(api.driverGrants.issueForDriver, {
      driverUserId: driverId,
      deviceId,
      routeVersionIds: [versionId],
      ttlMs: 8 * HOUR,
    });
    if (r.status !== "issued") throw new Error(`expected issued, got ${r.status}`);
    expect(r.grant).toMatch(/^[0-9a-f]{64}$/);
    expect(r.expiresAtMs).toBeGreaterThan(Date.now() + 7 * HOUR);
    expect(r).toMatchObject({ driverUserId: driverId, driverName: "Dana Driver", deviceId, routeVersions: [{ routeVersionId: versionId, label: "Route 17 Morning" }] });

    const stored = await t.run((ctx) => ctx.db.get(r.grantId as Id<"driverGrants">));
    expect(stored).toMatchObject({ tokenHash: await sha256Hex(r.grant), issuedByUserId: staffId, revoked: false });
    expect(JSON.stringify(await auditRows(t))).not.toContain(r.grant);

    // Listed without its secret or hash.
    const list = await staff.query(api.driverGrants.listForStaff, {});
    if (list.status !== "ready") throw new Error("expected ready");
    expect(list.grants).toEqual([
      expect.objectContaining({ grantId: r.grantId, driverUserId: driverId, deviceLabel: "Bench Pi", issuedByName: "Riley Staff" }),
    ]);
    expect(JSON.stringify(list)).not.toContain(r.grant);
    expect(JSON.stringify(list)).not.toContain(stored!.tokenHash);
    expect(list.routeVersions.map((x) => x.routeVersionId)).toEqual([versionId]);

    const started = await postStart(t, r.grant, versionId, "0b6f3a8e-1c2d-4e5f-8a9b-000000000001");
    expect(started).toMatchObject({ status: 200, body: { status: "accepted" } });

    // End that run so the bus is free, then revoke: a new start is refused for the grant.
    const ended = await t.fetch("/device/v1/trip-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_SECRET}` },
      body: JSON.stringify({
        schemaVersion: 1,
        requestId: "0b6f3a8e-1c2d-4e5f-8a9b-000000000002",
        type: "endRun",
        driverOperatingGrant: r.grant,
        runId: started.body.runId,
        capturedAtMs: Date.now() - 500,
        lastRunSequence: null,
      }),
    });
    expect(ended.status).toBe(200);

    expect(await staff.mutation(api.driverGrants.revokeForStaff, { grantId: r.grantId })).toMatchObject({ status: "ok" });
    const after = await postStart(t, r.grant, versionId, "0b6f3a8e-1c2d-4e5f-8a9b-000000000003");
    expect(after).toMatchObject({ status: 403, body: { error: { code: "GRANT_NOT_AUTHORIZED" } } });
    // Gone from the active list; revoking again is a no-op with no second audit row.
    const listed = await staff.query(api.driverGrants.listForStaff, {});
    expect(listed.status === "ready" && listed.grants).toEqual([]);
    expect(await staff.mutation(api.driverGrants.revokeForStaff, { grantId: r.grantId })).toMatchObject({ status: "ok" });
    const revokes = (await auditRows(t)).filter((a) => a.action === "driverGrants.revoke");
    expect(revokes).toEqual([expect.objectContaining({ actor: { kind: "user", userId: staffId }, resourceId: r.grantId, result: "allowed" })]);
  });

  it.each([
    ["an unknown driver", (ids: Ids) => ({ driverUserId: ids.familyId }), "driver_not_found"],
    ["a malformed driver ID", () => ({ driverUserId: "nope" }), "driver_not_found"],
    ["a revoked device", (ids: Ids) => ({ deviceId: ids.revokedDeviceId }), "device_unavailable"],
    ["a superseded route version", (ids: Ids) => ({ routeVersionIds: [ids.oldVersionId] }), "route_version_unavailable"],
    ["a never approved route version", (ids: Ids) => ({ routeVersionIds: [ids.unapprovedVersionId] }), "route_version_unavailable"],
    ["another table's ID as a route version", (ids: Ids) => ({ routeVersionIds: [ids.deviceId] }), "route_version_unavailable"],
    ["no route versions", () => ({ routeVersionIds: [] }), "route_version_unavailable"],
    ["a TTL over the cap", () => ({ ttlMs: MAX_GRANT_TTL_MS + 1 }), "invalid_ttl"],
    ["a zero TTL", () => ({ ttlMs: 0 }), "invalid_ttl"],
  ])("refuses %s, writes no grant, and audits the refusal", async (_name, override, code) => {
    const s = await setup();
    const args = { driverUserId: s.driverId as string, deviceId: s.deviceId as string, routeVersionIds: [s.versionId as string], ttlMs: 8 * HOUR, ...override(s) };
    const r = await s.staff.action(api.driverGrants.issueForDriver, args);
    expect(r).toMatchObject({ status: "refused", code });
    expect(r).not.toHaveProperty("grant");
    expect(await s.t.run((ctx) => ctx.db.query("driverGrants").collect())).toEqual([]);
    expect(await auditRows(s.t)).toEqual([expect.objectContaining({ action: "driverGrants.issue", result: "denied" })]);
  });

  it("denies signed-out and non-staff callers for every grant function", async () => {
    const { t, driverId, deviceId, versionId } = await setup();
    const grantId = await t.run((ctx) =>
      ctx.db.insert("driverGrants", { tokenHash: "h", deviceId, driverUserId: driverId, routeVersionIds: [versionId], issuedAtMs: Date.now(), expiresAtMs: Date.now() + HOUR, revoked: false }),
    );
    const issueArgs = { driverUserId: driverId, deviceId, routeVersionIds: [versionId], ttlMs: HOUR };
    for (const caller of [t, ...NON_STAFF.map((w) => as(t, w))]) {
      expect(await caller.action(api.driverGrants.issueForDriver, issueArgs)).toMatchObject({ status: "access_unavailable" });
      expect(await caller.query(api.driverGrants.listForStaff, {})).toMatchObject({ status: "access_unavailable" });
      expect(await caller.mutation(api.driverGrants.revokeForStaff, { grantId })).toMatchObject({ status: "access_unavailable" });
    }
    const grants = await t.run((ctx) => ctx.db.query("driverGrants").collect());
    expect(grants).toEqual([expect.objectContaining({ _id: grantId, revoked: false })]);
  });

  it("lists a legacy route version (before route review) as grantable", async () => {
    const { t, staff, versionId } = await setup();
    const legacy = await t.run((ctx) => ctx.db.insert("routeVersions", { label: "Demo route", path: [] }));
    const list = await staff.query(api.driverGrants.listForStaff, {});
    expect(list.status === "ready" && list.routeVersions.map((x) => x.routeVersionId).toSorted()).toEqual([legacy, versionId].toSorted());
  });
});

type Ids = Awaited<ReturnType<typeof setup>>;

// MARK: Staff invitations

async function invite(s: Ids, ttlMs = 2 * 24 * HOUR) {
  const r = await s.staff.action(api.staffInvitations.create, { displayName: "Jamie Staff", ttlMs });
  if (r.status !== "created") throw new Error(`expected created, got ${r.status}`);
  return r;
}

const usersFor = (t: T, tokenIdentifier: string) =>
  t.run((ctx) => ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier)).collect());

describe("staffInvitations", () => {
  it("admits a new signed-in identity once as staff, audited, and a retry answers the same", async () => {
    const s = await setup();
    const { token, invitationId } = await invite(s);
    const stored = await s.t.run((ctx) => ctx.db.get(invitationId as Id<"scopedTokens">));
    expect(stored).toMatchObject({ purpose: "staff_invitation", singleUse: true, displayName: "Jamie Staff" });
    expect(JSON.stringify(stored)).not.toContain(token);

    const r = await as(s.t, NEWCOMER).mutation(api.staffInvitations.redeem, { token: token.toLowerCase() });
    expect(r).toMatchObject({ status: "joined", displayName: "Jamie Staff" });
    expect(await usersFor(s.t, NEWCOMER)).toEqual([expect.objectContaining({ role: "staff", displayName: "Jamie Staff" })]);
    // The new account is staff on the server.
    expect(await as(s.t, NEWCOMER).query(api.fleet.listDrivers, {})).toMatchObject({ status: "ready" });

    // Idempotent retry: same answer, still one account.
    expect(await as(s.t, NEWCOMER).mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "joined" });
    expect(await usersFor(s.t, NEWCOMER)).toHaveLength(1);

    const audit = await auditRows(s.t);
    expect(audit.filter((a) => a.action === "staffInvitation.create")).toEqual([expect.objectContaining({ actor: { kind: "user", userId: s.staffId }, resourceId: invitationId, result: "allowed" })]);
    expect(audit.filter((a) => a.action === "staffInvitation.redeem")).toEqual([
      expect.objectContaining({ actor: { kind: "identity", tokenIdentifier: NEWCOMER }, resourceType: "users", result: "allowed" }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(token);

    const list = await s.staff.query(api.staffInvitations.list, {});
    expect(list.status === "ready" && list.invitations[0]).toMatchObject({ invitationId, displayName: "Jamie Staff", issuedByName: "Riley Staff", usedAtMs: expect.any(Number) });
  });

  it("is single use: a second identity is refused", async () => {
    const s = await setup();
    const { token } = await invite(s);
    await as(s.t, NEWCOMER).mutation(api.staffInvitations.redeem, { token });
    const other = "test|someone-else";
    expect(await as(s.t, other).mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "refused", code: "invalid_code" });
    expect(await usersFor(s.t, other)).toEqual([]);
  });

  it("refuses expired, revoked, unknown, malformed and wrong-purpose codes with one identical answer", async () => {
    const s = await setup();
    const expired = await invite(s);
    await s.t.run((ctx) => ctx.db.patch(expired.invitationId as Id<"scopedTokens">, { expiresAtMs: Date.now() - 1 }));
    const revoked = await invite(s);
    expect(await s.staff.mutation(api.staffInvitations.revoke, { invitationId: revoked.invitationId })).toMatchObject({ status: "ok" });
    const studentId = await s.t.run((ctx) => ctx.db.insert("students", { displayName: "Sam Example" }));
    const guardian = await s.staff.action(api.guardianLinks.createInvitation, { studentId, ttlMs: 2 * HOUR });
    if (guardian.status !== "created") throw new Error("expected a guardian invitation");

    const answers = [];
    for (const token of [expired.token, revoked.token, "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", "not a code", guardian.token]) {
      const r = await as(s.t, NEWCOMER).mutation(api.staffInvitations.redeem, { token });
      const { serverNowMs: _t, ...rest } = r as { serverNowMs: number };
      answers.push(rest);
    }
    expect(answers[0]).toMatchObject({ status: "refused", code: "invalid_code" });
    for (const a of answers) expect(a).toEqual(answers[0]);
    expect(await usersFor(s.t, NEWCOMER)).toEqual([]);
    // The guardian invitation was not consumed.
    const g = await s.t.run((ctx) => ctx.db.get(guardian.invitationId as Id<"scopedTokens">));
    expect(g?.usedAtMs).toBeUndefined();
    const denials = (await auditRows(s.t)).filter((a) => a.action === "staffInvitation.redeem");
    expect(denials).toHaveLength(5);
    expect(denials.every((a) => a.result === "denied")).toBe(true);
  });

  it("is never accepted as a guardian or enrollment code", async () => {
    const s = await setup();
    const { token } = await invite(s);
    const r = await as(s.t, NEWCOMER).mutation(api.guardianLinks.request, { requestId: "req-staff-code-0001", token, guardianName: "Pat" });
    expect(r).toMatchObject({ status: "token_problem", problem: "wrong_purpose" });
    expect(await as(s.t, NEWCOMER).query(api.enrollment.previewInvitation, { token })).toMatchObject({ status: "token_problem", problem: "wrong_purpose" });
  });

  it("refuses an identity already linked to an account, without consuming the code", async () => {
    const s = await setup();
    const { token, invitationId } = await invite(s);
    for (const who of [FAMILY, DRIVER_LOGIN, STAFF]) {
      expect(await as(s.t, who).mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "refused", code: "already_linked" });
    }
    const family = await s.t.run((ctx) => ctx.db.get(s.familyId));
    expect(family?.role).toBe("family");
    const row = await s.t.run((ctx) => ctx.db.get(invitationId as Id<"scopedTokens">));
    expect(row?.usedAtMs).toBeUndefined();
    // The code still works for a new person.
    expect(await as(s.t, NEWCOMER).mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "joined" });
  });

  it("requires a signed-in, verified identity", async () => {
    const s = await setup();
    const { token } = await invite(s);
    expect(await s.t.mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "access_unavailable", reason: "unauthenticated" });
    const unverified = s.t.withIdentity({ tokenIdentifier: NEWCOMER, emailVerified: false });
    expect(await unverified.mutation(api.staffInvitations.redeem, { token })).toMatchObject({ status: "refused", code: "identity_unverified" });
    expect(await usersFor(s.t, NEWCOMER)).toEqual([]);
  });

  it("refuses a bad name or lifetime", async () => {
    const s = await setup();
    expect(await s.staff.action(api.staffInvitations.create, { displayName: "", ttlMs: HOUR })).toMatchObject({ status: "refused", code: "invalid_name" });
    expect(await s.staff.action(api.staffInvitations.create, { displayName: "Jamie", ttlMs: 8 * 24 * HOUR })).toMatchObject({ status: "refused", code: "invalid_ttl" });
    expect(await s.staff.action(api.staffInvitations.create, { displayName: "Jamie", ttlMs: HOUR - 1 })).toMatchObject({ status: "refused", code: "invalid_ttl" });
  });

  it("only revokes staff invitations, and enrollment revoke can't touch them", async () => {
    const s = await setup();
    const { invitationId } = await invite(s);
    const studentId = await s.t.run((ctx) => ctx.db.insert("students", { displayName: "Sam Example" }));
    const guardian = await s.staff.action(api.guardianLinks.createInvitation, { studentId, ttlMs: 2 * HOUR });
    if (guardian.status !== "created") throw new Error("expected created");
    expect(await s.staff.mutation(api.staffInvitations.revoke, { invitationId: guardian.invitationId })).toMatchObject({ status: "refused", code: "not_found" });
    expect(await s.staff.mutation(api.enrollment.revokeInvitation, { invitationId })).toMatchObject({ status: "refused", code: "not_found" });
  });

  it("denies signed-out and non-staff callers for create, list and revoke", async () => {
    const s = await setup();
    const { invitationId } = await invite(s);
    for (const caller of [s.t, ...NON_STAFF.map((w) => as(s.t, w))]) {
      expect(await caller.action(api.staffInvitations.create, { displayName: "Eve", ttlMs: 2 * HOUR })).toMatchObject({ status: "access_unavailable" });
      expect(await caller.query(api.staffInvitations.list, {})).toMatchObject({ status: "access_unavailable" });
      expect(await caller.mutation(api.staffInvitations.revoke, { invitationId })).toMatchObject({ status: "access_unavailable" });
    }
    const rows = await s.t.run((ctx) => ctx.db.query("scopedTokens").collect());
    expect(rows).toEqual([expect.objectContaining({ _id: invitationId, revoked: false })]);
  });
});

// MARK: First staff account

describe("users.bootstrapStaff", () => {
  const ID = "https://example.invalid|user_fictional01";

  it("creates a linked staff account and audits it as a system action", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: ID, displayName: "Riley Staff" });
    expect(await t.run((ctx) => ctx.db.get(userId))).toMatchObject({ tokenIdentifier: ID, role: "staff", displayName: "Riley Staff" });
    expect(await t.withIdentity({ tokenIdentifier: ID }).query(api.fleet.listDrivers, {})).toMatchObject({ status: "ready" });
    expect(await auditRows(t)).toEqual([
      expect.objectContaining({ actor: { kind: "system" }, action: "users.bootstrapStaff", resourceId: userId, result: "allowed" }),
    ]);
  });

  it("refuses an identity already linked, never changing its role", async () => {
    const t = convexTest(schema, modules);
    const familyId = await t.run((ctx) => ctx.db.insert("users", { tokenIdentifier: ID, role: "family", displayName: "Pat" }));
    await expect(t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: ID, displayName: "Pat" })).rejects.toThrow(/IDENTITY_ALREADY_LINKED/);
    expect((await t.run((ctx) => ctx.db.get(familyId)))?.role).toBe("family");
    await expect(t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: "https://example.invalid|other01", displayName: "A" })).resolves.toBeTruthy();
    await expect(t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: "https://example.invalid|other01", displayName: "A" })).rejects.toThrow(/IDENTITY_ALREADY_LINKED/);
  });

  it.each(["unlinked:abc", "test|staff", "https://example.invalid", "https://a|b|c", ""])("refuses the malformed identifier %j", async (bad) => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: bad, displayName: "Riley" })).rejects.toThrow(/INVALID_TOKEN_IDENTIFIER/);
    expect(await auditRows(t)).toEqual([]);
  });

  it("refuses an empty name", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.users.bootstrapStaff, { tokenIdentifier: ID, displayName: " " })).rejects.toThrow(/INVALID_DISPLAY_NAME/);
  });
});
