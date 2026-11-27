import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

/**
 * Staff device credentials (docs/14 §4, docs/11 §3): provision a device,
 * rotate its credential, revoke it. The secret is returned once to the staff
 * member who asked; only its SHA-256 hash is stored.
 */

const modules = import.meta.glob("./**/*.ts");
const STAFF = "test|staff";
const DRIVER = "test|driver";
const FAMILY = "test|family";
const OLD_SECRET = "b".repeat(64);

async function setup(revoked = false) {
  const t = convexTest(schema, modules);
  const credentialHash = await sha256Hex(OLD_SECRET);
  const ids = await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("users", { tokenIdentifier: STAFF, role: "staff", displayName: "Riley Staff" });
    await ctx.db.insert("users", { tokenIdentifier: DRIVER, role: "driver", displayName: "Dana Driver" });
    await ctx.db.insert("users", { tokenIdentifier: FAMILY, role: "family", displayName: "Pat Parent" });
    const deviceId = await ctx.db.insert("devices", { label: "Bench Pi (fictional)", credentialHash, revoked });
    return { staffId, deviceId };
  });
  return { t, staff: t.withIdentity({ tokenIdentifier: STAFF }), ...ids };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const lookup = async (t: T, secret: string) =>
  t.query(internal.devices.byCredentialHash, { credentialHash: await sha256Hex(secret) });

const auditRows = (t: T) => t.run((ctx) => ctx.db.query("auditLog").collect());

describe("fleet.rotateDeviceCredential", () => {
  it("issues a new secret once; it authenticates and the old one stops", async () => {
    const { t, staff, deviceId, staffId } = await setup();
    const result = await staff.action(api.fleet.rotateDeviceCredential, { deviceId });
    if (result.status !== "issued") throw new Error(`expected issued, got ${result.status}`);
    expect(result.deviceId).toBe(deviceId);
    expect(result.deviceSecret).toMatch(/^[0-9a-f]{64}$/);

    expect(await lookup(t, result.deviceSecret)).toBe(deviceId);
    expect(await lookup(t, OLD_SECRET)).toBeNull();
    const stored = await t.run((ctx) => ctx.db.get(deviceId));
    expect(stored?.credentialHash).toBe(await sha256Hex(result.deviceSecret));
    expect(JSON.stringify(stored)).not.toContain(result.deviceSecret);

    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: { kind: "user", userId: staffId },
      action: "device.rotateCredential",
      resourceId: deviceId,
      result: "allowed",
    });
    expect(JSON.stringify(audit)).not.toContain(result.deviceSecret);
  });

  it("keeps the device's identity, so an active run continues on the new credential", async () => {
    const { t, staff, deviceId } = await setup();
    const runId = await t.run((ctx) =>
      ctx.db.insert("runs", { deviceId, routeVersionId: "rv_fictional", state: "active", startRequestId: "req-1" }),
    );
    const result = await staff.action(api.fleet.rotateDeviceCredential, { deviceId });
    if (result.status !== "issued") throw new Error("expected issued");
    expect(await lookup(t, result.deviceSecret)).toBe(deviceId);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.state).toBe("active");
  });

  it("never revives a revoked device", async () => {
    const { t, staff, deviceId } = await setup(true);
    const result = await staff.action(api.fleet.rotateDeviceCredential, { deviceId });
    expect(result).toMatchObject({ status: "refused", code: "revoked" });
    expect(result).not.toHaveProperty("deviceSecret");
    const stored = await t.run((ctx) => ctx.db.get(deviceId));
    expect(stored?.credentialHash).toBe(await sha256Hex(OLD_SECRET));
    expect(stored?.revoked).toBe(true);
  });

  it("refuses an unknown or malformed device", async () => {
    const { t, staff, deviceId } = await setup();
    await t.run((ctx) => ctx.db.delete(deviceId));
    expect(await staff.action(api.fleet.rotateDeviceCredential, { deviceId })).toMatchObject({
      status: "refused",
      code: "not_found",
    });
    expect(await staff.action(api.fleet.rotateDeviceCredential, { deviceId: "nope" })).toMatchObject({
      status: "refused",
      code: "not_found",
    });
  });

  for (const who of [DRIVER, FAMILY]) {
    it(`${who} is not permitted, changes nothing, and is audited as denied`, async () => {
      const { t, deviceId } = await setup();
      const result = await t.withIdentity({ tokenIdentifier: who }).action(api.fleet.rotateDeviceCredential, { deviceId });
      expect(result).toEqual({
        schemaVersion: 1,
        status: "access_unavailable",
        serverNowMs: expect.any(Number),
        reason: "not_permitted",
      });
      expect(await lookup(t, OLD_SECRET)).toBe(deviceId);
      expect((await auditRows(t)).map((a) => [a.action, a.result])).toEqual([["device.rotateCredential", "denied"]]);
    });
  }

  it("signed out is unauthenticated and changes nothing", async () => {
    const { t, deviceId } = await setup();
    expect(await t.action(api.fleet.rotateDeviceCredential, { deviceId })).toMatchObject({
      status: "access_unavailable",
      reason: "unauthenticated",
    });
    expect(await lookup(t, OLD_SECRET)).toBe(deviceId);
  });
});

