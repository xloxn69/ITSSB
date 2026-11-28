import {
  localDate,
  MAX_ROUTE_DRAFT_BODY_BYTES,
  MAX_ROUTE_DRAFT_LABEL_LENGTH,
  MAX_ROUTE_DRAFT_STOPS,
  MAX_ROUTE_PATH_POINTS,
  type RouteDraftStatusResponse,
  type RouteDraftSubmission,
  type RouteDraftSubmitResult,
} from "@itssb/contracts";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import { approvedVersionForNewRun } from "./lib/routeVersions";
import schema from "./schema";

/**
 * `POST /device/v1/route-drafts` and `/status` (docs/08 §7.1): a driver's
 * recorded draft reaches staff review, is never approved automatically, and
 * once staff approve it a new run pins it (docs/15 §8).
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const GRANT_A = "g".repeat(64);
const GRANT_B = "h".repeat(64);
const HOUR = 60 * 60 * 1000;
const TZ = "America/New_York";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    const driver = await ctx.db.insert("users", { tokenIdentifier: "test|driver", role: "driver", displayName: "Dana" });
    const deviceA = await ctx.db.insert("devices", { label: "Pi A", credentialHash: await sha256Hex(SECRET_A), revoked: false });
    const deviceB = await ctx.db.insert("devices", { label: "Pi B", credentialHash: await sha256Hex(SECRET_B), revoked: false });
    // A grant always names at least one route version: the driver's existing route.
    const existing = await ctx.db.insert("routeVersions", { label: "Existing Route", path: [] });
    return { driver, deviceA, deviceB, existing };
  });
  for (const [grant, deviceId] of [
    [GRANT_A, ids.deviceA],
    [GRANT_B, ids.deviceB],
  ] as const) {
    await t.mutation(internal.driverGrants.insert, {
      tokenHash: await sha256Hex(grant),
      deviceId,
      driverUserId: ids.driver,
      routeVersionIds: [ids.existing],
      ttlMs: 8 * HOUR,
      nowMs: Date.now(),
    });
  }
  return { t, ...ids };
}
type T = Awaited<ReturnType<typeof setup>>["t"];

// Fixed per test file, so a retry built later carries the same recording.
const NOW = Date.now();

function submission(patch: Partial<RouteDraftSubmission> = {}): RouteDraftSubmission {
  const now = NOW;
  const start = now - 30 * 60 * 1000;
  return {
    schemaVersion: 1,
    requestId: "4f1e2d3c-5b6a-4978-8a6b-5c4d3e2f1a0b",
    driverOperatingGrant: GRANT_A,
    deviceDraftId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
    capturedAtMs: now - 1000,
    label: "Maple Loop Morning",
    direction: "to_school",
    startedAtMs: start,
    finishedAtMs: now - 60_000,
    path: [
      { latitude: 34.1, longitude: -83.98, capturedAtMs: start + 1000, gapBefore: false },
      { latitude: 34.1005, longitude: -83.98, capturedAtMs: start + 4000, gapBefore: true },
    ],
    stops: [{ label: "Example Oak Corner", latitude: 34.1005, longitude: -83.98, capturedAtMs: start + 4000 }],
    ...patch,
  };
}

function largest(): RouteDraftSubmission {
  const base = submission();
  const name = "É".repeat(MAX_ROUTE_DRAFT_LABEL_LENGTH);
  const start = Date.now() - 2 * HOUR;
  return {
    ...base,
    label: name,
    startedAtMs: start,
    finishedAtMs: start + MAX_ROUTE_PATH_POINTS * 1000,
    path: Array.from({ length: MAX_ROUTE_PATH_POINTS }, (_, i) => ({
      latitude: 34.1 + i * 1e-6,
      longitude: -83.98 - i * 1e-6,
      capturedAtMs: start + i * 1000,
      gapBefore: i % 500 === 1,
    })),
    stops: Array.from({ length: MAX_ROUTE_DRAFT_STOPS }, (_, i) => ({
      label: name,
      latitude: 34.1,
      longitude: -83.98,
      capturedAtMs: start + i * 1000,
    })),
  };
}

/** Escapes non-ASCII the way the Pi's json.dumps does. */
const piJson = (body: unknown) => JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

