import { formatDuration } from "./format.js";

/**
 * QR codes, roster and queued driver changes as the device service reports
 * them (`/api/qr-codes`, `/api/roster`, `/api/roster-actions`). Pure wording
 * and display rules; the device service and the school server decide.
 *
 * Wording follows docs/09 §7: a check-in records a claim or a staff action,
 * never a sensor reading, and a queued change is never shown as done.
 */

export type QrPurpose = "trip_check_in" | "route_enrollment";

/** The two purposes, always labeled (docs/09 §2): never one generic code. */
export const QR_MODES = [
  {
    purpose: "trip_check_in",
    label: "Check in for this trip",
    screen: "D16",
    explain: "Students scan this in the ITSSB app to record that they boarded this trip. It works for this trip only.",
  },
  {
    purpose: "route_enrollment",
    label: "Join this route",
    screen: "D15",
    explain: "Families scan this to ask to join this route. School staff review every request; scanning does not give tracking access.",
  },
] as const satisfies readonly { purpose: QrPurpose; label: string; screen: "D15" | "D16"; explain: string }[];

export type QrMode = (typeof QR_MODES)[number];

export function qrMode(purpose: QrPurpose): QrMode {
  return QR_MODES.find((m) => m.purpose === purpose) ?? QR_MODES[0];
}

export interface DeviceQrCode {
  purpose: QrPurpose;
  label: string;
  token: string;
  linkPath: string;
  expiresAtMs: number;
  /** Validity left when the device answered, on the device's own clock. */
  remainingMs: number;
  /** When to ask the device again. */
  refreshInMs: number;
  runId: string;
  routeVersionId: string | null;
  /** The device could not reach the school server and showed its cached, unexpired code. */
  refreshFailed: boolean;
}

/** Validity left, counted from when this page received the code (its monotonic clock). */
export function qrRemainingMs(code: DeviceQrCode, receivedAgoMs: number): number {
  return Math.max(0, code.remainingMs - receivedAgoMs);
}

/** A code is shown only while it is valid and its run is the active run. */
export function qrShowable(code: DeviceQrCode | null, receivedAgoMs: number, activeRunId: string | null): boolean {
  if (code === null || activeRunId === null || code.runId !== activeRunId) return false;
  return qrRemainingMs(code, receivedAgoMs) > 0;
}

export function countdownText(remainingMs: number): string {
  return `Expires in ${formatDuration(remainingMs)}`;
}

/** `ABCD-EFGH-…` for reading aloud and typing. */
export function displayCode(token: string): string {
  return (token.match(/.{1,4}/g) ?? []).join("-");
}

// ── Roster ───────────────────────────────────────────────────────────

export type AttendanceStatus = "boarded" | "not_boarded";
export type CheckInSource = "student_qr_claim" | "staff_recorded" | "staff_correction";

export interface CheckIn {
  checkInId: string;
  status: AttendanceStatus;
  source: CheckInSource;
  recordedAtMs: number;
  receivedAtMs: number;
}

export interface RosterStudent {
  assignmentId: string;
  studentDisplayName: string;
  stopId: string;
  stopLabel: string;
  stopSequence: number;
  seatLabel: string | null;
  driverNote: string | null;
  checkIn: CheckIn | null;
}

export type ActionType = "recordAttendance" | "correctAttendance" | "setSeatNote" | "removeAssignment";

/** One change saved on this device, with what the school server said about it. */
export interface RosterAction {
  requestId: string;
  type: ActionType;
  assignmentId: string;
  studentDisplayName: string;
  runId: string | null;
  sync: "pending" | "synced" | "rejected";
  result: "accepted" | "already_recorded" | "superseded" | "rejected" | null;
  code: string | null;
  problem: string | null;
  checkIn: CheckIn | null;
  capturedAtMs: number;
  attempts?: number;
  details: { status?: AttendanceStatus; reason?: string | null; seatLabel?: string | null; driverNote?: string | null };
}

export interface RosterResponse {
  runId: string;
  routeVersionId: string | null;
  students: RosterStudent[];
  fetchedAtMs: number;
  ageMs: number;
  stale: boolean;
  staleReason: string | null;
  actions: RosterAction[];
}

