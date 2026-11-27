import {
  type CredentialIssuedResult,
  type ListMaintenanceResult,
  MAINTENANCE_REFUSAL_CODES,
  type MaintenanceRefusalCode,
  type MaintenanceResult,
  type MaintenanceWindow,
  MAX_MAINTENANCE_MS,
  MAX_STAFF_REASON_LENGTH,
  type DeviceDiagnostics,
  type DiagnosticsResult,
  type CredentialRefusalCode,
  type DeviceSummary,
  type FleetMutationResult,
  type ListDevicesResult,
  type ListDriversResult,
  MAX_BUS_LABEL_LENGTH,
  MAX_DEVICE_LABEL_LENGTH,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { generateDeviceSecret, sha256Hex } from "./lib/deviceAuth";
import { accessUnavailable, audit, denied, staffCaller } from "./lib/staff";
import { boundedText, okResult, refusedResult, staffActionResult } from "./lib/staffResults";
import { RAW_GPS_RETENTION_DAYS } from "./retention";

// The Convex runtime provides `process.env`.
declare const process: { env: Record<string, string | undefined> };
/** A deployment variable, or null when it isn't set. */
const env = (name: string) => process.env[name]?.trim() || null;

/**
 * Staff bus/device and driver pages (docs/12 §3, docs/08 §11). Device
 * credentials are never returned: not the secret, not its hash.
 */

const nullable = <T extends Parameters<typeof v.union>[0]>(x: T) => v.union(x, v.null());

const fleetMutationResult = v.union(
  v.object({ schemaVersion: v.literal(SCHEMA_VERSION), status: v.literal("ok"), serverNowMs: v.number() }),
  v.object({
    schemaVersion: v.literal(SCHEMA_VERSION),
    status: v.literal("refused"),
    serverNowMs: v.number(),
    code: v.union(v.literal("not_found"), v.literal("invalid_label")),
    message: v.string(),
  }),
  accessUnavailable,
);

const ok = (): FleetMutationResult => ({ schemaVersion: SCHEMA_VERSION, status: "ok", serverNowMs: Date.now() });
const refused = (code: "not_found" | "invalid_label", message: string): FleetMutationResult => ({
  schemaVersion: SCHEMA_VERSION,
  status: "refused",
  serverNowMs: Date.now(),
  code,
  message,
});

export const listDevices = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      devices: v.array(
        v.object({
          deviceId: v.string(),
          label: v.string(),
          busLabel: nullable(v.string()),
          revoked: v.boolean(),
          activeRun: nullable(
            v.object({ runId: v.string(), routeLabel: nullable(v.string()), startedAtMs: nullable(v.number()) }),
          ),
          lastContactAtMs: nullable(v.number()),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListDevicesResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const devices: DeviceSummary[] = [];
    for (const device of await ctx.db.query("devices").take(500)) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_device_state", (q) => q.eq("deviceId", device._id).eq("state", "active"))
        .first();
      const live = run
        ? await ctx.db
            .query("liveState")
            .withIndex("by_run", (q) => q.eq("runId", run._id))
            .unique()
        : null;
      const versionId = run ? ctx.db.normalizeId("routeVersions", run.routeVersionId) : null;
      const version = versionId ? await ctx.db.get(versionId) : null;
      devices.push({
        deviceId: device._id,
        label: device.label,
        busLabel: device.busLabel ?? null,
        revoked: device.revoked,
        activeRun: run
          ? { runId: run._id, routeLabel: version?.label ?? null, startedAtMs: run.startedAtMs ?? null }
          : null,
        lastContactAtMs: live?.receivedAtMs ?? null,
      });
    }
    devices.sort((a, b) => a.label.localeCompare(b.label));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), devices };
  },
});

