import { REPORTED_DELAY_SHOWN_FOR_MS, type RunReportRequest, type RunReportResult } from "./runReports.js";
import type { MyRunResult } from "./tracking.js";
import { myRunReady } from "./trackingFixtures.js";

/**
 * Canonical fictional run-report fixtures (docs/08 §9.4). Fake IDs and
 * grant. `bun run fixtures` writes them to `fixtures/*.json` for the device
 * and Swift tests.
 */

const GRANT = "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000";

export const runReportRequest: RunReportRequest = {
  schemaVersion: 1,
  requestId: "6b5a4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
  driverOperatingGrant: GRANT,
  runId: "demo_run_001",
  capturedAtMs: 1795608900000,
  category: "traffic",
  expectedDelayMinutes: 10,
};

export const runReportAccepted: RunReportResult = {
  schemaVersion: 1,
  requestId: runReportRequest.requestId,
  status: "accepted",
  report: {
    reportId: "demo_run_report_001",
    runId: "demo_run_001",
    category: "traffic",
    expectedDelayMinutes: 10,
    capturedAtMs: 1795608900000,
    receivedAtMs: 1795608901000,
  },
  serverNowMs: 1795608901000,
};

export const runReportRejected: RunReportResult = {
  schemaVersion: 1,
  requestId: runReportRequest.requestId,
  status: "rejected",
  code: "run_not_authorized",
  message: "This device is not authorized to report on that run.",
  serverNowMs: 1795608901000,
};

/** An active run whose driver reported a traffic delay of about 10 minutes, with no ETA. */
export const myRunReportedDelay: MyRunResult =
  myRunReady.status === "ready"
    ? {
        ...myRunReady,
        run: {
          ...myRunReady.run,
          eta: null,
          reportedDelay: {
            category: "traffic",
            minutes: 10,
            reportedAtMs: 1795608900000,
            validUntilMs: 1795608900000 + REPORTED_DELAY_SHOWN_FOR_MS,
            source: "driver",
          },
        },
      }
    : myRunReady;

export const runReportFixtureFiles = {
  "runReport.request": runReportRequest,
  "runReport.accepted": runReportAccepted,
  "runReport.rejected": runReportRejected,
  "myRun.reportedDelay": myRunReportedDelay,
} as const;
