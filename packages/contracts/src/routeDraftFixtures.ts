import type {
  RouteDraftStatusRequest,
  RouteDraftStatusResponse,
  RouteDraftSubmission,
  RouteDraftSubmitResult,
} from "./routeDrafts.js";

/**
 * Canonical fictional route-draft fixtures (docs/08 §7.1). Fake IDs, grant,
 * places and coordinates; never paste these into a real deployment. `bun run
 * fixtures` writes them to `fixtures/*.json` for the device tests.
 */

const GRANT = "EXAMPLE_ONLY_NOT_A_REAL_GRANT_0000000";

export const routeDraftSubmission: RouteDraftSubmission = {
  schemaVersion: 1,
  requestId: "4f1e2d3c-5b6a-4978-8a6b-5c4d3e2f1a0b",
  driverOperatingGrant: GRANT,
  deviceDraftId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  capturedAtMs: 1795612000000,
  label: "Maple Loop Morning",
  direction: "to_school",
  startedAtMs: 1795610000000,
  finishedAtMs: 1795611800000,
  path: [
    { latitude: 34.1, longitude: -83.98, capturedAtMs: 1795610001000, gapBefore: false },
    { latitude: 34.1002, longitude: -83.9797, capturedAtMs: 1795610004000, gapBefore: false },
    { latitude: 34.1006, longitude: -83.979, capturedAtMs: 1795610020000, gapBefore: true },
  ],
  stops: [
    { label: "Example Oak Corner", latitude: 34.1002, longitude: -83.9797, capturedAtMs: 1795610004000 },
    { label: "Example School Gate", latitude: 34.1006, longitude: -83.979, capturedAtMs: 1795610020000 },
  ],
};

export const routeDraftAccepted: RouteDraftSubmitResult = {
  schemaVersion: 1,
  requestId: routeDraftSubmission.requestId,
  status: "accepted",
  draft: {
    draftId: "demo_draft_001",
    deviceDraftId: routeDraftSubmission.deviceDraftId,
    status: "submitted",
    submittedAtMs: 1795612001000,
    reviewedAtMs: null,
    decisionReason: null,
    routeVersionId: null,
  },
  serverNowMs: 1795612001000,
};

export const routeDraftRejected: RouteDraftSubmitResult = {
  schemaVersion: 1,
  requestId: routeDraftSubmission.requestId,
  status: "rejected",
  code: "grant_not_authorized",
  message: "The driver operating grant does not allow this.",
  serverNowMs: 1795612001000,
};

export const routeDraftStatusRequest: RouteDraftStatusRequest = {
  schemaVersion: 1,
  driverOperatingGrant: GRANT,
  draftIds: ["demo_draft_001", "demo_draft_002", "demo_draft_404"],
};

export const routeDraftStatusResponse: RouteDraftStatusResponse = {
  schemaVersion: 1,
  drafts: [
    {
      draftId: "demo_draft_001",
      deviceDraftId: routeDraftSubmission.deviceDraftId,
      status: "approved",
      submittedAtMs: 1795612001000,
      reviewedAtMs: 1795615600000,
      decisionReason: null,
      routeVersionId: "demo_route_version_002",
    },
    {
      draftId: "demo_draft_002",
      deviceDraftId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      status: "rejected",
      submittedAtMs: 1795612101000,
      reviewedAtMs: 1795615700000,
      decisionReason: "Stop 2 is on the wrong side of the road.",
      routeVersionId: null,
    },
    { draftId: "demo_draft_404", status: "not_found" },
  ],
  serverNowMs: 1795615800000,
};

export const routeDraftFixtureFiles = {
  "routeDraft.submit.request": routeDraftSubmission,
  "routeDraft.submit.accepted": routeDraftAccepted,
  "routeDraft.submit.rejected": routeDraftRejected,
  "routeDraft.status.request": routeDraftStatusRequest,
  "routeDraft.status.response": routeDraftStatusResponse,
} as const;
