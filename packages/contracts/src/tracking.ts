/**
 * Family-facing tracking contract (docs/08 §8). Signed-in students and
 * guardians call these Convex queries; the server derives access from the
 * authenticated identity, never from a caller-supplied role.
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import type { GpsStatus, RunState, SCHEMA_VERSION } from "./index.js";

/**
 * Provisional freshness policy (docs/08 §8.1, open decision in docs/17 §5).
 * A position's age is measured from `capturedAtMs` against the server-aligned
 * clock. Tune these from measured runs before a pilot.
 */
export const POSITION_AGING_AFTER_MS = 30_000;
export const POSITION_STALE_AFTER_MS = 120_000;

/** Safe reasons only: never reveal whether an unrelated record exists. */
export const ACCESS_UNAVAILABLE_REASONS = ["unauthenticated", "not_permitted"] as const;
export type AccessUnavailableReason = (typeof ACCESS_UNAVAILABLE_REASONS)[number];

export interface AccessUnavailable {
  schemaVersion: typeof SCHEMA_VERSION;
  status: "access_unavailable";
  serverNowMs: number;
  reason: AccessUnavailableReason;
}

// MARK: tracking:myAssignments

export interface AssignmentSummary {
  assignmentId: string;
  /** `self` for the student's own assignment, `guardian` for a linked student. */
  relationship: "self" | "guardian";
  studentDisplayName: string;
  routeLabel: string;
  stopLabel: string;
}

export type MyAssignmentsResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "ready";
      serverNowMs: number;
      assignments: AssignmentSummary[];
    }
  | AccessUnavailable;

// MARK: tracking:myRun

export interface LastPosition {
  eventId: string;
  capturedAtMs: number;
  receivedAtMs: number;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  headingDegrees: number | null;
  horizontalAccuracyM: number | null;
}

export const STOP_STATUSES = ["upcoming", "at_stop", "passed", "unknown"] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

export interface AssignedStop {
  stopId: string;
  label: string;
  latitude: number;
  longitude: number;
  /** `unknown` until the backend tracks route progress. */
  status: StopStatus;
}

export interface Eta {
  arrivalAtMs: number;
  generatedAtMs: number;
  validUntilMs: number;
  lowerArrivalAtMs: number | null;
  upperArrivalAtMs: number | null;
  algorithmVersion: string;
  sourceEventId: string;
}

export interface TrackedRun {
  runId: string;
  state: RunState;
  /** Nonnegative safe integer; increases each time the live position is replaced. */
  liveRevision: number;
  busLabel: string;
  /** Last time the backend heard from the bus device, or null if never. */
  lastDeviceContactAtMs: number | null;
  /** Null until device health reporting supplies it; never guessed. */
  gpsStatus: GpsStatus | null;
  lastPosition: LastPosition | null;
  nextStopId: string | null;
  assignedStop: AssignedStop;
  eta: Eta | null;
}

export type MyRunResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "ready";
      serverNowMs: number;
      assignmentId: string;
      routeVersionId: string;
      run: TrackedRun;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "no_active_run";
      serverNowMs: number;
      assignmentId: string;
      routeVersionId: string;
      run: null;
    }
  | AccessUnavailable;

// MARK: tracking:myRoute

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

/** At most this many points in `path`; larger geometry is simplified on approval. */
export const MAX_ROUTE_PATH_POINTS = 2000;

export type MyRouteResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "ready";
      serverNowMs: number;
      assignmentId: string;
      /** Cache key: geometry for one version never changes. */
      routeVersionId: string;
      routeLabel: string;
      /** The school's approved path, in travel order. */
      path: RoutePoint[];
      assignedStop: Omit<AssignedStop, "status">;
    }
  | AccessUnavailable;
