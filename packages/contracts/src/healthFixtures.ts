import type { DeviceHealthAccepted, DeviceHealthReport } from "./health.js";
import type { TelemetryResponse } from "./index.js";

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
  unconfirmedEndRunId: null,
};

export const deviceHealthAccepted: DeviceHealthAccepted = {
  schemaVersion: 1,
  status: "accepted",
  receivedAtMs: 1795609085400,
  serverNowMs: 1795609085400,
};

/** Staff cancelled the run the report named (docs/13 D14). */
export const deviceHealthAcceptedRunCancelled: DeviceHealthAccepted = {
  ...deviceHealthAccepted,
  run: { runId: "demo_run_001", state: "cancelled", cancelledAtMs: 1795609000000 },
};

/** A position for the device's own cancelled run (docs/08 §4). */
export const telemetryResponseRunCancelled: TelemetryResponse = {
  schemaVersion: 1,
  serverNowMs: 1795609085400,
  results: [
    {
      eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42",
      status: "rejected",
      code: "RUN_CANCELLED",
      message: "The school cancelled this run.",
      runState: "cancelled",
      cancelledAtMs: 1795609000000,
    },
  ],
};

export const healthFixtureFiles = {
  "health.report.noFix": deviceHealthNoFix,
  "health.report.withMetrics": deviceHealthWithMetrics,
  "health.accepted": deviceHealthAccepted,
  "health.accepted.runCancelled": deviceHealthAcceptedRunCancelled,
  "telemetry.response.runCancelled": telemetryResponseRunCancelled,
} as const;
