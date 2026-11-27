/**
 * Staff console contract (docs/08 §11). Staff web ↔ backend only: the Pi
 * and the iOS app never call these. Every function resolves the caller from
 * the authenticated identity and requires the `staff` role on the server; a
 * browser path such as `/staff` is not access control (docs/12 §1).
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import type { SCHEMA_VERSION } from "./index.js";
import type { AccessUnavailable, RoutePoint } from "./tracking.js";

export const ROUTE_DIRECTIONS = ["to_school", "from_school"] as const;
export type RouteDirection = (typeof ROUTE_DIRECTIONS)[number];

export const DRAFT_STATUSES = ["submitted", "approved", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Consecutive recorded points farther apart than this are flagged as a gap. */
export const ROUTE_GAP_WARNING_M = 100;
/** A stop farther than this from every path point is flagged. */
export const STOP_OFF_PATH_WARNING_M = 150;

type Ready<T> = { schemaVersion: typeof SCHEMA_VERSION; status: "ready"; serverNowMs: number } & T;

// MARK: routes:list

export interface ApprovedVersionSummary {
  routeVersionId: string;
  /** Null for versions created before route review existed. */
  versionNumber: number | null;
  approvedAtMs: number | null;
  approvedByName: string | null;
  effectiveFromMs: number | null;
  stopCount: number;
}

export interface RouteSummary {
  routeId: string;
  label: string;
  direction: RouteDirection;
  /** The version a new run pins; null until the first approval. */
  currentVersion: ApprovedVersionSummary | null;
}

export type ListRoutesResult = Ready<{ routes: RouteSummary[] }> | AccessUnavailable;

// MARK: routes:listDrafts, routes:getDraft

export interface DraftSummary {
  draftId: string;
  /** The route this draft revises, or null for a new route. */
  routeId: string | null;
  label: string;
  direction: RouteDirection;
  status: DraftStatus;
  submittedAtMs: number;
  pointCount: number;
  stopCount: number;
  reviewedAtMs: number | null;
  reviewerName: string | null;
  decisionReason: string | null;
  approvedVersionId: string | null;
}

export const ROUTE_CHECK_CODES = [
  "too_few_points",
  "too_many_points",
  "invalid_coordinate",
  "no_stops",
  "path_gap",
  "stop_off_path",
] as const;
export type RouteCheckCode = (typeof ROUTE_CHECK_CODES)[number];

/** A validation result shown before approval. `blocking` prevents approval. */
export interface RouteCheck {
  code: RouteCheckCode;
  severity: "blocking" | "warning";
  message: string;
}

export interface DraftStop extends RoutePoint {
  /** Travel order, from 0. */
  sequence: number;
  label: string;
  instructions: string | null;
}

export interface DraftDetail extends DraftSummary {
  path: RoutePoint[];
  stops: DraftStop[];
  checks: RouteCheck[];
}

export type ListDraftsResult = Ready<{ drafts: DraftSummary[] }> | AccessUnavailable;

export type GetDraftResult =
  | Ready<{ draft: DraftDetail }>
  | { schemaVersion: typeof SCHEMA_VERSION; status: "not_found"; serverNowMs: number }
  | AccessUnavailable;

// MARK: routes:approveDraft, routes:rejectDraft

export const REVIEW_REFUSAL_CODES = [
  /** No such draft. */
  "not_found",
  /** Already rejected (or, for reject, already approved). */
  "already_decided",
  /** A blocking check failed; see `routes:getDraft`. */
  "blocking_checks",
  /**
   * Approved assignments still point at the route's current version, and
   * assignment migration does not exist yet. Approving would leave those
   * families without a visible trip, so it is refused.
   */
  "route_has_assignments",
  /** A revision's direction differs from its route's; record it as a new route instead. */
  "direction_mismatch",
  /** Reject needs a reason. */
  "reason_required",
] as const;
export type ReviewRefusalCode = (typeof REVIEW_REFUSAL_CODES)[number];

export type ReviewRefused = {
  schemaVersion: typeof SCHEMA_VERSION;
  status: "refused";
  serverNowMs: number;
  code: ReviewRefusalCode;
  message: string;
};

export type ApproveDraftResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      /** Also returned when the draft was already approved: approval is idempotent. */
      status: "approved";
      serverNowMs: number;
      routeId: string;
      routeVersionId: string;
      versionNumber: number;
    }
  | ReviewRefused
  | AccessUnavailable;

export type RejectDraftResult =
  | { schemaVersion: typeof SCHEMA_VERSION; status: "rejected"; serverNowMs: number }
  | ReviewRefused
  | AccessUnavailable;

// MARK: fleet:listDevices, fleet:setBusLabel, fleet:revokeDevice, fleet:listDrivers

export interface DeviceSummary {
  deviceId: string;
  label: string;
  busLabel: string | null;
  revoked: boolean;
  activeRun: { runId: string; routeLabel: string | null; startedAtMs: number | null } | null;
  /** Last telemetry receipt for the active run; null when unknown. Never shown as live without its age. */
  lastContactAtMs: number | null;
}

export type ListDevicesResult = Ready<{ devices: DeviceSummary[] }> | AccessUnavailable;

/** Bus labels are family-facing; at most this many characters. */
export const MAX_BUS_LABEL_LENGTH = 40;

