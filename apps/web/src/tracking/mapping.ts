/**
 * Validates `tracking:*` wire results into domain values (docs/06 §7), with
 * the same rules as the iOS `DomainMapping`: finite numbers, coordinate
 * ranges, plausible timestamps, nonnegative accuracy, safe whole revisions.
 * A bad result becomes a `MappingError` (shown as a recoverable failure),
 * never "no trip" or an empty route.
 */
import {
  ACCESS_UNAVAILABLE_REASONS,
  type AccessUnavailableReason,
  GPS_STATUSES,
  type GpsStatus,
  MAX_FUTURE_SKEW_MS,
  RUN_STATES,
  type RunState,
  SCHEMA_VERSION,
  STOP_STATUSES,
  type StopStatus,
} from "@itssb/contracts";
import type {
  AlertsSnapshot,
  AssignedStop,
  AssignmentsSnapshot,
  Coordinate,
  LivePosition,
  Preference,
  PreferenceSnapshot,
  RouteSnapshot,
  RunEta,
  RunSnapshot,
  TrackedRun,
} from "./model";

export class MappingError extends Error {
  constructor(readonly field: string) {
    super(`Invalid tracking field: ${field}`);
    this.name = "MappingError";
  }
}

type Json = Record<string, unknown>;

function obj(value: unknown, field: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MappingError(field);
  return value as Json;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw new MappingError(field);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MappingError(field);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new MappingError(field);
  }
  return value as T;
}

export function timestamp(value: unknown, field: string): number {
  const ms = num(value, field);
  if (ms <= 0 || ms > Number.MAX_SAFE_INTEGER) throw new MappingError(field);
  return ms;
}

function safeWhole(value: unknown, field: string): number {
  const n = num(value, field);
  if (n < 0 || !Number.isSafeInteger(n)) throw new MappingError(field);
  return n;
}

export function coordinate(latitude: unknown, longitude: unknown): Coordinate {
  const lat = num(latitude, "latitude");
  const lon = num(longitude, "longitude");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new MappingError("coordinate");
  return { latitude: lat, longitude: lon };
}

function checkVersion(value: Json) {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new MappingError("schemaVersion");
}

function reason(value: Json): AccessUnavailableReason {
  return oneOf(value.reason, ACCESS_UNAVAILABLE_REASONS, "reason");
}

