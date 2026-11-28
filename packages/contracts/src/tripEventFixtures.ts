import type { RequestError } from "./index.js";
import type { EndRunRequest, StartRunRequest, TripEventAccepted } from "./tripEvents.js";

/**
 * Canonical fictional trip-event fixtures (docs/08 §6). Fake IDs and grant;
 * never paste these into a real deployment. `bun run fixtures` writes them to
 * `fixtures/*.json`; the device tests compare their wire output to them.
 */

export const startRunRequest: StartRunRequest = {
  schemaVersion: 1,
  requestId: "64869872-aaf9-4e4f-99df-621722bbac06",
  type: "startRun",
  driverOperatingGrant: "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000",
  routeVersionId: "demo_route_version_003",
  serviceDate: "2026-11-25",
  serviceTimezone: "America/New_York",
  capturedAtMs: 1795608000000,
};

export const startRunAccepted: TripEventAccepted = {
  schemaVersion: 1,
  requestId: startRunRequest.requestId,
  status: "accepted",
  runId: "demo_run_001",
  state: "active",
  startedAtMs: 1795608000200,
  endedAtMs: null,
  serverNowMs: 1795608000200,
};

export const endRunRequest: EndRunRequest = {
  schemaVersion: 1,
  requestId: "9b1f3c2e-5d4a-4e6b-8c7d-0a1b2c3d4e5f",
  type: "endRun",
  driverOperatingGrant: startRunRequest.driverOperatingGrant,
  runId: "demo_run_001",
  capturedAtMs: 1795611600000,
  lastRunSequence: 1640,
};

export const endRunAccepted: TripEventAccepted = {
  schemaVersion: 1,
  requestId: endRunRequest.requestId,
  status: "accepted",
  runId: "demo_run_001",
  state: "completed",
  startedAtMs: 1795608000200,
  endedAtMs: 1795611600300,
  serverNowMs: 1795611600300,
};

export const tripEventActiveRunConflict: RequestError = {
  schemaVersion: 1,
  error: {
    code: "ACTIVE_RUN_CONFLICT",
    message: "This bus or route already has an active run.",
    retryable: false,
  },
};

/** An end for a run staff had already cancelled (docs/08 §6). */
export const tripEventEndRunCancelled: RequestError = {
  schemaVersion: 1,
  error: {
    code: "RUN_NOT_ACTIVE",
    message: "The school cancelled this run.",
    retryable: false,
    runState: "cancelled",
    cancelledAtMs: 1795611000000,
  },
};

export const tripEventFixtureFiles = {
  "tripEvent.startRun.request": startRunRequest,
  "tripEvent.startRun.accepted": startRunAccepted,
  "tripEvent.endRun.request": endRunRequest,
  "tripEvent.endRun.accepted": endRunAccepted,
  "tripEvent.activeRunConflict": tripEventActiveRunConflict,
  "tripEvent.endRun.runCancelled": tripEventEndRunCancelled,
} as const;
