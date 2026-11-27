/**
 * Development-only enrollment, attendance and audit data for the staff
 * pages: fictional people and places held in memory, with the server's
 * rules mirrored loosely so each page state can be seen. The real rules live
 * in apps/backend/convex/{enrollment,guardianLinks,checkIns,routes}.ts.
 */
import type {
  AuditEntry,
  CheckInRecord,
  EnrollmentRequestForReview,
  GuardianLinkRequestForReview,
  InvitationSummary,
  RecentRun,
  RunAttendanceStudent,
  StudentSummary,
} from "@itssb/contracts";

const MIN = 60_000;
const env = (body: object) => ({ schemaVersion: 1, serverNowMs: Date.now(), ...body });
const refuse = (code: string, message: string) => env({ status: "refused", code, message });

const STOPS = [
  { stopId: "demo_stop_001", label: "Oak & Pine", sequence: 0, instructions: "North corner" },
  { stopId: "demo_stop_002", label: "Maple Court", sequence: 1, instructions: null },
  { stopId: "demo_stop_003", label: "Cedar Park", sequence: 2, instructions: null },
];

function record(partial: Partial<CheckInRecord> & Pick<CheckInRecord, "checkInId">): CheckInRecord {
  const at = Date.now() - 12 * MIN;
  return { status: "boarded", source: "student_qr_claim", recordedAtMs: at, receivedAtMs: at, ...partial };
}