describe("fleet.provisionDevice", () => {
  it("creates an active device whose one-time secret authenticates", async () => {
    const { t, staff, staffId } = await setup();
    const result = await staff.action(api.fleet.provisionDevice, { label: "Spare Pi (fictional)", busLabel: "Bus 9" });
    if (result.status !== "issued") throw new Error(`expected issued, got ${result.status}`);
    const deviceId = result.deviceId as Id<"devices">;
    expect(await lookup(t, result.deviceSecret)).toBe(deviceId);
    expect(await t.run((ctx) => ctx.db.get(deviceId))).toMatchObject({
      label: "Spare Pi (fictional)",
      busLabel: "Bus 9",
      revoked: false,
    });
    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: { kind: "user", userId: staffId },
      action: "device.provision",
      resourceId: deviceId,
      result: "allowed",
    });
  });

  it("gives every device its own credential", async () => {
    const { staff } = await setup();
    const a = await staff.action(api.fleet.provisionDevice, { label: "Pi A" });
    const b = await staff.action(api.fleet.provisionDevice, { label: "Pi B" });
    if (a.status !== "issued" || b.status !== "issued") throw new Error("expected issued");
    expect(a.deviceSecret).not.toBe(b.deviceSecret);
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it("refuses an empty or overlong label and creates nothing", async () => {
    const { t, staff } = await setup();
    for (const args of [{ label: "  " }, { label: "x".repeat(81) }, { label: "Pi", busLabel: "x".repeat(41) }]) {
      expect(await staff.action(api.fleet.provisionDevice, args)).toMatchObject({
        status: "refused",
        code: "invalid_label",
      });
    }
    expect(await t.run((ctx) => ctx.db.query("devices").collect())).toHaveLength(1);
  });

  it("non-staff cannot create a device", async () => {
    const { t } = await setup();
    const result = await t.withIdentity({ tokenIdentifier: DRIVER }).action(api.fleet.provisionDevice, { label: "Rogue Pi" });
    expect(result).toMatchObject({ status: "access_unavailable", reason: "not_permitted" });
    expect(await t.run((ctx) => ctx.db.query("devices").collect())).toHaveLength(1);
    expect((await auditRows(t)).map((a) => [a.action, a.result])).toEqual([["device.provision", "denied"]]);
  });
});

describe("revocation", () => {
  it("stops the credential at once, and rotation cannot undo it", async () => {
    const { t, staff, deviceId } = await setup();
    const issued = await staff.action(api.fleet.rotateDeviceCredential, { deviceId });
    if (issued.status !== "issued") throw new Error("expected issued");
    expect(await staff.mutation(api.fleet.revokeDevice, { deviceId })).toMatchObject({ status: "ok" });
    expect(await lookup(t, issued.deviceSecret)).toBeNull();
    expect(await staff.action(api.fleet.rotateDeviceCredential, { deviceId })).toMatchObject({
      status: "refused",
      code: "revoked",
    });
    expect(await lookup(t, issued.deviceSecret)).toBeNull();
  });
});