export type FleetMutationResult =
  | { schemaVersion: typeof SCHEMA_VERSION; status: "ok"; serverNowMs: number }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "refused";
      serverNowMs: number;
      code: "not_found" | "invalid_label";
      message: string;
    }
  | AccessUnavailable;

export interface DriverSummary {
  userId: string;
  displayName: string;
}

export type ListDriversResult = Ready<{ drivers: DriverSummary[] }> | AccessUnavailable;

// MARK: fleet:provisionDevice, fleet:rotateDeviceCredential (actions)

/** Internal device names ("Bench Pi"); at most this many characters. */
export const MAX_DEVICE_LABEL_LENGTH = 80;

export const CREDENTIAL_REFUSAL_CODES = ["not_found", "revoked", "invalid_label"] as const;
export type CredentialRefusalCode = (typeof CREDENTIAL_REFUSAL_CODES)[number];

/**
 * A device credential issued to the staff member who asked. `deviceSecret`
 * appears in this response only: the server keeps its SHA-256 hash, so it can
 * never be shown again. The previous secret, if any, stopped working.
 */
export type CredentialIssuedResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "issued";
      serverNowMs: number;
      deviceId: string;
      deviceSecret: string;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "refused";
      serverNowMs: number;
      code: CredentialRefusalCode;
      message: string;
    }
  | AccessUnavailable;
// MARK: fleet:diagnostics

/** Limited support view (docs/12 §11): IDs, ages, versions and queue depth, never payloads, addresses or tokens. */
export interface DeviceDiagnostics {
  deviceId: string;
  label: string;
  busLabel: string | null;
  revoked: boolean;
  activeRunId: string | null;
  /** Latest server receipt of a health heartbeat or a live position; null when none. */
  lastContactAtMs: number | null;
  /** From the device's latest heartbeat; null when it never sent one. */
  softwareVersion: string | null;
  pendingCount: number | null;
  oldestPendingCapturedAtMs: number | null;
  lastRun: { runId: string; state: "scheduled" | "active" | "completed" | "cancelled"; endedAtMs: number | null } | null;
}

export interface Diagnostics {
  deployment: {
    /** `ITSSB_RELEASE` on the deployment; null when not recorded. */
    release: string | null;
    /** `ITSSB_ENVIRONMENT` on the deployment; null when not recorded. */
    environment: string | null;
    contractSchemaVersion: number;
  };
  retention: { rawGpsDays: number; lastSweepAtMs: number | null; lastSweepDeleted: string | null };
  devices: DeviceDiagnostics[];
}

export type DiagnosticsResult = Ready<Diagnostics> | AccessUnavailable;
// MARK: runOps, calendar, maintenance (docs/12 §3, §7; docs/14 §5)

/** Reasons and notices are short, human-written, and shown to staff or families. */
export const MAX_STAFF_REASON_LENGTH = 200;
export const MAX_LATE_START_MINUTES = 240;
/** A maintenance window is a bounded period, never an open-ended outage. */
export const MAX_MAINTENANCE_MS = 12 * 60 * 60 * 1000;

/** `ok`, a refusal with a stable code, or a denial. */
export type StaffOpResult<Code extends string> =
  | { schemaVersion: typeof SCHEMA_VERSION; status: "ok"; serverNowMs: number }
  | { schemaVersion: typeof SCHEMA_VERSION; status: "refused"; serverNowMs: number; code: Code; message: string }
  | AccessUnavailable;

export const RUN_OP_REFUSAL_CODES = [
  "not_found",
  "not_active",
  "reason_required",
  "device_unavailable",
  "device_busy",
  "same_device",
] as const;
export type RunOpRefusalCode = (typeof RUN_OP_REFUSAL_CODES)[number];
export type RunOpResult = StaffOpResult<RunOpRefusalCode>;

export const SERVICE_DAY_STATUSES = ["no_service", "late_start"] as const;
export type ServiceDayStatus = (typeof SERVICE_DAY_STATUSES)[number];

/** A calendar exception. Days without one are normal operating days. */
export interface ServiceDay {
  /** `YYYY-MM-DD` in `timezone`. */
  serviceDate: string;
  timezone: string;
  status: ServiceDayStatus;
  lateStartMinutes: number | null;
  /** Family-facing notice. */
  notice: string;
  setByName: string | null;
  setAtMs: number;
}

export type ListServiceDaysResult = Ready<{ days: ServiceDay[] }> | AccessUnavailable;

export const CALENDAR_REFUSAL_CODES = [
  "past_date",
  "invalid_date",
  "invalid_timezone",
  "notice_required",
  "invalid_delay",
  "not_found",
] as const;
export type CalendarRefusalCode = (typeof CALENDAR_REFUSAL_CODES)[number];
export type CalendarResult = StaffOpResult<CalendarRefusalCode>;

export interface MaintenanceWindow {
  windowId: string;
  deviceId: string;
  deviceLabel: string;
  startsAtMs: number;
  endsAtMs: number;
  reason: string;
  scheduledByName: string | null;
}

export type ListMaintenanceResult = Ready<{ windows: MaintenanceWindow[] }> | AccessUnavailable;

export const MAINTENANCE_REFUSAL_CODES = [
  "device_unavailable",
  "device_busy",
  "invalid_window",
  "reason_required",
  "overlaps",
  "not_found",
] as const;
export type MaintenanceRefusalCode = (typeof MAINTENANCE_REFUSAL_CODES)[number];
export type MaintenanceResult = StaffOpResult<MaintenanceRefusalCode>;
