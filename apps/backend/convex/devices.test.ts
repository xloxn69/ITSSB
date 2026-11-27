import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/deviceAuth";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function withDevice(revoked = false) {
  const t = convexTest(schema, modules);
  const oldSecret = "a".repeat(64);
  const credentialHash = await sha256Hex(oldSecret);
  const deviceId = await t.run((ctx) =>
    ctx.db.insert("devices", { label: "Bench Pi (fictional)", credentialHash, revoked }),
  );
  return { t, deviceId, oldSecret };
}

describe("devices.rotateCredential", () => {
  it("issues a new secret that authenticates, and the old one stops working", async () => {
    const { t, deviceId, oldSecret } = await withDevice();
    const { deviceSecret } = await t.action(internal.devices.rotateCredential, { deviceId });
    expect(deviceSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceSecret).not.toBe(oldSecret);

    const lookup = async (secret: string) =>
      t.query(internal.devices.byCredentialHash, { credentialHash: await sha256Hex(secret) });
    expect(await lookup(deviceSecret)).toBe(deviceId);
    expect(await lookup(oldSecret)).toBeNull();

    const stored = await t.run((ctx) => ctx.db.get(deviceId));
    expect(stored?.credentialHash).toBe(await sha256Hex(deviceSecret)); // only the hash is kept
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((a) => a.action)).toEqual(["devices.rotateCredential"]);
  });

  it("never revives a revoked device", async () => {
    const { t, deviceId } = await withDevice(true);
    await expect(t.action(internal.devices.rotateCredential, { deviceId })).rejects.toThrow(
      /DEVICE_NOT_AUTHORIZED/,
    );
    const stored = await t.run((ctx) => ctx.db.get(deviceId));
    expect(stored?.revoked).toBe(true);
  });
});

describe("a request in flight during rotation", () => {
  // The HTTP action authenticates in one transaction and writes in another.
  // These calls are the write step of a request that authenticated with the
  // old secret just before the rotation committed.
  it("cannot commit telemetry with the old credential", async () => {
    const { t, deviceId, oldSecret } = await withDevice();
    const oldHash = await sha256Hex(oldSecret);
    expect(await t.query(internal.devices.byCredentialHash, { credentialHash: oldHash })).toBe(
      deviceId,
    );
    const { deviceSecret } = await t.action(internal.devices.rotateCredential, { deviceId });

    const event = { eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42" };
    await expect(
      t.mutation(internal.telemetry.ingestBatch, {
        deviceId,
        credentialHash: oldHash,
        events: [event],
        nowMs: 0,
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    // The current credential still reaches per-event processing.
    const results = await t.mutation(internal.telemetry.ingestBatch, {
      deviceId,
      credentialHash: await sha256Hex(deviceSecret),
      events: [event],
      nowMs: 0,
    });
    expect(results).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("telemetryEvents").collect())).toEqual([]);
  });

  it("cannot start or end a run with the old credential", async () => {
    const { t, deviceId, oldSecret } = await withDevice();
    await t.action(internal.devices.rotateCredential, { deviceId });
    await expect(
      t.mutation(internal.tripEvents.apply, {
        deviceId,
        credentialHash: await sha256Hex(oldSecret),
        grantHash: "0".repeat(64),
        request: {},
        nowMs: 0,
      }),
    ).rejects.toThrow(/DEVICE_NOT_AUTHORIZED/);
    expect(await t.run((ctx) => ctx.db.query("runs").collect())).toEqual([]);
  });
});
