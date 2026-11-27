import { DEMO_ROUTE_PATH, DEMO_ROUTE_POINTS } from "./demoRoute.js";
import {
  type ServerTimeResult,
  type MyAssignmentsResult,
  type MyRouteResult,
  type MyRunResult,
  POSITION_AGING_AFTER_MS,
  POSITION_STALE_AFTER_MS,
  ETA_VALID_FOR_MS,
} from "./tracking.js";

/**
 * Canonical fictional tracking fixtures (docs/08 §8, §10). Fake IDs, people,
 * and coordinates. `bun run fixtures` writes them to `fixtures/*.json`, which
 * the Swift tests decode; a test fails if the JSON drifts from these values.
 */

const SERVER_NOW_MS = 1795609085500;

export const myAssignmentsReady: MyAssignmentsResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  assignments: [
    {
      assignmentId: "demo_assignment_001",
      relationship: "self",
      studentDisplayName: "Sam Example",
      routeLabel: "Route 17 Morning",
      stopLabel: "Oak & Pine",
    },
  ],
};

export const myRunReady: MyRunResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  run: {
    runId: "demo_run_001",
    state: "active",
    liveRevision: 27,
    busLabel: "Bus 12",
    lastDeviceContactAtMs: 1795609085400,
    gpsStatus: "valid",
    lastPosition: {
      eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42",
      capturedAtMs: 1795609085000,
      receivedAtMs: 1795609085400,
      ...DEMO_ROUTE_POINTS.bus,
      speedMps: 7.2,
      // Direction of travel along the demo path at this point.
      headingDegrees: 130.0,
      horizontalAccuracyM: null,
    },
    nextStopId: "demo_stop_003",
    assignedStop: {
      stopId: "demo_stop_003",
      label: "Oak & Pine",
      ...DEMO_ROUTE_POINTS.assignedStop,
      status: "upcoming",
    },
    eta: {
      arrivalAtMs: 1795609445000,
      generatedAtMs: 1795609085450,
      validUntilMs: 1795609145000,
      lowerArrivalAtMs: null,
      upperArrivalAtMs: null,
      algorithmVersion: "baseline-v1",
      sourceEventId: "5fe2a60d-7c11-45b9-995d-f50192adea42",
    },
  },
};

/** Active run, but the bus has not reported a position yet. */
export const myRunReadyNoPosition: MyRunResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  run: {
    runId: "demo_run_001",
    state: "active",
    liveRevision: 0,
    busLabel: "Bus 12",
    lastDeviceContactAtMs: null,
    gpsStatus: null,
    lastPosition: null,
    nextStopId: null,
    assignedStop: {
      stopId: "demo_stop_003",
      label: "Oak & Pine",
      ...DEMO_ROUTE_POINTS.assignedStop,
      status: "unknown",
    },
    eta: null,
  },
};

/** The last position is five minutes older than the server clock. */
export const myRunStale: MyRunResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  run: {
    runId: "demo_run_001",
    state: "active",
    liveRevision: 12,
    busLabel: "Bus 12",
    lastDeviceContactAtMs: 1795608785400,
    gpsStatus: null,
    lastPosition: {
      eventId: "0b8e7f52-3f0d-4c55-9a43-1f7f3c0f2a11",
      capturedAtMs: 1795608785000,
      receivedAtMs: 1795608785400,
      ...DEMO_ROUTE_POINTS.earlierBus,
      speedMps: null,
      headingDegrees: null,
      horizontalAccuracyM: 12.5,
    },
    nextStopId: null,
    assignedStop: {
      stopId: "demo_stop_003",
      label: "Oak & Pine",
      ...DEMO_ROUTE_POINTS.assignedStop,
      status: "unknown",
    },
    eta: null,
  },
};

export const myRunNoActiveRun: MyRunResult = {
  schemaVersion: 1,
  status: "no_active_run",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  run: null,
};

export const myRunAccessUnavailable: MyRunResult = {
  schemaVersion: 1,
  status: "access_unavailable",
  serverNowMs: SERVER_NOW_MS,
  reason: "not_permitted",
};

export const myRouteReady: MyRouteResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  routeLabel: "Route 17 Morning",
  path: [...DEMO_ROUTE_PATH],
  assignedStop: {
    stopId: "demo_stop_003",
    label: "Oak & Pine",
    ...DEMO_ROUTE_POINTS.assignedStop,
  },
};

export const myRouteAccessUnavailable: MyRouteResult = {
  schemaVersion: 1,
  status: "access_unavailable",
  serverNowMs: SERVER_NOW_MS,
  reason: "unauthenticated",
};

export const serverTime: ServerTimeResult = { schemaVersion: 1, serverNowMs: SERVER_NOW_MS };

/** The provisional freshness policy, so the Swift constants can be checked against it. */
export const freshnessPolicy = {
  positionAgingAfterMs: POSITION_AGING_AFTER_MS,
  positionStaleAfterMs: POSITION_STALE_AFTER_MS,
  etaValidForMs: ETA_VALID_FOR_MS,
};

/** File name (without `.json`) → fixture. The Swift tests load these names. */
export const trackingFixtureFiles = {
  "myAssignments.ready": myAssignmentsReady,
  "myRun.ready": myRunReady,
  "myRun.readyNoPosition": myRunReadyNoPosition,
  "myRun.stale": myRunStale,
  "myRun.noActiveRun": myRunNoActiveRun,
  "myRun.accessUnavailable": myRunAccessUnavailable,
  "myRoute.ready": myRouteReady,
  "myRoute.accessUnavailable": myRouteAccessUnavailable,
  freshnessPolicy,
  serverTime,
} as const;
