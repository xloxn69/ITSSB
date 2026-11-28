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
  serviceNotice: null,
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
  serviceNotice: null,
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
  serviceNotice: null,
};

export const myRunNoActiveRun: MyRunResult = {
  schemaVersion: 1,
  status: "no_active_run",
  serverNowMs: SERVER_NOW_MS,
  assignmentId: "demo_assignment_001",
  routeVersionId: "demo_route_version_003",
  run: null,
  endedRun: null,
  serviceNotice: null,
};

/** Local service date of the fixtures' server time, and when it ends in New York. */
const SERVICE_DATE = "2026-11-25";
const SERVICE_DATE_ENDS_MS = 1795669200000;

/** Staff cancelled today's trip; no replacement was sent. */
export const myRunCancelled: MyRunResult = {
  ...myRunNoActiveRun,
  endedRun: {
    runId: "demo_run_001",
    state: "cancelled",
    serviceDate: SERVICE_DATE,
    endedAtMs: 1795608600000,
    replacement: null,
    validUntilMs: SERVICE_DATE_ENDS_MS,
  },
  serviceNotice: null,
};

/** Staff cancelled today's trip and sent a replacement bus that has not started yet. */
export const myRunCancelledReplacementPending: MyRunResult = {
  ...myRunNoActiveRun,
  endedRun: {
    runId: "demo_run_001",
    state: "cancelled",
    serviceDate: SERVICE_DATE,
    endedAtMs: 1795608600000,
    replacement: "pending",
    validUntilMs: SERVICE_DATE_ENDS_MS,
  },
  serviceNotice: null,
};

/** Today's trip finished normally. */
export const myRunCompleted: MyRunResult = {
  ...myRunNoActiveRun,
  endedRun: {
    runId: "demo_run_001",
    state: "completed",
    serviceDate: SERVICE_DATE,
    endedAtMs: 1795607400000,
    replacement: null,
    validUntilMs: SERVICE_DATE_ENDS_MS,
  },
  serviceNotice: null,
};

/** The school calendar says there is no service today. */
export const myRunNoService: MyRunResult = {
  ...myRunNoActiveRun,
  endedRun: null,
  serviceNotice: {
    serviceDate: SERVICE_DATE,
    status: "no_service",
    lateStartMinutes: null,
    notice: "No buses today: the school is closed for a teacher workday.",
    validUntilMs: SERVICE_DATE_ENDS_MS,
  },
};

/** The school calendar says buses start late today; the trip hasn't started yet. */
export const myRunLateStart: MyRunResult = {
  ...myRunNoActiveRun,
  endedRun: null,
  serviceNotice: {
    serviceDate: SERVICE_DATE,
    status: "late_start",
    lateStartMinutes: 20,
    notice: "Buses run 20 minutes late this morning because of fog.",
    validUntilMs: SERVICE_DATE_ENDS_MS,
  },
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
  "myRun.cancelled": myRunCancelled,
  "myRun.cancelledReplacementPending": myRunCancelledReplacementPending,
  "myRun.completed": myRunCompleted,
  "myRun.noService": myRunNoService,
  "myRun.lateStart": myRunLateStart,
  "myRun.accessUnavailable": myRunAccessUnavailable,
  "myRoute.ready": myRouteReady,
  "myRoute.accessUnavailable": myRouteAccessUnavailable,
  freshnessPolicy,
  serverTime,
} as const;
