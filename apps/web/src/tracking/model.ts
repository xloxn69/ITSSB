/**
 * Validated family-tracking types (docs/06 §7, mirrored from the iOS
 * `DomainModels`). Views only see these, never the wire envelopes from
 * `@itssb/contracts`.
 */
import {
  type AccessUnavailableReason,
  type GpsStatus,
  type ReportedDelay,
  POSITION_AGING_AFTER_MS,
  POSITION_STALE_AFTER_MS,
  type RunState,
  type StopStatus,
} from "@itssb/contracts";
import { ageClockMs, type Instant, type ServerClock } from "./clock";

export type Freshness = "fresh" | "aging" | "stale";

export function freshnessForAge(ageMs: number): Freshness {
  if (ageMs < POSITION_AGING_AFTER_MS) return "fresh";
  if (ageMs < POSITION_STALE_AFTER_MS) return "aging";
  return "stale";
}

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** The bus's last accepted observation. Age is always measured from `capturedAtMs`. */
export interface LivePosition extends Coordinate {
  eventId: string;
  speedMps: number | null;
  headingDegrees: number | null;
  horizontalAccuracyM: number | null;
  capturedAtMs: number;
  receivedAtMs: number;
}

/** Never negative. */
export function positionAgeMs(position: LivePosition, clock: ServerClock, now: Instant): number {
  return Math.max(0, ageClockMs(clock, now) - position.capturedAtMs);
}

/**
 * The one place freshness is decided. Without verified server time a cached
 * snapshot and a slow browser clock can both understate age, so it is never
 * `fresh` (docs/08 §8.1).
 */
export function positionFreshness(position: LivePosition, clock: ServerClock, now: Instant): Freshness {
  const freshness = freshnessForAge(positionAgeMs(position, clock, now));
  return clock.kind !== "verified" && freshness === "fresh" ? "aging" : freshness;
}

export interface AssignedStop extends Coordinate {
  stopId: string;
  label: string;
  status: StopStatus;
}

/** A server arrival estimate (docs/08 §8). Shown only through `etaView`, which ages it. */
export interface RunEta {
  arrivalAtMs: number;
  generatedAtMs: number;
  validUntilMs: number;
  algorithmVersion: string;
  /** The position it was computed from; must be the one on screen. */
  sourceEventId: string;
}

export interface TrackedRun {
  runId: string;
  state: RunState;
  liveRevision: number;
  busLabel: string;
  lastDeviceContactAtMs: number | null;
  gpsStatus: GpsStatus | null;
  /** Null when the bus has not reported, or its report failed validation. Never invented. */
  position: LivePosition | null;
  assignedStop: AssignedStop;
  nextStopId: string | null;
  /** Null when absent or malformed; never repaired or guessed. */
  eta: RunEta | null;
  /** The driver's delay report (docs/08 §9.4); absent from older backends. Never an ETA. */
  reportedDelay?: ReportedDelay | null;
}

/** Today's finished trip on this route (docs/08 §8). Never has a position. */
export interface EndedRun {
  runId: string;
  state: "completed" | "cancelled";
  serviceDate: string;
  endedAtMs: number | null;
  /** `pending`: the school sent a replacement bus that hasn't started yet. */
  replacement: "pending" | null;
  /** Hidden from the end of its service day; a query isn't re-run as time passes. */
  validUntilMs: number;
}

/** Today's service-calendar entry, district-wide (docs/12 §3). */
export interface ServiceNotice {
  serviceDate: string;
  status: "no_service" | "late_start";
  lateStartMinutes: number | null;
  notice: string;
  validUntilMs: number;
}

export interface TripNotices {
  endedRun: EndedRun | null;
  serviceNotice: ServiceNotice | null;
}

export type RunSnapshot =
  | {
      kind: "ready";
      assignmentId: string;
      routeVersionId: string;
      run: TrackedRun;
      serverNowMs: number;
      notices: TripNotices;
    }
  | { kind: "no_active_run"; assignmentId: string; routeVersionId: string; serverNowMs: number; notices: TripNotices }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason };

export interface RouteGeometry {
  assignmentId: string;
  routeVersionId: string;
  routeLabel: string;
  path: Coordinate[];
  assignedStop: AssignedStop;
}

export type RouteSnapshot =
  | { kind: "ready"; route: RouteGeometry }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason };

export interface AssignmentSummary {
  assignmentId: string;
  relationship: "self" | "guardian";
  studentDisplayName: string;
  routeLabel: string;
  stopLabel: string;
}

export type AssignmentsSnapshot =
  | { kind: "ready"; assignments: AssignmentSummary[] }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason };

export interface AlertItem {
  alertId: string;
  assignmentId: string;
  runId: string;
  stopLabel: string;
  createdAtMs: number;
  predictedArrivalAtMs: number;
  predictionGeneratedAtMs: number;
}

export type AlertsSnapshot =
  | { kind: "ready"; alerts: AlertItem[] }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason };

export interface Preference {
  assignmentId: string;
  approachingEnabled: boolean;
  approachingMinutes: number;
  updatedAtMs: number | null;
}

export type PreferenceSnapshot =
  | { kind: "ready"; preference: Preference }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason };
