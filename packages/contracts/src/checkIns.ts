/**
 * Trip check-in, roster, and driver student-management contract
 * (docs/09 §6–§9, docs/08 §9.2).
 *
 * A check-in records a claim or an action; it never proves physical
 * boarding. Every record keeps its `source`: a student's QR claim, a staff
 * (driver) record, or a staff correction.
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import type { SCHEMA_VERSION } from "./index.js";
import type { TokenProblem } from "./enrollment.js";
import type { AccessUnavailable } from "./tracking.js";

type Envelope = { schemaVersion: typeof SCHEMA_VERSION; serverNowMs: number };

export const CHECK_IN_SOURCES = ["student_qr_claim", "staff_recorded", "staff_correction"] as const;
export type CheckInSource = (typeof CHECK_IN_SOURCES)[number];

/** `boarded` is what was claimed or recorded, not a sensor reading. */
export const ATTENDANCE_STATUSES = ["boarded", "not_boarded"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** V1 records one boarding phase per run; the field leaves room for alighting. */
export const CHECK_IN_PHASES = ["boarding"] as const;
export type CheckInPhase = (typeof CHECK_IN_PHASES)[number];

/** A displayed trip challenge lasts this long; the Pi refreshes it before then. */
export const CHECK_IN_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** An enrollment invitation shown on the driver screen lasts one day. */
export const DEVICE_ENROLLMENT_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_SEAT_LABEL_LENGTH = 12;
export const MAX_DRIVER_NOTE_LENGTH = 200;
/** A queued driver action is accepted at most this long after capture. */
export const MAX_QUEUED_ACTION_AGE_MS = 24 * 60 * 60 * 1000;

export interface CheckInRecord {
  checkInId: string;
  status: AttendanceStatus;
  source: CheckInSource;
  /** When it happened: device capture time for staff actions, server time for a scan. */
  recordedAtMs: number;
  /** When the server accepted it. */
  receivedAtMs: number;
}

// MARK: checkIns:record (student)

export interface RecordCheckInArgs {
  /** UUID created once per scan; reused after a lost response. */
  requestId: string;
  token: string;
  runId: string;
}

export const CHECK_IN_REJECTIONS = [
  /** The challenge belongs to another run. */
  "wrong_run",
  /** The run has ended or not started. */
  "run_not_active",
  /** This account has no approved assignment on the run's route (guardians included). */
  "not_assigned",
  /** The same requestId was used for another run. */
  "request_id_conflict",
  "invalid_request",
] as const;
export type CheckInRejection = (typeof CHECK_IN_REJECTIONS)[number];

export type RecordCheckInResult =
  | (Envelope & {
      /** `accepted`: this scan made the record. `already_recorded`: one exists; this is it. */
      status: "accepted" | "already_recorded";
      requestId: string;
      runId: string;
      checkIn: CheckInRecord;
    })
  | (Envelope & { status: "token_problem"; problem: TokenProblem })
  | (Envelope & { status: "rejected"; code: CheckInRejection; message: string })
  | AccessUnavailable;

// MARK: checkIns:forAssignment (student or guardian)

export type AssignmentCheckInResult =
  | (Envelope & {
      status: "ready";
      assignmentId: string;
      /** The active run on the assignment's route, or null. */
      runId: string | null;
      /** The current record for that run; null if nothing is recorded. */
      checkIn: CheckInRecord | null;
    })
  | AccessUnavailable;

// MARK: Device endpoints (driver operating grant required)

/** `POST /device/v1/qr-codes`. */
export interface QrCodeRequest {
  schemaVersion: 1;
  driverOperatingGrant: string;
  purpose: "trip_check_in" | "route_enrollment";
  /** trip_check_in: the device's active run. */
  runId?: string;
  /** route_enrollment: an approved, current route version in the grant. */
  routeVersionId?: string;
}

export interface QrCodeResponse {
  schemaVersion: 1;
  purpose: "trip_check_in" | "route_enrollment";
  /** Shown as a QR code and as typed text; never logged. */
  token: string;
  /** Path for the link; the host is the deployment's (docs/08 §9). */
  linkPath: string;
  expiresAtMs: number;
  serverNowMs: number;
}

/** `POST /device/v1/roster`: the run's assigned students, for the driver screen. */
export interface RosterRequest {
  schemaVersion: 1;
  driverOperatingGrant: string;
  runId: string;
}

export interface RosterStudent {
  assignmentId: string;
  studentDisplayName: string;
  stopId: string;
  stopLabel: string;
  stopSequence: number;
  seatLabel: string | null;
  driverNote: string | null;
  checkIn: CheckInRecord | null;
}

export interface RosterResponse {
  schemaVersion: 1;
  runId: string;
  routeVersionId: string;
  /** Students in stop order. No addresses, no guardian details. */
  students: RosterStudent[];
  serverNowMs: number;
}

/** `POST /device/v1/roster-actions`: one driver action, queued on the Pi when offline. */
interface RosterActionBase {
  schemaVersion: 1;
  /** Persisted on the Pi before sending; reused on every retry. */
  requestId: string;
  driverOperatingGrant: string;
  /** When the driver did it, on the Pi clock. */
  capturedAtMs: number;
  assignmentId: string;
}

export interface RecordAttendanceAction extends RosterActionBase {
  type: "recordAttendance";
  runId: string;
  status: AttendanceStatus;
}

export interface CorrectAttendanceAction extends RosterActionBase {
  type: "correctAttendance";
  runId: string;
  status: AttendanceStatus;
  /** The record being corrected; kept, never erased. */
  correctsCheckInId: string;
  reason: string;
}

export interface SetSeatNoteAction extends RosterActionBase {
  type: "setSeatNote";
  seatLabel: string | null;
  driverNote: string | null;
}

export interface RemoveAssignmentAction extends RosterActionBase {
  type: "removeAssignment";
  reason: string;
}

export type RosterAction = RecordAttendanceAction | CorrectAttendanceAction | SetSeatNoteAction | RemoveAssignmentAction;
export const ROSTER_ACTION_TYPES = ["recordAttendance", "correctAttendance", "setSeatNote", "removeAssignment"] as const;

export const ROSTER_ACTION_REJECTIONS = [
  /** Grant unknown, revoked, another device's, expired before capture, or not covering this route. */
  "grant_not_authorized",
  /** Unknown assignment, or one outside the grant's routes (deliberately alike). */
  "assignment_not_authorized",
  "run_not_authorized",
  "already_removed",
  "correction_target_invalid",
  "capture_time_out_of_range",
  "request_id_conflict",
] as const;
export type RosterActionRejection = (typeof ROSTER_ACTION_REJECTIONS)[number];

/**
 * HTTP 200 for every validated action. The Pi keeps the action
 * "pending sync" until it reads one of these. `accepted` and
 * `already_recorded` are final success; `superseded` means a later change
 * already won; `rejected` is final failure and the Pi must show it.
 */
export type RosterActionResult =
  | {
      schemaVersion: 1;
      requestId: string;
      status: "accepted" | "already_recorded" | "superseded";
      checkIn: CheckInRecord | null;
      serverNowMs: number;
    }
  | {
      schemaVersion: 1;
      requestId: string;
      status: "rejected";
      code: RosterActionRejection;
      message: string;
      serverNowMs: number;
    };

/** Request-level errors (docs/08 §5) for these endpoints. */
export const DEVICE_ROSTER_ERROR_CODES = [
  "INVALID_REQUEST",
  "MALFORMED_JSON",
  "UNSUPPORTED_SCHEMA_VERSION",
  "UNAUTHENTICATED",
  "GRANT_NOT_AUTHORIZED",
  "RUN_NOT_AUTHORIZED",
  "BODY_TOO_LARGE",
] as const;
export type DeviceRosterErrorCode = (typeof DEVICE_ROSTER_ERROR_CODES)[number];

export const MAX_ROSTER_BODY_BYTES = 8 * 1024;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const GRANT = /^[A-Za-z0-9._~-]{32,512}$/;

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function optText(x: unknown, max: number): x is string | null {
  return x === null || (typeof x === "string" && x.trim().length > 0 && x.trim().length <= max);
}

/** Validates a roster-action body. Shape only: authority is checked by the backend. */
export function validateRosterAction(body: unknown): Checked<RosterAction> {
  if (!isObj(body)) return { ok: false, message: "Body must be an object." };
  const b = body;
  if (typeof b.requestId !== "string" || !REQUEST_ID.test(b.requestId)) return { ok: false, message: "Bad requestId." };
  if (typeof b.driverOperatingGrant !== "string" || !GRANT.test(b.driverOperatingGrant)) {
    return { ok: false, message: "Bad driverOperatingGrant." };
  }
  if (typeof b.capturedAtMs !== "number" || !Number.isSafeInteger(b.capturedAtMs) || b.capturedAtMs <= 0) {
    return { ok: false, message: "Bad capturedAtMs." };
  }
  if (typeof b.assignmentId !== "string" || !ID.test(b.assignmentId)) return { ok: false, message: "Bad assignmentId." };
  const status = (s: unknown) => (ATTENDANCE_STATUSES as readonly unknown[]).includes(s);
  const runOk = typeof b.runId === "string" && ID.test(b.runId);
  switch (b.type) {
    case "recordAttendance":
      if (!runOk || !status(b.status)) return { ok: false, message: "Bad runId or status." };
      break;
    case "correctAttendance":
      if (!runOk || !status(b.status)) return { ok: false, message: "Bad runId or status." };
      if (typeof b.correctsCheckInId !== "string" || !ID.test(b.correctsCheckInId)) {
        return { ok: false, message: "Bad correctsCheckInId." };
      }
      if (!optText(b.reason, MAX_DRIVER_NOTE_LENGTH) || b.reason === null) return { ok: false, message: "A reason is required." };
      break;
    case "setSeatNote":
      if (!optText(b.seatLabel, MAX_SEAT_LABEL_LENGTH) || !optText(b.driverNote, MAX_DRIVER_NOTE_LENGTH)) {
        return { ok: false, message: "Bad seatLabel or driverNote." };
      }
      break;
    case "removeAssignment":
      if (!optText(b.reason, MAX_DRIVER_NOTE_LENGTH) || b.reason === null) return { ok: false, message: "A reason is required." };
      break;
    default:
      return { ok: false, message: "Unknown type." };
  }
  return { ok: true, value: b as unknown as RosterAction };
}

// MARK: Staff

export interface RunAttendanceStudent {
  assignmentId: string;
  studentDisplayName: string;
  stopLabel: string;
  seatLabel: string | null;
  driverNote: string | null;
  /** The current record (latest correction wins), or null. */
  current: CheckInRecord | null;
  /** Every record for this student and run, oldest first. */
  history: (CheckInRecord & { recordedByName: string | null; reason: string | null })[];
}

export type RunAttendanceResult =
  | (Envelope & {
      status: "ready";
      runId: string;
      routeLabel: string;
      runState: "scheduled" | "active" | "completed" | "cancelled";
      startedAtMs: number | null;
      students: RunAttendanceStudent[];
    })
  | (Envelope & { status: "not_found" })
  | AccessUnavailable;

export interface RecentRun {
  runId: string;
  routeLabel: string;
  busLabel: string | null;
  state: "scheduled" | "active" | "completed" | "cancelled";
  startedAtMs: number | null;
  endedAtMs: number | null;
  assignedCount: number;
  boardedCount: number;
}

export type RecentRunsResult = (Envelope & { status: "ready"; runs: RecentRun[] }) | AccessUnavailable;

export type StaffActionResult =
  | (Envelope & { status: "accepted" | "already_recorded"; checkIn: CheckInRecord | null })
  | (Envelope & { status: "refused"; code: "not_found" | "run_not_active" | "reason_required" | "already_removed" | "correction_target_invalid"; message: string })
  | AccessUnavailable;
