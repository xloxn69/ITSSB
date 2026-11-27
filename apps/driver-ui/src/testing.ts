import type { DeviceSnapshot, Observed } from "./snapshot.js";

/** A fictional, indoor-looking snapshot: GPSD up, receiver present, no fix, no server set up. */
export function snapshot(overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    schemaVersion: 1,
    generatedAtMs: 1_795_608_000_000,
    process: { version: "0.1.0", bootId: "00000000-0000-4000-8000-000000000000", uptimeS: 60 },
    gps: {
      status: "no_fix",
      gpsd: "connected",
      receivers: 1,
      lastReportAgeMs: 400,
      lastValidFixAgeMs: null,
      lastValidFixCapturedAtMs: null,
    },
    network: { status: "unknown", detail: null, lastCheckedAtMs: null, lastOnlineAtMs: null },
    backend: { status: "unconfigured", detail: null, lastOkAtMs: null },
    outbox: { pending: 0, acknowledged: 0, rejected: 0, oldestPendingCapturedAtMs: null },
    run: null,
    recorder: { fault: null },
    ...overrides,
  };
}

export function observed(s: DeviceSnapshot | null, elapsedMs = 0, pollFailed = false): Observed {
  return { snapshot: s, elapsedMs: s === null ? null : elapsedMs, pollFailed };
}
