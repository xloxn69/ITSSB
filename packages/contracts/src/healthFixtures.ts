import type { DeviceHealthAccepted, DeviceHealthReport } from "./health.js";

/**
 * Canonical fictional health fixtures (docs/08 §7). `bun run fixtures` writes
 * them to `fixtures/*.json`; the device tests compare their wire output to
 * the request.
 */

export const deviceHealthNoFix: DeviceHealthReport = {
  schemaVersion: 1,
  bootId: "3cd44c56-c96b-4b83-a970-5414990bc25a",
  capturedAtMs: 1795609085000,
  appVersion: "0.1.0",
  runId: "demo_run_001",
  gpsStatus: "no_fix",
  lastValidFixAtMs: 1795609025000,
  pendingCount: 3,
  oldestPendingCapturedAtMs: 1795609020000,
};

export const deviceHealthAccepted: DeviceHealthAccepted = {
  schemaVersion: 1,
  status: "accepted",
  receivedAtMs: 1795609085400,
  serverNowMs: 1795609085400,
};

export const healthFixtureFiles = {
  "health.report.noFix": deviceHealthNoFix,
  "health.accepted": deviceHealthAccepted,
} as const;