/** Sets the family-facing bus name ("Bus 12") for a device. */
export const setBusLabel = mutation({
  args: { deviceId: v.string(), busLabel: v.string() },
  returns: fleetMutationResult,
  handler: async (ctx, { deviceId, busLabel }): Promise<FleetMutationResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "device.setBusLabel", "device", deviceId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id ? await ctx.db.get(id) : null;
    if (!device) return refused("not_found", "That device doesn't exist.");
    const label = busLabel.trim();
    if (!label || label.length > MAX_BUS_LABEL_LENGTH) {
      return refused("invalid_label", `Use 1 to ${MAX_BUS_LABEL_LENGTH} characters.`);
    }
    await ctx.db.patch(device._id, { busLabel: label });
    await audit(ctx, caller.user, "device.setBusLabel", "device", device._id, "allowed");
    return ok();
  },
});

/**
 * Revokes a device credential. Its telemetry is rejected from then on
 * (devices.byCredentialHash ignores revoked devices). Idempotent.
 */
export const revokeDevice = mutation({
  args: { deviceId: v.string() },
  returns: fleetMutationResult,
  handler: async (ctx, { deviceId }): Promise<FleetMutationResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "device.revoke", "device", deviceId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id ? await ctx.db.get(id) : null;
    if (!device) return refused("not_found", "That device doesn't exist.");
    if (!device.revoked) {
      await ctx.db.patch(device._id, { revoked: true });
      await audit(ctx, caller.user, "device.revoke", "device", device._id, "allowed");
    }
    return ok();
  },
});

export const listDrivers = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      drivers: v.array(v.object({ userId: v.string(), displayName: v.string() })),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListDriversResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const drivers = (
      await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", "driver"))
        .take(500)
    )
      .map((u) => ({ userId: u._id as string, displayName: u.displayName }))
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), drivers };
  },
});

// ── Device credentials (docs/14 §4, docs/11 §3) ─────────────────────────
//
// Issuing is an action so the secret comes from real randomness; the
// authorization check, the write and the audit row happen together in one
// internal mutation, which sees the caller's identity. The secret is returned
// once, to the staff member who asked, and never stored or logged.

const credentialRefused = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("refused"),
  serverNowMs: v.number(),
  code: v.union(v.literal("not_found"), v.literal("revoked"), v.literal("invalid_label")),
  message: v.string(),
});

const credentialIssuedResult = v.union(
  v.object({
    schemaVersion: v.literal(SCHEMA_VERSION),
    status: v.literal("issued"),
    serverNowMs: v.number(),
    deviceId: v.string(),
    deviceSecret: v.string(),
  }),
  credentialRefused,
  accessUnavailable,
);

const credentialWriteResult = v.union(
  v.object({ status: v.literal("ok"), deviceId: v.string() }),
  credentialRefused,
  accessUnavailable,
);
type CredentialWriteResult =
  | { status: "ok"; deviceId: string }
  | Exclude<CredentialIssuedResult, { status: "issued" }>;

const credentialRefusal = (code: CredentialRefusalCode, message: string): CredentialWriteResult => ({
  schemaVersion: SCHEMA_VERSION,
  status: "refused",
  serverNowMs: Date.now(),
  code,
  message,
});

function issued(write: CredentialWriteResult, deviceSecret: string): CredentialIssuedResult {
  if (write.status !== "ok") return write;
  return { schemaVersion: SCHEMA_VERSION, status: "issued", serverNowMs: Date.now(), deviceId: write.deviceId, deviceSecret };
}

/**
 * Replaces a device's credential. The old secret stops working at once; the
 * device keeps its identity, bus and any active run. Install the new secret
 * on the Pi in a maintenance window (docs/runbooks/device-credentials.md);
 * until then its uploads are refused and wait in its outbox. A revoked device
 * stays revoked: provision a new device instead.
 */
export const rotateDeviceCredential = action({
  args: { deviceId: v.string() },
  returns: credentialIssuedResult,
  handler: async (ctx, { deviceId }): Promise<CredentialIssuedResult> => {
    const deviceSecret = generateDeviceSecret();
    const write: CredentialWriteResult = await ctx.runMutation(internal.fleet.applyRotation, {
      deviceId,
      credentialHash: await sha256Hex(deviceSecret),
    });
    return issued(write, deviceSecret);
  },
});