export function enrollmentFixtureState(empty: boolean) {
  const now = Date.now();
  if (empty) {
    return {
      requests: [] as EnrollmentRequestForReview[],
      links: [] as GuardianLinkRequestForReview[],
      invitations: [] as InvitationSummary[],
      students: [] as StudentSummary[],
      runs: [] as RecentRun[],
      attendance: new Map<string, RunAttendanceStudent[]>(),
      audit: [] as AuditEntry[],
    };
  }
  const requests: EnrollmentRequestForReview[] = [
    {
      enrollmentRequestId: "demo_enrollment_request_001",
      routeId: "demo_route_017",
      routeLabel: "Route 17 Morning",
      direction: "to_school",
      studentName: "Alex Fictional",
      address: "12 Fictional Lane, Exampletown",
      note: "Starts next Monday.",
      requestedStopId: "demo_stop_002",
      requestedStopLabel: "Maple Court",
      eligibleStops: STOPS,
      status: "pending",
      submittedAtMs: now - 35 * MIN,
      decidedAtMs: null,
      reviewerName: null,
      decisionReason: null,
      assignmentId: null,
    },
    {
      enrollmentRequestId: "demo_enrollment_request_002",
      routeId: "demo_route_017",
      routeLabel: "Route 17 Morning",
      direction: "to_school",
      studentName: "Jamie Sample",
      address: "48 Imaginary Road, Exampletown",
      note: null,
      requestedStopId: null,
      requestedStopLabel: null,
      eligibleStops: STOPS,
      status: "pending",
      submittedAtMs: now - 3 * 60 * MIN,
      decidedAtMs: null,
      reviewerName: null,
      decisionReason: null,
      assignmentId: null,
    },
    {
      enrollmentRequestId: "demo_enrollment_request_003",
      routeId: "demo_route_004",
      routeLabel: "Route 4 Afternoon",
      direction: "from_school",
      studentName: "Robin Placeholder",
      address: "3 Nowhere Court, Exampletown",
      note: null,
      requestedStopId: null,
      requestedStopLabel: null,
      eligibleStops: [],
      status: "rejected",
      submittedAtMs: now - 2 * 24 * 60 * MIN,
      decidedAtMs: now - 24 * 60 * MIN,
      reviewerName: "Riley Staff",
      decisionReason: "Outside the service area; walking distance to school.",
      assignmentId: null,
    },
  ];
  const links: GuardianLinkRequestForReview[] = [
    {
      linkRequestId: "demo_link_request_001",
      guardianName: "Jordan Guardian",
      studentId: "demo_student_001",
      studentDisplayName: "Sam Example",
      status: "pending",
      submittedAtMs: now - 20 * MIN,
      decidedAtMs: null,
      reviewerName: null,
      decisionReason: null,
    },
  ];
  const invitations: InvitationSummary[] = [
    {
      invitationId: "demo_invitation_001",
      purpose: "route_enrollment",
      routeLabel: "Route 17 Morning",
      studentDisplayName: null,
      issuedAtMs: now - 2 * 24 * 60 * MIN,
      issuedByName: "Riley Staff",
      expiresAtMs: now + 5 * 24 * 60 * MIN,
      revoked: false,
      usedAtMs: null,
    },
    {
      invitationId: "demo_invitation_002",
      purpose: "guardian_link",
      routeLabel: null,
      studentDisplayName: "Sam Example",
      issuedAtMs: now - 24 * 60 * MIN,
      issuedByName: "Riley Staff",
      expiresAtMs: now + 6 * 24 * 60 * MIN,
      revoked: false,
      usedAtMs: now - 20 * MIN,
    },
    {
      invitationId: "demo_invitation_003",
      purpose: "route_enrollment",
      routeLabel: "Route 4 Afternoon",
      studentDisplayName: null,
      issuedAtMs: now - 40 * 24 * 60 * MIN,
      issuedByName: "Riley Staff",
      expiresAtMs: now - 10 * 24 * 60 * MIN,
      revoked: false,
      usedAtMs: null,
    },
  ];
  const students: StudentSummary[] = [
    {
      studentId: "demo_student_001",
      displayName: "Sam Example",
      hasOwnAccount: true,
      assignments: [
        { assignmentId: "demo_assignment_001", routeLabel: "Route 17 Morning", direction: "to_school", stopLabel: "Oak & Pine", status: "approved" },
      ],
      guardians: [{ guardianLinkId: "demo_link_001", guardianName: "Pat Parent", status: "approved" }],
    },
    {
      studentId: "demo_student_002",
      displayName: "Drew NoPhone",
      hasOwnAccount: false,
      assignments: [
        { assignmentId: "demo_assignment_002", routeLabel: "Route 17 Morning", direction: "to_school", stopLabel: "Maple Court", status: "approved" },
        { assignmentId: "demo_assignment_003", routeLabel: "Route 4 Afternoon", direction: "from_school", stopLabel: "Willow Lane", status: "revoked" },
      ],
      guardians: [],
    },
  ];
  const runs: RecentRun[] = [
    {
      runId: "demo_run_001",
      routeLabel: "Route 17 Morning",
      busLabel: "Bus 12",
      state: "active",
      startedAtMs: now - 22 * MIN,
      endedAtMs: null,
      assignedCount: 3,
      boardedCount: 1,
    },
    {
      runId: "demo_run_000",
      routeLabel: "Route 4 Afternoon",
      busLabel: "Bus 7",
      state: "completed",
      startedAtMs: now - 20 * 60 * MIN,
      endedAtMs: now - 19 * 60 * MIN,
      assignedCount: 2,
      boardedCount: 2,
    },
  ];
  const original = record({ checkInId: "demo_check_in_010", recordedAtMs: now - 15 * MIN, receivedAtMs: now - 15 * MIN });
  const correction = record({
    checkInId: "demo_check_in_011",
    status: "not_boarded",
    source: "staff_correction",
    recordedAtMs: now - 9 * MIN,
    receivedAtMs: now - 4 * MIN,
  });
  const attendance = new Map<string, RunAttendanceStudent[]>([
    [
      "demo_run_001",
      [
        {
          assignmentId: "demo_assignment_001",
          studentDisplayName: "Sam Example",
          stopLabel: "Oak & Pine",
          seatLabel: "4A",
          driverNote: "Sits near the front.",
          current: record({ checkInId: "demo_check_in_001" }),
          history: [{ ...record({ checkInId: "demo_check_in_001" }), recordedByName: "Sam Example", reason: null }],
        },
        {
          assignmentId: "demo_assignment_004",
          studentDisplayName: "Casey Sample",
          stopLabel: "Cedar Park",
          seatLabel: null,
          driverNote: null,
          current: correction,
          history: [
            { ...original, recordedByName: "Casey Sample", reason: null },
            { ...correction, recordedByName: "Dana Driver", reason: "Scanned at the stop but stayed home." },
          ],
        },
        {
          assignmentId: "demo_assignment_002",
          studentDisplayName: "Drew NoPhone",
          stopLabel: "Maple Court",
          seatLabel: null,
          driverNote: null,
          current: null,
          history: [],
        },
      ],
    ],
  ]);
  const audit: AuditEntry[] = [
    {
      auditId: "demo_audit_003",
      atMs: now - 4 * MIN,
      actorName: "Dana Driver",
      action: "checkIn.correct",
      resourceType: "checkIns",
      resourceId: "demo_check_in_011",
      result: "allowed",
      reason: "Scanned at the stop but stayed home.",
      source: "driver_device",
      capturedAtMs: now - 9 * MIN,
    },
    {
      auditId: "demo_audit_002",
      atMs: now - 20 * MIN,
      actorName: "Applicant (not yet approved)",
      action: "guardianLink.request",
      resourceType: "guardianLinkRequests",
      resourceId: "demo_link_request_001",
      result: "allowed",
      reason: null,
      source: "family_app",
      capturedAtMs: null,
    },
    {
      auditId: "demo_audit_001",
      atMs: now - 60 * MIN,
      actorName: "Morgan Driver",
      action: "enrollment.approve",
      resourceType: "enrollmentRequests",
      resourceId: "demo_enrollment_request_009",
      result: "denied",
      reason: null,
      source: null,
      capturedAtMs: null,
    },
  ];
  return { requests, links, invitations, students, runs, attendance, audit };
}

type State = ReturnType<typeof enrollmentFixtureState>;

