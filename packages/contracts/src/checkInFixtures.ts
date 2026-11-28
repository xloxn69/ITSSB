import type {
  AssignmentCheckInResult,
  QrCodeRequest,
  QrCodeResponse,
  RecordCheckInResult,
  RemoveAssignmentAction,
  RecordAttendanceAction,
  RosterActionResult,
  RosterRequest,
  RosterResponse,
} from "./checkIns.js";

/**
 * Canonical fictional check-in and roster fixtures (docs/08 §9.2). Fake IDs,
 * grant and people; never paste these into a real deployment. `bun run
 * fixtures` writes them to `fixtures/*.json` for the device and Swift tests.
 */

const GRANT = "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000";

export const checkInAccepted: RecordCheckInResult = {
  schemaVersion: 1,
  status: "accepted",
  serverNowMs: 1795608300000,
  requestId: "0b5b9a4e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
  runId: "demo_run_001",
  checkIn: {
    checkInId: "demo_check_in_001",
    status: "boarded",
    source: "student_qr_claim",
    recordedAtMs: 1795608300000,
    receivedAtMs: 1795608300000,
  },
};

export const checkInAlreadyRecorded: RecordCheckInResult = { ...checkInAccepted, status: "already_recorded", serverNowMs: 1795608360000 };

export const checkInRejected: RecordCheckInResult = {
  schemaVersion: 1,
  status: "rejected",
  serverNowMs: 1795608300000,
  code: "run_not_active",
  message: "This trip isn't running now.",
};

export const checkInExpired: RecordCheckInResult = {
  schemaVersion: 1,
  status: "token_problem",
  serverNowMs: 1795608300000,
  problem: "expired",
};

export const assignmentCheckInReady: AssignmentCheckInResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: 1795608400000,
  assignmentId: "demo_assignment_001",
  runId: "demo_run_001",
  checkIn: checkInAccepted.status === "accepted" ? checkInAccepted.checkIn : null,
};

export const qrCodeRequest: QrCodeRequest = {
  schemaVersion: 1,
  driverOperatingGrant: GRANT,
  purpose: "trip_check_in",
  runId: "demo_run_001",
};

export const qrCodeResponse: QrCodeResponse = {
  schemaVersion: 1,
  purpose: "trip_check_in",
  token: "EXMP-LEN0-TREA-LT0K-EN00",
  linkPath: "/checkin",
  expiresAtMs: 1795608600000,
  serverNowMs: 1795608000000,
};

export const rosterRequest: RosterRequest = { schemaVersion: 1, driverOperatingGrant: GRANT, runId: "demo_run_001" };

export const rosterResponse: RosterResponse = {
  schemaVersion: 1,
  runId: "demo_run_001",
  routeVersionId: "demo_route_version_003",
  students: [
    {
      assignmentId: "demo_assignment_002",
      studentDisplayName: "Blake Example",
      stopId: "demo_stop_001",
      stopLabel: "Oak & Pine",
      stopSequence: 0,
      seatLabel: null,
      driverNote: null,
      checkIn: null,
    },
    {
      assignmentId: "demo_assignment_001",
      studentDisplayName: "Sam Example",
      stopId: "demo_stop_002",
      stopLabel: "Maple Court",
      stopSequence: 1,
      seatLabel: "4A",
      driverNote: "Sits near the front",
      checkIn: {
        checkInId: "demo_check_in_001",
        status: "boarded",
        source: "student_qr_claim",
        recordedAtMs: 1795608300000,
        receivedAtMs: 1795608300000,
      },
    },
  ],
  // Every approved stop, with students or not (the last one has none).
  stops: [
    { stopId: "demo_stop_001", label: "Oak & Pine", sequence: 0, latitude: 34.0951, longitude: -83.9998 },
    { stopId: "demo_stop_002", label: "Maple Court", sequence: 1, latitude: 34.0978, longitude: -84.0012 },
    { stopId: "demo_stop_003", label: "Cedar Loop", sequence: 2, latitude: 34.1003, longitude: -84.0031 },
  ],
  serverNowMs: 1795608400000,
};

export const rosterActionRecordAttendance: RecordAttendanceAction = {
  schemaVersion: 1,
  requestId: "7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09",
  driverOperatingGrant: GRANT,
  capturedAtMs: 1795608500000,
  type: "recordAttendance",
  assignmentId: "demo_assignment_002",
  runId: "demo_run_001",
  status: "boarded",
};

export const rosterActionRemoveAssignment: RemoveAssignmentAction = {
  schemaVersion: 1,
  requestId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  driverOperatingGrant: GRANT,
  capturedAtMs: 1795608500000,
  type: "removeAssignment",
  assignmentId: "demo_assignment_002",
  reason: "Moved to another school",
};

export const rosterActionAccepted: RosterActionResult = {
  schemaVersion: 1,
  requestId: rosterActionRecordAttendance.requestId,
  status: "accepted",
  checkIn: {
    checkInId: "demo_check_in_002",
    status: "boarded",
    source: "staff_recorded",
    recordedAtMs: 1795608500000,
    receivedAtMs: 1795608900000,
  },
  serverNowMs: 1795608900000,
};

export const rosterActionRejected: RosterActionResult = {
  schemaVersion: 1,
  requestId: rosterActionRemoveAssignment.requestId,
  status: "rejected",
  code: "grant_not_authorized",
  message: "The driver was not authorized for this when it was recorded.",
  serverNowMs: 1795608900000,
};

export const checkInFixtureFiles = {
  "checkIns.record.accepted": checkInAccepted,
  "checkIns.record.alreadyRecorded": checkInAlreadyRecorded,
  "checkIns.record.rejected": checkInRejected,
  "checkIns.record.expired": checkInExpired,
  "checkIns.forAssignment.ready": assignmentCheckInReady,
  "qrCode.request": qrCodeRequest,
  "qrCode.response": qrCodeResponse,
  "roster.request": rosterRequest,
  "roster.response": rosterResponse,
  "rosterAction.recordAttendance.request": rosterActionRecordAttendance,
  "rosterAction.removeAssignment.request": rosterActionRemoveAssignment,
  "rosterAction.accepted": rosterActionAccepted,
  "rosterAction.rejected": rosterActionRejected,
} as const;