export const applyRotation = internalMutation({
  args: { deviceId: v.string(), credentialHash: v.string() },
  returns: credentialWriteResult,
  handler: async (ctx, { deviceId, credentialHash }): Promise<CredentialWriteResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "device.rotateCredential", "device", deviceId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id ? await ctx.db.get(id) : null;
    if (!device || device.revoked) {
      // A refused attempt by staff is audited too, so it can be traced.
      await audit(ctx, caller.user, "device.rotateCredential", "device", deviceId, "denied");
      return device
        ? credentialRefusal("revoked", "This device is revoked. Provision a new device instead.")
        : credentialRefusal("not_found", "That device doesn't exist.");
    }
    await ctx.db.patch(device._id, { credentialHash });
    await audit(ctx, caller.user, "device.rotateCredential", "device", device._id, "allowed");
    return { status: "ok", deviceId: device._id };
  },
});

/** Creates a device with its own credential (docs/14 §4 step 1-2). */
export const provisionDevice = action({
  args: { label: v.string(), busLabel: v.optional(v.string()) },
  returns: credentialIssuedResult,
  handler: async (ctx, args): Promise<CredentialIssuedResult> => {
    const deviceSecret = generateDeviceSecret();
    const write: CredentialWriteResult = await ctx.runMutation(internal.fleet.createDevice, {
      ...args,
      credentialHash: await sha256Hex(deviceSecret),
    });
    return issued(write, deviceSecret);
  },
});

export const createDevice = internalMutation({
  args: { label: v.string(), busLabel: v.optional(v.string()), credentialHash: v.string() },
  returns: credentialWriteResult,
  handler: async (ctx, { label, busLabel, credentialHash }): Promise<CredentialWriteResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "device.provision", "device", undefined, "denied");
      return denied(caller.reason);
    }
    const name = label.trim();
    const bus = busLabel?.trim() || undefined;
    if (!name || name.length > MAX_DEVICE_LABEL_LENGTH || (bus && bus.length > MAX_BUS_LABEL_LENGTH)) {
      await audit(ctx, caller.user, "device.provision", "device", undefined, "denied");
    }
    if (!name || name.length > MAX_DEVICE_LABEL_LENGTH) {
      return credentialRefusal("invalid_label", `Use 1 to ${MAX_DEVICE_LABEL_LENGTH} characters for the device name.`);
    }
    if (bus && bus.length > MAX_BUS_LABEL_LENGTH) {
      return credentialRefusal("invalid_label", `Use at most ${MAX_BUS_LABEL_LENGTH} characters for the bus name.`);
    }
    const deviceId = await ctx.db.insert("devices", {
      label: name,
      credentialHash,
      revoked: false,
      ...(bus ? { busLabel: bus } : {}),
    });
    await audit(ctx, caller.user, "device.provision", "device", deviceId, "allowed");
    return { status: "ok", deviceId };
  },
});

/**
 * Staff diagnostics (docs/12 §11): which release the deployment runs, the
 * retention policy and its last sweep, and per device: contact age, run IDs,
 * and the software version and upload queue from its latest heartbeat.
 */