export function enrollmentAnswer(state: State, name: string, args: Record<string, string>): unknown {
  switch (name) {
    case "enrollment:listRequests":
      return env({
        status: "ready",
        requests: [...state.requests.filter((r) => r.status === "pending"), ...state.requests.filter((r) => r.status !== "pending")],
      });
    case "guardianLinks:listRequests":
      return env({ status: "ready", requests: state.links });
    case "enrollment:listInvitations":
      return env({ status: "ready", invitations: state.invitations });
    case "students:list":
      return env({ status: "ready", students: state.students });
    case "checkIns:recentRuns":
      return env({ status: "ready", runs: state.runs });
    case "checkIns:runAttendance": {
      const run = state.runs.find((r) => r.runId === args.runId);
      if (!run) return env({ status: "not_found" });
      return env({
        status: "ready",
        runId: run.runId,
        routeLabel: run.routeLabel,
        runState: run.state,
        startedAtMs: run.startedAtMs,
        students: state.attendance.get(run.runId) ?? [],
      });
    }
    case "audit:list":
      return env({ status: "ready", entries: state.audit });
    default:
      return env({ status: "not_found" });
  }
}

export function enrollmentMutate(state: State, name: string, args: Record<string, string>): unknown {
  switch (name) {
    case "enrollment:approve": {
      const r = state.requests.find((x) => x.enrollmentRequestId === args.enrollmentRequestId);
      if (!r) return refuse("not_found", "That request doesn't exist.");
      if (r.status !== "pending") return refuse("already_decided", "This request has already been decided.");
      if (!r.eligibleStops.some((s) => s.stopId === args.stopId)) return refuse("stop_not_eligible", "Choose one of the route's current approved stops.");
      Object.assign(r, { status: "approved", decidedAtMs: Date.now(), reviewerName: "Riley Staff", assignmentId: "demo_assignment_new" });
      return env({ status: "approved", assignmentId: "demo_assignment_new", guardianLinkId: null });
    }
    case "enrollment:reject": {
      const r = state.requests.find((x) => x.enrollmentRequestId === args.enrollmentRequestId);
      if (!r) return refuse("not_found", "That request doesn't exist.");
      if (!args.reason?.trim()) return refuse("reason_required", "Give the family a reason.");
      Object.assign(r, { status: "rejected", decidedAtMs: Date.now(), reviewerName: "Riley Staff", decisionReason: args.reason.trim() });
      return env({ status: "rejected" });
    }
    case "guardianLinks:approve":
    case "guardianLinks:reject": {
      const r = state.links.find((x) => x.linkRequestId === args.linkRequestId);
      if (!r) return refuse("not_found", "That request doesn't exist.");
      const approved = name === "guardianLinks:approve";
      Object.assign(r, { status: approved ? "approved" : "rejected", decidedAtMs: Date.now(), reviewerName: "Riley Staff", decisionReason: args.reason ?? null });
      return env(approved ? { status: "approved", assignmentId: null, guardianLinkId: "demo_link_new" } : { status: "rejected" });
    }
    case "guardianLinks:revoke": {
      for (const s of state.students) for (const g of s.guardians) if (g.guardianLinkId === args.guardianLinkId) g.status = "revoked";
      return env({ status: "revoked" });
    }
    case "enrollment:revokeInvitation": {
      const i = state.invitations.find((x) => x.invitationId === args.invitationId);
      if (i) i.revoked = true;
      return env({ status: "revoked" });
    }
    case "routes:removeAssignment": {
      if (!args.reason?.trim()) return refuse("reason_required", "Give a reason for removing this student.");
      for (const s of state.students) for (const a of s.assignments) if (a.assignmentId === args.assignmentId) a.status = "revoked";
      return env({ status: "accepted", checkIn: null });
    }
    case "checkIns:staffRecord": {
      const row = state.attendance.get(args.runId ?? "")?.find((s) => s.assignmentId === args.assignmentId);
      if (!row) return refuse("not_found", "That student isn't on this trip.");
      if (row.current) return env({ status: "already_recorded", checkIn: row.current });
      const rec = record({ checkInId: "demo_check_in_new", status: args.status === "not_boarded" ? "not_boarded" : "boarded", source: "staff_recorded", recordedAtMs: Date.now(), receivedAtMs: Date.now() });
      row.current = rec;
      row.history.push({ ...rec, recordedByName: "Riley Staff", reason: null });
      return env({ status: "accepted", checkIn: rec });
    }
    default:
      return refuse("not_found", "Unknown action.");
  }
}

export function enrollmentAct(state: State, name: string, args: Record<string, string | number>): unknown {
  const expiresAtMs = Date.now() + Number(args.ttlMs);
  const token = "DEMX7K2M9QXR4TVW8ZPN"; // Fictional; not a real code.
  if (name === "enrollment:createRouteInvitation") {
    state.invitations.unshift({
      invitationId: `demo_invitation_${state.invitations.length + 10}`,
      purpose: "route_enrollment",
      routeLabel: args.routeId === "demo_route_004" ? "Route 4 Afternoon" : "Route 17 Morning",
      studentDisplayName: null,
      issuedAtMs: Date.now(),
      issuedByName: "Riley Staff",
      expiresAtMs,
      revoked: false,
      usedAtMs: null,
    });
  }
  return env({ status: "created", invitationId: "demo_invitation_new", token, expiresAtMs });
}
