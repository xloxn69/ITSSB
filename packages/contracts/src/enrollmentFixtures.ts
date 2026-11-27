import type {
  EnrollmentRequestResult,
  GuardianLinkRequestResult,
  MyEnrollmentRequestsResult,
  MyGuardianLinkRequestsResult,
  PreviewInvitationResult,
} from "./enrollment.js";

/**
 * Canonical fictional enrollment fixtures (docs/08 §9). Fake IDs, people
 * and places; never paste these into a real deployment. `bun run fixtures`
 * writes them to `fixtures/*.json` for the Swift decoding tests.
 */

export const previewInvitationReady: PreviewInvitationResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: 1795608000000,
  routeLabel: "Route 17 Morning",
  direction: "to_school",
  expiresAtMs: 1795694400000,
  stops: [
    { stopId: "demo_stop_001", label: "Oak & Pine", sequence: 0, instructions: "North corner" },
    { stopId: "demo_stop_002", label: "Maple Court", sequence: 1, instructions: null },
  ],
};

export const previewInvitationExpired: PreviewInvitationResult = {
  schemaVersion: 1,
  status: "token_problem",
  serverNowMs: 1795608000000,
  problem: "expired",
};

export const enrollmentRequestSubmitted: EnrollmentRequestResult = {
  schemaVersion: 1,
  status: "submitted",
  serverNowMs: 1795608000000,
  enrollmentRequestId: "demo_enrollment_request_001",
  requestStatus: "pending",
};

export const enrollmentRequestRefused: EnrollmentRequestResult = {
  schemaVersion: 1,
  status: "refused",
  serverNowMs: 1795608000000,
  code: "stop_not_eligible",
  message: "That stop isn't one of this route's approved stops.",
};

export const myEnrollmentRequestsReady: MyEnrollmentRequestsResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: 1795608000000,
  requests: [
    {
      enrollmentRequestId: "demo_enrollment_request_001",
      routeLabel: "Route 17 Morning",
      direction: "to_school",
      studentName: "Alex Fictional",
      requestedStopLabel: "Oak & Pine",
      status: "pending",
      submittedAtMs: 1795607000000,
      decidedAtMs: null,
      decisionReason: null,
    },
    {
      enrollmentRequestId: "demo_enrollment_request_002",
      routeLabel: "Route 4 Afternoon",
      direction: "from_school",
      studentName: "Alex Fictional",
      requestedStopLabel: null,
      status: "rejected",
      submittedAtMs: 1795600000000,
      decidedAtMs: 1795604000000,
      decisionReason: "Outside the service area",
    },
  ],
};

export const guardianLinkRequestSubmitted: GuardianLinkRequestResult = {
  schemaVersion: 1,
  status: "submitted",
  serverNowMs: 1795608000000,
  linkRequestId: "demo_link_request_001",
  requestStatus: "pending",
};

export const myGuardianLinkRequestsReady: MyGuardianLinkRequestsResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: 1795608000000,
  requests: [
    {
      linkRequestId: "demo_link_request_001",
      status: "pending",
      submittedAtMs: 1795607000000,
      decidedAtMs: null,
      decisionReason: null,
      studentDisplayName: null,
    },
    {
      linkRequestId: "demo_link_request_002",
      status: "approved",
      submittedAtMs: 1795500000000,
      decidedAtMs: 1795510000000,
      decisionReason: null,
      studentDisplayName: "Sam Example",
    },
  ],
};

export const enrollmentFixtureFiles = {
  "enrollment.preview.ready": previewInvitationReady,
  "enrollment.preview.expired": previewInvitationExpired,
  "enrollment.request.submitted": enrollmentRequestSubmitted,
  "enrollment.request.refused": enrollmentRequestRefused,
  "enrollment.myRequests.ready": myEnrollmentRequestsReady,
  "guardianLinks.request.submitted": guardianLinkRequestSubmitted,
  "guardianLinks.myRequests.ready": myGuardianLinkRequestsReady,
} as const;