export const diagnostics = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      deployment: v.object({
        release: nullable(v.string()),
        environment: nullable(v.string()),
        contractSchemaVersion: v.number(),
      }),
      retention: v.object({
        rawGpsDays: v.number(),
        lastSweepAtMs: nullable(v.number()),
        lastSweepDeleted: nullable(v.string()),
      }),
      devices: v.array(
        v.object({
          deviceId: v.string(),
          label: v.string(),
          busLabel: nullable(v.string()),
          revoked: v.boolean(),
          activeRunId: nullable(v.string()),
          lastContactAtMs: nullable(v.number()),
          softwareVersion: nullable(v.string()),
          pendingCount: nullable(v.number()),
          oldestPendingCapturedAtMs: nullable(v.number()),
          lastRun: nullable(
            v.object({
              runId: v.string(),
              state: v.union(v.literal("scheduled"), v.literal("active"), v.literal("completed"), v.literal("cancelled")),
              endedAtMs: nullable(v.number()),
            }),
          ),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<DiagnosticsResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const devices: DeviceDiagnostics[] = [];
    for (const device of await ctx.db.query("devices").take(500)) {
      const latest = async (state: "active" | "completed" | "cancelled") =>
        ctx.db
          .query("runs")
          .withIndex("by_device_state", (q) => q.eq("deviceId", device._id).eq("state", state))
          .order("desc")
          .first();
      const active = await latest("active");
      const ended = [await latest("completed"), await latest("cancelled")]
        .filter((r) => r !== null)
        .toSorted((a, b) => (b.endedAtMs ?? b._creationTime) - (a.endedAtMs ?? a._creationTime));
      const lastRun = active ?? ended[0] ?? null;
      const live = lastRun
        ? await ctx.db
            .query("liveState")
            .withIndex("by_run", (q) => q.eq("runId", lastRun._id))
            .unique()
        : null;
      // Contact is any receipt from the device. The live position alone is not
      // enough: a backlog upload is stored without moving it.
      const health = await ctx.db
        .query("deviceHealth")
        .withIndex("by_device", (q) => q.eq("deviceId", device._id))
        .unique();
      const contacts = [health?.receivedAtMs, live?.receivedAtMs].filter((x): x is number => x !== undefined);
      devices.push({
        deviceId: device._id,
        label: device.label,
        busLabel: device.busLabel ?? null,
        revoked: device.revoked,
        activeRunId: active?._id ?? null,
        lastContactAtMs: contacts.length ? Math.max(...contacts) : null,
        softwareVersion: health?.appVersion ?? null,
        pendingCount: health?.pendingCount ?? null,
        oldestPendingCapturedAtMs: health?.oldestPendingCapturedAtMs ?? null,
        lastRun: lastRun ? { runId: lastRun._id, state: lastRun.state, endedAtMs: lastRun.endedAtMs ?? null } : null,
      });
    }
    devices.sort((a, b) => a.label.localeCompare(b.label));
    const sweep = await ctx.db
      .query("auditLog")
      .withIndex("by_resource", (q) => q.eq("resourceType", "retention").eq("resourceId", "rawGps"))
      .order("desc")
      .first();
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: Date.now(),
      deployment: {
        release: env("ITSSB_RELEASE"),
        environment: env("ITSSB_ENVIRONMENT"),
        contractSchemaVersion: SCHEMA_VERSION,
      },
      retention: {
        rawGpsDays: RAW_GPS_RETENTION_DAYS,
        lastSweepAtMs: sweep?.atMs ?? null,
        lastSweepDeleted: sweep?.reason ?? null,
      },
      devices,
    };
  },
});

// ── Maintenance windows (docs/14 §5) ──────────────────────────────────
//
// A planned period when a device's software may be updated. The Pi release
// tool independently refuses to switch releases during an active run
// (docs/runbooks/pi-update-and-rollback.md); the window is the staff-side
// plan that tells drivers and support when a bus is out.

const maintenanceResult = staffActionResult(MAINTENANCE_REFUSAL_CODES);
const maintenanceOk = okResult<MaintenanceRefusalCode>;
const maintenanceRefused = refusedResult<MaintenanceRefusalCode>;
/** Clock slack for a window that starts "now". */
const START_SLACK_MS = 5 * 60 * 1000;