export const SOURCE_LABELS: Record<CheckInSource, string> = {
  student_qr_claim: "Student QR claim",
  staff_recorded: "Staff recorded",
  staff_correction: "Staff correction",
};

export const STATUS_WORDS: Record<AttendanceStatus, string> = { boarded: "Boarded", not_boarded: "Not boarded" };

/** The current record and where it came from. No record means expected, not absent. */
export function checkInText(c: CheckIn | null): string {
  return c ? `${STATUS_WORDS[c.status]} · ${SOURCE_LABELS[c.source]}` : "Expected · no record yet";
}

/** Sync state of one queued change, in the words the screen shows. */
export function syncLabel(a: RosterAction): string {
  if (a.sync === "pending") return a.type === "removeAssignment" ? "Removal pending sync" : "Pending sync";
  if (a.sync === "rejected") return `Rejected: ${a.problem ?? a.code ?? "no reason given"}`;
  if (a.type === "removeAssignment") return "Removed from route · Synced";
  if (a.result === "superseded") return "Synced · a newer change was kept";
  if (a.result === "already_recorded" && a.checkIn) return `Synced · already recorded: ${checkInText(a.checkIn)}`;
  return "Synced";
}

/** What the driver asked for, in a line. */
export function actionText(a: RosterAction): string {
  const d = a.details;
  switch (a.type) {
    case "recordAttendance":
      return `Recorded ${d.status ? STATUS_WORDS[d.status].toLowerCase() : "attendance"}`;
    case "correctAttendance":
      return `Corrected to ${d.status ? STATUS_WORDS[d.status].toLowerCase() : "?"}: ${d.reason ?? ""}`;
    case "setSeatNote":
      return `Seat ${d.seatLabel ?? "none"} · Note ${d.driverNote ?? "none"}`;
    case "removeAssignment":
      return `Remove from route: ${d.reason ?? ""}`;
  }
}

export interface RosterRow {
  assignmentId: string;
  name: string;
  stopLabel: string | null;
  stopSequence: number | null;
  seatLabel: string | null;
  driverNote: string | null;
  checkIn: CheckIn | null;
  /** On the roster the server last sent. False for a student this device removed. */
  onRoster: boolean;
  /** This device's changes for the student, newest first. */
  actions: RosterAction[];
  /** The latest removal's state, or null if none was asked for. */
  removal: string | null;
  /** An attendance record or correction is waiting to sync. */
  attendancePending: boolean;
}

/** Students in stop order with this device's changes attached, then removed students. */
export function rosterRows(r: RosterResponse): RosterRow[] {
  const byStudent = new Map<string, RosterAction[]>();
  for (const a of r.actions) byStudent.set(a.assignmentId, [a, ...(byStudent.get(a.assignmentId) ?? [])]);
  const rowFor = (id: string, base: Omit<RosterRow, "actions" | "removal" | "attendancePending" | "assignmentId">): RosterRow => {
    const actions = byStudent.get(id) ?? [];
    const removal = actions.find((a) => a.type === "removeAssignment");
    return {
      assignmentId: id,
      ...base,
      actions,
      removal: removal ? syncLabel(removal) : null,
      attendancePending: actions.some((a) => a.sync === "pending" && (a.type === "recordAttendance" || a.type === "correctAttendance")),
    };
  };
  const students = r.students.toSorted(
    (x, y) => x.stopSequence - y.stopSequence || x.studentDisplayName.localeCompare(y.studentDisplayName),
  );
  const rows = students.map((s) =>
    rowFor(s.assignmentId, {
      name: s.studentDisplayName,
      stopLabel: s.stopLabel,
      stopSequence: s.stopSequence,
      seatLabel: s.seatLabel,
      driverNote: s.driverNote,
      checkIn: s.checkIn,
      onRoster: true,
    }),
  );
  const listed = new Set(students.map((s) => s.assignmentId));
  for (const [id, actions] of byStudent) {
    if (listed.has(id) || actions[0] === undefined) continue;
    rows.push(
      rowFor(id, {
        name: actions[0].studentDisplayName,
        stopLabel: null,
        stopSequence: null,
        seatLabel: null,
        driverNote: null,
        checkIn: null,
        onRoster: false,
      }),
    );
  }
  return rows;
}
