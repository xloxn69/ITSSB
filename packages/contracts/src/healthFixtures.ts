import type { DeviceHealthAccepted, DeviceHealthReport } from "./health.js";

/**
 * Canonical fictional health fixtures (docs/08 §7). `noFix` is the body a
 * Pi from before the measurement fields sends; `withMetrics` is today's. `bun run fixtures` writes
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

/** The same report from a Pi that sends the measurement fields (docs/13 §10). */
export const deviceHealthWithMetrics: DeviceHealthReport = {
  ...deviceHealthNoFix,
  uploadConsecutiveFailures: 2,
  uploadRetriesSinceStart: 17,
  lastUploadErrorClass: "http_503",
  processRssBytes: 42_225_664,
  memAvailableBytes: 1_232_457_728,
  cpuTemperatureC: 48.3,
  databaseBytes: 3_158_016,
};

export const deviceHealthAccepted: DeviceHealthAccepted = {
  schemaVersion: 1,
  status: "accepted",
  receivedAtMs: 1795609085400,
  serverNowMs: 1795609085400,
};

export const healthFixtureFiles = {
  "health.report.noFix": deviceHealthNoFix,
  "health.report.withMetrics": deviceHealthWithMetrics,
  "health.accepted": deviceHealthAccepted,
} as const;
