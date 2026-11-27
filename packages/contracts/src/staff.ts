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