export const listMaintenance = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      windows: v.array(
        v.object({
          windowId: v.string(),
          deviceId: v.string(),
          deviceLabel: v.string(),
          startsAtMs: v.number(),
          endsAtMs: v.number(),
          reason: v.string(),
          scheduledByName: nullable(v.string()),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListMaintenanceResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const nowMs = Date.now();
    const windows: MaintenanceWindow[] = [];
    for (const w of await ctx.db.query("maintenanceWindows").order("desc").take(500)) {
      if (w.cancelledAtMs !== undefined || w.endsAtMs <= nowMs) continue;
      windows.push({
        windowId: w._id,
        deviceId: w.deviceId,
        deviceLabel: (await ctx.db.get(w.deviceId))?.label ?? "Unknown device",
        startsAtMs: w.startsAtMs,
        endsAtMs: w.endsAtMs,
        reason: w.reason,
        scheduledByName: (await ctx.db.get(w.scheduledByUserId))?.displayName ?? null,
      });
    }
    windows.sort((a, b) => a.startsAtMs - b.startsAtMs);
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: nowMs, windows };
  },
});

export const scheduleMaintenance = mutation({
  args: { deviceId: v.string(), startsAtMs: v.number(), endsAtMs: v.number(), reason: v.string() },
  returns: maintenanceResult,
  handler: async (ctx, { deviceId, startsAtMs, endsAtMs, reason }): Promise<MaintenanceResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "maintenance.schedule", "device", deviceId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id ? await ctx.db.get(id) : null;
    if (!device || device.revoked) {
      return maintenanceRefused("device_unavailable", "That device doesn't exist or is revoked.");
    }
    const text = boundedText(reason, MAX_STAFF_REASON_LENGTH);
    if (!text) return maintenanceRefused("reason_required", `Say why, in 1 to ${MAX_STAFF_REASON_LENGTH} characters.`);
    const nowMs = Date.now();
    if (
      !Number.isFinite(startsAtMs) ||
      !Number.isFinite(endsAtMs) ||
      endsAtMs <= startsAtMs ||
      endsAtMs - startsAtMs > MAX_MAINTENANCE_MS ||
      // A start up to a few minutes ago counts as "now" (clock slack), but a
      // window that is already over is never accepted as scheduled.
      startsAtMs < nowMs - START_SLACK_MS ||
      endsAtMs <= nowMs
    ) {
      return maintenanceRefused("invalid_window", "Pick a future window of at most 12 hours that ends after it starts.");
    }
    if (startsAtMs <= nowMs + START_SLACK_MS) {
      const running = await ctx.db
        .query("runs")
        .withIndex("by_device_state", (q) => q.eq("deviceId", device._id).eq("state", "active"))
        .first();
      if (running) return maintenanceRefused("device_busy", "This bus is on a run now. Schedule the window after it ends.");
    }
    const existing = await ctx.db
      .query("maintenanceWindows")
      .withIndex("by_device", (q) => q.eq("deviceId", device._id).lt("startsAtMs", endsAtMs))
      .collect();
    if (existing.some((w) => w.cancelledAtMs === undefined && w.endsAtMs > startsAtMs)) {
      return maintenanceRefused("overlaps", "This overlaps another window for the same device.");
    }
    await ctx.db.insert("maintenanceWindows", {
      deviceId: device._id,
      startsAtMs,
      endsAtMs,
      reason: text,
      scheduledByUserId: caller.user._id,
      scheduledAtMs: nowMs,
    });
    await audit(ctx, caller.user, "maintenance.schedule", "device", device._id, "allowed");
    return maintenanceOk();
  },
});

export const cancelMaintenance = mutation({
  args: { windowId: v.string() },
  returns: maintenanceResult,
  handler: async (ctx, { windowId }): Promise<MaintenanceResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "maintenance.cancel", "maintenanceWindows", windowId, "denied");
      return denied(caller.reason);
    }
    const id = ctx.db.normalizeId("maintenanceWindows", windowId);
    const window = id ? await ctx.db.get(id) : null;
    if (!window || window.cancelledAtMs !== undefined) return maintenanceRefused("not_found", "That window doesn't exist.");
    await ctx.db.patch(window._id, { cancelledAtMs: Date.now(), cancelledByUserId: caller.user._id });
    await audit(ctx, caller.user, "maintenance.cancel", "maintenanceWindows", window._id, "allowed");
    return maintenanceOk();
  },
});