function nullableFinite(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * Null for anything that is not a believable observation, so a bad point
 * never becomes a bus marker. The rest of the run stays usable.
 */
export function position(raw: unknown, serverNowMs: number): LivePosition | null {
  try {
    const p = obj(raw, "lastPosition");
    const { latitude, longitude } = coordinate(p.latitude, p.longitude);
    const capturedAtMs = timestamp(p.capturedAtMs, "capturedAtMs");
    const receivedAtMs = timestamp(p.receivedAtMs, "receivedAtMs");
    if (capturedAtMs > serverNowMs + MAX_FUTURE_SKEW_MS) return null;
    const speedMps = nullableFinite(p.speedMps);
    const headingDegrees = nullableFinite(p.headingDegrees);
    const horizontalAccuracyM = nullableFinite(p.horizontalAccuracyM);
    if (speedMps === undefined || headingDegrees === undefined || horizontalAccuracyM === undefined) return null;
    if ((speedMps ?? 0) < 0 || (horizontalAccuracyM ?? 0) < 0) return null;
    if (headingDegrees !== null && (headingDegrees < 0 || headingDegrees >= 360)) return null;
    return {
      eventId: str(p.eventId, "eventId"),
      latitude,
      longitude,
      speedMps,
      headingDegrees,
      horizontalAccuracyM,
      capturedAtMs,
      receivedAtMs,
    };
  } catch {
    return null;
  }
}

/** Null for a missing or unbelievable estimate; the rest of the run stays usable. */
export function eta(raw: unknown): RunEta | null {
  if (raw === null || raw === undefined) return null;
  try {
    const e = obj(raw, "eta");
    const arrivalAtMs = timestamp(e.arrivalAtMs, "eta.arrivalAtMs");
    const generatedAtMs = timestamp(e.generatedAtMs, "eta.generatedAtMs");
    const validUntilMs = timestamp(e.validUntilMs, "eta.validUntilMs");
    if (validUntilMs <= generatedAtMs) return null;
    return {
      arrivalAtMs,
      generatedAtMs,
      validUntilMs,
      algorithmVersion: str(e.algorithmVersion, "eta.algorithmVersion"),
      sourceEventId: str(e.sourceEventId, "eta.sourceEventId"),
    };
  } catch {
    return null;
  }
}

function stop(raw: unknown, requireStatus: boolean): AssignedStop {
  const s = obj(raw, "assignedStop");
  let status: StopStatus = "unknown";
  if (s.status !== undefined) status = oneOf(s.status, STOP_STATUSES, "assignedStop.status");
  else if (requireStatus) throw new MappingError("assignedStop.status");
  return {
    stopId: str(s.stopId, "assignedStop.stopId"),
    label: str(s.label, "assignedStop.label"),
    ...coordinate(s.latitude, s.longitude),
    status,
  };
}

function run(raw: unknown, serverNowMs: number): TrackedRun {
  const r = obj(raw, "run");
  const state: RunState = oneOf(r.state, RUN_STATES, "run.state");
  const gpsStatus: GpsStatus | null =
    r.gpsStatus === null ? null : oneOf(r.gpsStatus, GPS_STATUSES, "run.gpsStatus");
  return {
    runId: str(r.runId, "run.runId"),
    state,
    liveRevision: safeWhole(r.liveRevision, "run.liveRevision"),
    busLabel: str(r.busLabel, "run.busLabel"),
    lastDeviceContactAtMs:
      r.lastDeviceContactAtMs === null ? null : timestamp(r.lastDeviceContactAtMs, "run.lastDeviceContactAtMs"),
    gpsStatus,
    position: r.lastPosition === null ? null : position(r.lastPosition, serverNowMs),
    assignedStop: stop(r.assignedStop, true),
    nextStopId: typeof r.nextStopId === "string" ? r.nextStopId : null,
    eta: eta(r.eta),
  };
}

export function runSnapshot(raw: unknown): RunSnapshot {
  const env = obj(raw, "myRun");
  checkVersion(env);
  switch (env.status) {
    case "ready": {
      const serverNowMs = timestamp(env.serverNowMs, "serverNowMs");
      return {
        kind: "ready",
        assignmentId: str(env.assignmentId, "assignmentId"),
        routeVersionId: str(env.routeVersionId, "routeVersionId"),
        run: run(env.run, serverNowMs),
        serverNowMs,
      };
    }
    case "no_active_run":
      return {
        kind: "no_active_run",
        assignmentId: str(env.assignmentId, "assignmentId"),
        routeVersionId: str(env.routeVersionId, "routeVersionId"),
      };
    case "access_unavailable":
      return { kind: "access_unavailable", reason: reason(env) };
    default:
      throw new MappingError("status");
  }
}

export function routeSnapshot(raw: unknown): RouteSnapshot {
  const env = obj(raw, "myRoute");
  checkVersion(env);
  switch (env.status) {
    case "ready": {
      if (!Array.isArray(env.path)) throw new MappingError("path");
      return {
        kind: "ready",
        route: {
          assignmentId: str(env.assignmentId, "assignmentId"),
          routeVersionId: str(env.routeVersionId, "routeVersionId"),
          routeLabel: str(env.routeLabel, "routeLabel"),
          path: env.path.map((p) => {
            const point = obj(p, "path");
            return coordinate(point.latitude, point.longitude);
          }),
          assignedStop: stop(env.assignedStop, false),
        },
      };
    }
    case "access_unavailable":
      return { kind: "access_unavailable", reason: reason(env) };
    default:
      throw new MappingError("status");
  }
}

export function assignmentsSnapshot(raw: unknown): AssignmentsSnapshot {
  const env = obj(raw, "myAssignments");
  checkVersion(env);
  switch (env.status) {
    case "ready": {
      if (!Array.isArray(env.assignments)) throw new MappingError("assignments");
      return {
        kind: "ready",
        assignments: env.assignments.map((a) => {
          const item = obj(a, "assignments");
          return {
            assignmentId: str(item.assignmentId, "assignments.assignmentId"),
            relationship: oneOf(item.relationship, ["self", "guardian"] as const, "assignments.relationship"),
            studentDisplayName: str(item.studentDisplayName, "assignments.studentDisplayName"),
            routeLabel: str(item.routeLabel, "assignments.routeLabel"),
            stopLabel: str(item.stopLabel, "assignments.stopLabel"),
          };
        }),
      };
    }
    case "access_unavailable":
      return { kind: "access_unavailable", reason: reason(env) };
    default:
      throw new MappingError("status");
  }
}

export function alertsSnapshot(raw: unknown): AlertsSnapshot {
  const env = obj(raw, "myAlerts");
  checkVersion(env);
  switch (env.status) {
    case "ready": {
      if (!Array.isArray(env.alerts)) throw new MappingError("alerts");
      return {
        kind: "ready",
        alerts: env.alerts.map((a) => {
          const item = obj(a, "alerts");
          oneOf(item.type, ["approaching"] as const, "alerts.type");
          return {
            alertId: str(item.alertId, "alerts.alertId"),
            assignmentId: str(item.assignmentId, "alerts.assignmentId"),
            runId: str(item.runId, "alerts.runId"),
            stopLabel: str(item.stopLabel, "alerts.stopLabel"),
            createdAtMs: timestamp(item.createdAtMs, "alerts.createdAtMs"),
            predictedArrivalAtMs: timestamp(item.predictedArrivalAtMs, "alerts.predictedArrivalAtMs"),
            predictionGeneratedAtMs: timestamp(item.predictionGeneratedAtMs, "alerts.predictionGeneratedAtMs"),
          };
        }),
      };
    }
    case "access_unavailable":
      return { kind: "access_unavailable", reason: reason(env) };
    default:
      throw new MappingError("status");
  }
}

function preference(raw: unknown): Preference {
  const p = obj(raw, "preference");
  if (typeof p.approachingEnabled !== "boolean") throw new MappingError("preference.approachingEnabled");
  return {
    assignmentId: str(p.assignmentId, "preference.assignmentId"),
    approachingEnabled: p.approachingEnabled,
    approachingMinutes: safeWhole(p.approachingMinutes, "preference.approachingMinutes"),
    updatedAtMs: p.updatedAtMs === null ? null : timestamp(p.updatedAtMs, "preference.updatedAtMs"),
  };
}

/** `notifications:myPreference` and the `saved` result of `notifications:setPreferences`. */
export function preferenceSnapshot(raw: unknown): PreferenceSnapshot {
  const env = obj(raw, "myPreference");
  checkVersion(env);
  switch (env.status) {
    case "ready":
    case "saved":
      return { kind: "ready", preference: preference(env.preference) };
    case "access_unavailable":
      return { kind: "access_unavailable", reason: reason(env) };
    default:
      throw new MappingError("status");
  }
}