async function post(t: T, path: string, body: unknown, secret = SECRET_A) {
  const res = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: typeof body === "string" ? body : piJson(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const submit = (t: T, body: unknown, secret?: string) => post(t, "/device/v1/route-drafts", body, secret);
const status = (t: T, draftIds: string[], grant = GRANT_A, secret?: string) =>
  post(t, "/device/v1/route-drafts/status", { schemaVersion: 1, driverOperatingGrant: grant, draftIds }, secret);

const drafts = (t: T) => t.run((ctx) => ctx.db.query("routeDrafts").collect());
const versions = (t: T) => t.run((ctx) => ctx.db.query("routeVersions").collect());

function accepted(r: { status: number; body: Record<string, unknown> }) {
  expect(r.status).toBe(200);
  const body = r.body as RouteDraftSubmitResult;
  if (body.status === "rejected") throw new Error(`rejected: ${JSON.stringify(body)}`);
  return body;
}

describe("POST /device/v1/route-drafts", () => {
  it("stores a submitted draft for review, never approved, and audits the driver", async () => {
    const { t, deviceA, driver, existing } = await setup();
    const before = (await versions(t)).length;
    const body = accepted(await submit(t, submission()));
    expect(body).toMatchObject({ status: "accepted", draft: { status: "submitted", reviewedAtMs: null, routeVersionId: null } });

    const [row] = await drafts(t);
    expect(row).toMatchObject({
      status: "submitted",
      label: "Maple Loop Morning",
      recordedByDeviceId: deviceA,
      recordedByUserId: driver,
      deviceDraftId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
      gapBeforeIndexes: [1],
    });
    expect(row?.stops).toEqual([{ label: "Example Oak Corner", latitude: 34.1005, longitude: -83.98 }]);
    expect(row?.approvedVersionId).toBeUndefined();
    // No route version was created and no route changed.
    expect((await versions(t)).length).toBe(before);
    expect(await t.run((ctx) => ctx.db.query("routes").collect())).toEqual([]);
    expect(existing).toBeDefined();

    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "route.submitDraft")).toMatchObject({
      result: "allowed",
      actor: { kind: "user", userId: driver },
      viaDeviceId: deviceA,
      source: "driver_device",
    });
    // The grant secret never reaches the database.
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("routeDrafts").collect()))).not.toContain(GRANT_A);
  });

  it("a retry with the same requestId returns the same draft", async () => {
    const { t } = await setup();
    const first = accepted(await submit(t, submission()));
    const again = accepted(await submit(t, submission({ capturedAtMs: Date.now() - 500 })));
    expect(again.status).toBe("already_submitted");
    expect(again.draft.draftId).toBe(first.draft.draftId);
    expect((await drafts(t)).length).toBe(1);
  });

  it("a new requestId for the same device draft and content returns the same draft", async () => {
    const { t } = await setup();
    const first = accepted(await submit(t, submission()));
    const again = accepted(await submit(t, submission({ requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" })));
    expect(again).toMatchObject({ status: "already_submitted", draft: { draftId: first.draft.draftId } });
    expect((await drafts(t)).length).toBe(1);
  });

  it("the same requestId or device draft with different content is a conflict, not a second draft", async () => {
    const { t } = await setup();
    accepted(await submit(t, submission()));
    const changed = submission().stops.map((s) => ({ ...s, label: "Example Elm Corner" }));
    expect((await submit(t, submission({ stops: changed }))).body).toMatchObject({ status: "rejected", code: "request_id_conflict" });
    expect((await submit(t, submission({ stops: changed, requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }))).body).toMatchObject({
      status: "rejected",
      code: "draft_conflict",
    });
    const [only] = await drafts(t);
    expect((await drafts(t)).length).toBe(1);
    expect(only?.stops[0]?.label).toBe("Example Oak Corner");
  });

  it("two devices' drafts with the same device draft id stay separate", async () => {
    const { t } = await setup();
    const a = accepted(await submit(t, submission()));
    const b = accepted(await submit(t, submission({ driverOperatingGrant: GRANT_B }), SECRET_B));
    expect(b.status).toBe("accepted");
    expect(b.draft.draftId).not.toBe(a.draft.draftId);
  });

  it("refuses a missing or unknown credential and a revoked device", async () => {
    const { t, deviceA } = await setup();
    const none = await t.fetch("/device/v1/route-drafts", { method: "POST", body: piJson(submission()) });
    expect(none.status).toBe(401);
    expect((await submit(t, submission(), "c".repeat(64))).status).toBe(401);
    await t.run((ctx) => ctx.db.patch(deviceA, { revoked: true }));
    expect((await submit(t, submission())).body).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(await drafts(t)).toEqual([]);
  });

  it("rejects an expired, revoked, or another device's grant, and audits the denial", async () => {
    const { t, driver, deviceA, existing } = await setup();
    // Another device's grant.
    expect((await submit(t, submission({ driverOperatingGrant: GRANT_B }))).body).toMatchObject({ status: "rejected", code: "grant_not_authorized" });
    // Expired.
    const expired = "e".repeat(64);
    await t.mutation(internal.driverGrants.insert, {
      tokenHash: await sha256Hex(expired),
      deviceId: deviceA,
      driverUserId: driver,
      routeVersionIds: [existing],
      ttlMs: HOUR,
      nowMs: Date.now() - 2 * HOUR,
    });
    expect((await submit(t, submission({ driverOperatingGrant: expired }))).body).toMatchObject({ code: "grant_not_authorized" });
    // Revoked.
    const grant = await t.run(async (ctx) =>
      (await ctx.db.query("driverGrants").collect()).find((g) => g.deviceId === deviceA && g.expiresAtMs > Date.now()),
    );
    await t.mutation(internal.driverGrants.revoke, { grantId: grant!._id });
    expect((await submit(t, submission())).body).toMatchObject({ code: "grant_not_authorized" });

    expect(await drafts(t)).toEqual([]);
    const denied = (await t.run((ctx) => ctx.db.query("auditLog").collect())).filter((a) => a.action === "route.submitDraft");
    expect(denied.map((a) => a.result)).toEqual(["denied", "denied", "denied"]);
  });

  it("accepts the largest draft the Pi can record", async () => {
    const { t } = await setup();
    const big = largest();
    expect(piJson(big).length).toBeLessThan(MAX_ROUTE_DRAFT_BODY_BYTES);
    const body = accepted(await submit(t, big));
    expect(body.status).toBe("accepted");
    const [row] = await drafts(t);
    expect(row?.path.length).toBe(MAX_ROUTE_PATH_POINTS);
    expect(row?.stops.length).toBe(MAX_ROUTE_DRAFT_STOPS);
  });

  it("refuses over-limit drafts explicitly and stores nothing", async () => {
    const { t } = await setup();
    const big = largest();
    const extraPoint = { ...big.path.at(-1)!, capturedAtMs: big.finishedAtMs };
    expect(await submit(t, { ...big, path: [...big.path, extraPoint] })).toMatchObject({ status: 413, body: { error: { code: "TOO_MANY_POINTS" } } });
    expect(await submit(t, { ...big, stops: [...big.stops, big.stops[0]] })).toMatchObject({ status: 413, body: { error: { code: "TOO_MANY_STOPS" } } });
    const padded = JSON.stringify({ ...submission(), padding: "x".repeat(MAX_ROUTE_DRAFT_BODY_BYTES) });
    expect(await submit(t, padded)).toMatchObject({ status: 413, body: { error: { code: "BODY_TOO_LARGE" } } });
    expect(await drafts(t)).toEqual([]);
  });

  it("refuses impossible coordinates and times with the shared validator", async () => {
    const { t } = await setup();
    const s = submission();
    for (const bad of [
      { ...s, path: [{ ...s.path[0]!, latitude: 95 }, s.path[1]!] },
      { ...s, stops: [{ ...s.stops[0]!, longitude: -200 }] },
      { ...s, path: [s.path[1]!, s.path[0]!] },
      { ...s, finishedAtMs: Date.now() + HOUR, capturedAtMs: Date.now() + HOUR },
      { ...s, stops: [] },
    ]) {
      expect(await submit(t, bad)).toMatchObject({ status: 400, body: { error: { code: "INVALID_REQUEST" } } });
    }
    expect(await submit(t, { ...s, schemaVersion: 2 })).toMatchObject({ status: 400, body: { error: { code: "UNSUPPORTED_SCHEMA_VERSION" } } });
    expect(await drafts(t)).toEqual([]);
  });
});

describe("POST /device/v1/route-drafts/status", () => {
  it("shows submitted, then staff's approval or rejection with the reason", async () => {
    const { t } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const one = accepted(await submit(t, submission()));
    const two = accepted(
      await submit(
        t,
        submission({ requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", deviceDraftId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" }),
      ),
    );
    const read = async () => ((await status(t, [one.draft.draftId, two.draft.draftId])).body as unknown as RouteDraftStatusResponse).drafts;
    expect((await read()).map((d) => d.status)).toEqual(["submitted", "submitted"]);

    const approved = await staff.mutation(api.routes.approveDraft, { draftId: one.draft.draftId });
    expect(await staff.mutation(api.routes.rejectDraft, { draftId: two.draft.draftId, reason: "Stop 1 is on the wrong side." })).toMatchObject({
      status: "rejected",
    });
    if (approved.status !== "approved") throw new Error("not approved");
    expect(await read()).toEqual([
      expect.objectContaining({ status: "approved", routeVersionId: approved.routeVersionId, decisionReason: null }),
      expect.objectContaining({ status: "rejected", decisionReason: "Stop 1 is on the wrong side.", routeVersionId: null }),
    ]);
  });

  it("another device's draft and unknown ids read as not_found", async () => {
    const { t } = await setup();
    const mine = accepted(await submit(t, submission()));
    const r = await status(t, [mine.draft.draftId, "nope"], GRANT_B, SECRET_B);
    expect(r.status).toBe(200);
    expect((r.body as unknown as RouteDraftStatusResponse).drafts).toEqual([
      { draftId: mine.draft.draftId, status: "not_found" },
      { draftId: "nope", status: "not_found" },
    ]);
  });

  it("refuses without a current grant or with a revoked device", async () => {
    const { t, deviceA } = await setup();
    const mine = accepted(await submit(t, submission()));
    expect(await status(t, [mine.draft.draftId], GRANT_B)).toMatchObject({ status: 403, body: { error: { code: "GRANT_NOT_AUTHORIZED" } } });
    await t.run((ctx) => ctx.db.patch(deviceA, { revoked: true }));
    expect((await status(t, [mine.draft.draftId])).status).toBe(401);
  });
});

describe("a submitted draft becomes the route a new run pins", () => {
  it("submit → staff approve → grant → start pins the approved version", async () => {
    const { t, driver, deviceA } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const sent = accepted(await submit(t, submission()));
    const listed = await staff.query(api.routes.listDrafts, {});
    if (listed.status !== "ready") throw new Error("not ready");
    expect(listed.drafts.map((d) => d.draftId)).toContain(sent.draft.draftId);

    const approved = await staff.mutation(api.routes.approveDraft, { draftId: sent.draft.draftId });
    if (approved.status !== "approved") throw new Error(`not approved: ${JSON.stringify(approved)}`);
    const versionId = await t.run((ctx) => approvedVersionForNewRun(ctx, approved.routeId as Id<"routes">));
    expect(versionId).toBe(approved.routeVersionId);

    const grant = "k".repeat(64);
    await t.mutation(internal.driverGrants.insert, {
      tokenHash: await sha256Hex(grant),
      deviceId: deviceA,
      driverUserId: driver,
      routeVersionIds: [versionId!],
      ttlMs: 8 * HOUR,
      nowMs: Date.now(),
    });
    const capturedAtMs = Date.now() - 1000;
    const res = await post(t, "/device/v1/trip-events", {
      schemaVersion: 1,
      requestId: "64869872-aaf9-4e4f-99df-621722bbac06",
      type: "startRun",
      driverOperatingGrant: grant,
      routeVersionId: versionId,
      serviceDate: localDate(capturedAtMs, TZ),
      serviceTimezone: TZ,
      capturedAtMs,
    });
    expect(res).toMatchObject({ status: 200, body: { status: "accepted" } });
    const run = await t.run(async (ctx) => ctx.db.get(ctx.db.normalizeId("runs", res.body.runId as string)!));
    expect(run?.routeVersionId).toBe(approved.routeVersionId);
    const version = await t.run((ctx) => ctx.db.get(approved.routeVersionId as Id<"routeVersions">));
    expect(version?.path).toEqual(submission().path.map((p) => ({ latitude: p.latitude, longitude: p.longitude })));
    expect(version?.sourceDraftId).toBe(sent.draft.draftId);
  });
});

describe("credential rotated or revoked mid-request", () => {
  // The HTTP action looks the credential up, then the mutation commits; a
  // rotation that lands in between must refuse the request at commit.
  it("submit and status refuse a credential rotated after the lookup", async () => {
    const { t, deviceA } = await setup();
    const presented = await sha256Hex(SECRET_A);
    const sent = accepted(await submit(t, submission()));
    await t.run((ctx) => ctx.db.patch(deviceA, { credentialHash: "rotated".padEnd(64, "0") }));
    const body = submission({ requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", deviceDraftId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" });
    await expect(
      t.mutation(internal.deviceDrafts.submit, {
        deviceId: deviceA,
        credentialHash: presented,
        grantHash: await sha256Hex(GRANT_A),
        contentHash: "c".repeat(64),
        submission: body,
        nowMs: Date.now(),
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    await expect(
      t.query(internal.deviceDrafts.status, {
        deviceId: deviceA,
        credentialHash: presented,
        grantHash: await sha256Hex(GRANT_A),
        draftIds: [sent.draft.draftId],
        nowMs: Date.now(),
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    expect((await drafts(t)).length).toBe(1);
    // The old secret over HTTP is refused too.
    expect((await submit(t, body)).status).toBe(401);
  });
});

describe("GPS gaps reach staff review", () => {
  it("a point after a GPS loss is stored and flagged, even when the hop is short", async () => {
    const { t } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const s = submission();
    // A 55 m interruption: under the 100 m distance warning, still not measured travel.
    const path = [s.path[0]!, { ...s.path[1]!, latitude: 34.1005, gapBefore: true }];
    const sent = accepted(await submit(t, { ...s, path }));
    const got = await staff.query(api.routes.getDraft, { draftId: sent.draft.draftId });
    if (got.status !== "ready") throw new Error("not ready");
    expect(got.draft.gapBeforeIndexes).toEqual([1]);
    expect(got.draft.checks).toContainEqual(expect.objectContaining({ code: "gap_in_recording", severity: "warning" }));
    expect(got.draft.checks.find((c) => c.code === "gap_in_recording")?.message).toContain("1 time");
    expect(got.draft.checks.some((c) => c.code === "path_gap")).toBe(false);
  });

  it("a recording without GPS loss has no gap check", async () => {
    const { t } = await setup();
    const staff = t.withIdentity({ tokenIdentifier: STAFF });
    const s = submission();
    const sent = accepted(await submit(t, { ...s, path: s.path.map((p) => ({ ...p, gapBefore: false })) }));
    const got = await staff.query(api.routes.getDraft, { draftId: sent.draft.draftId });
    if (got.status !== "ready") throw new Error("not ready");
    expect(got.draft.gapBeforeIndexes).toEqual([]);
    expect(got.draft.checks.some((c) => c.code === "gap_in_recording")).toBe(false);
  });
});
