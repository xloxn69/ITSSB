/**
 * Development-only gallery of the driver screen's student states (D15–D18)
 * and route review states (D06, D10, D11),
 * rendered from fictional data with the real view functions. Used by
 * `bun run screenshots`; never part of the device build (vite builds
 * index.html only). `gallery.html?state=<name>`.
 */
import { awaitingView, cancelledBanner, type Controller, libraryView, reviewView, summaryView, type UiState } from "../flows.js";
import type { DraftDetail, DraftSummary, EndedRun, SubmissionDetail } from "../snapshot.js";
import { css } from "../styles.js";
import type { ScreenId } from "../screens.js";
import { correctionView, detailView, emptyStudentUi, qrView, rosterView, type StudentController, type StudentUi } from "../studentViews.js";
import { type DeviceQrCode, type RosterAction, type RosterResponse, studentChangeLines } from "../students.js";
import type { StoragePart } from "../snapshot.js";
import { dashboardView, diagnosticsView, drivingView, h, statusBar } from "../views.js";
import { observed, snapshot } from "../testing.js";

const RUN = "demo_run_001";
const NOW = 1_795_608_600_000;
const o = observed(snapshot({ run: { runId: RUN, state: "active" }, session: { unlocked: true, driverName: "Dana Driver" } }));

const checkInCode: DeviceQrCode = {
  purpose: "trip_check_in",
  label: "Check in for this trip",
  token: "EXMPLEN0TREALT0KEN00",
  linkPath: "/checkin",
  expiresAtMs: NOW + 420_000,
  remainingMs: 420_000,
  refreshInMs: 300_000,
  runId: RUN,
  routeVersionId: "demo_route_version_003",
  refreshFailed: false,
};
const joinCode: DeviceQrCode = {
  ...checkInCode,
  purpose: "route_enrollment",
  label: "Join this route",
  token: "DEMXJ01NR0VTEC0DE000",
  linkPath: "/join",
  remainingMs: 22 * 3_600_000,
};

const at = (min: number) => NOW - min * 60_000;
const action = (over: Partial<RosterAction>): RosterAction => ({
  requestId: "req",
  type: "recordAttendance",
  assignmentId: "demo_assignment_003",
  studentDisplayName: "Drew NoPhone",
  runId: RUN,
  sync: "pending",
  result: null,
  code: null,
  problem: null,
  checkIn: null,
  capturedAtMs: at(2),
  details: { status: "boarded" },
  ...over,
});

const roster = (actions: RosterAction[], stale = false): RosterResponse => ({
  runId: RUN,
  routeVersionId: "demo_route_version_003",
  fetchedAtMs: at(stale ? 9 : 0),
  ageMs: stale ? 540_000 : 2_000,
  stale,
  staleReason: stale ? "The school server isn't answering. Showing the last roster." : null,
  actions,
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
      assignmentId: "demo_assignment_003",
      studentDisplayName: "Drew NoPhone",
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
      checkIn: { checkInId: "c1", status: "boarded", source: "student_qr_claim", recordedAtMs: at(6), receivedAtMs: at(6) },
    },
    {
      assignmentId: "demo_assignment_004",
      studentDisplayName: "Casey Sample",
      stopId: "demo_stop_003",
      stopLabel: "Cedar Park",
      stopSequence: 2,
      seatLabel: null,
      driverNote: null,
      checkIn: { checkInId: "c2", status: "not_boarded", source: "staff_correction", recordedAtMs: at(4), receivedAtMs: at(3) },
    },
  ],
});

const pending = action({ requestId: "r1" });
const synced = action({
  requestId: "r2",
  assignmentId: "demo_assignment_004",
  studentDisplayName: "Casey Sample",
  type: "correctAttendance",
  sync: "synced",
  result: "accepted",
  details: { status: "not_boarded", reason: "Scanned but stayed home" },
});
const removal = action({ requestId: "r3", type: "removeAssignment", assignmentId: "demo_assignment_002", studentDisplayName: "Blake Example", details: { reason: "Moved schools" } });
const rejected = action({
  requestId: "r4",
  type: "removeAssignment",
  assignmentId: "demo_assignment_002",
  studentDisplayName: "Blake Example",
  sync: "rejected",
  result: "rejected",
  code: "grant_not_authorized",
  problem: "The school server refused this: the driver was not authorized for it when it was recorded. Ask staff to make the change.",
  details: { reason: "Moved schools" },
});

const states: Record<string, Partial<StudentUi>> = {
  "qr-check-in": { qrPurpose: "trip_check_in", qr: checkInCode, qrAt: NOW },
  "qr-join": { qrPurpose: "route_enrollment", qr: joinCode, qrAt: NOW },
  "qr-refresh-failed": { qrPurpose: "trip_check_in", qr: { ...checkInCode, refreshFailed: true, remainingMs: 70_000 }, qrAt: NOW },
  "qr-expired": { qrPurpose: "trip_check_in", qr: { ...checkInCode, remainingMs: 0 }, qrAt: NOW },
  "qr-unavailable": { qrPurpose: "trip_check_in", qr: null, qrError: "The school server isn't answering, so no check-in code can be shown. Use Show Students to record students." },
  roster: { roster: roster([synced]), rosterAt: NOW },
  "roster-pending": { roster: roster([pending, removal]), rosterAt: NOW },
  "roster-stale": { roster: roster([pending], true), rosterAt: NOW },
  "roster-rejected": { roster: roster([rejected]), rosterAt: NOW },
  detail: { roster: roster([]), rosterAt: NOW, assignmentId: "demo_assignment_001", seat: "4A", note: "Sits near the front" },
  "detail-confirm-remove": { roster: roster([]), rosterAt: NOW, assignmentId: "demo_assignment_002", confirmRemove: true, field: "reason", reason: "Moved schools" },
  correction: { roster: roster([]), rosterAt: NOW, assignmentId: "demo_assignment_001", correctStatus: "not_boarded", field: "reason", reason: "Scanned but stayed home" },
};

const noop: StudentController = {
  go: (_s: ScreenId | null) => {},
  setStudents: () => {},
  chooseQr: () => {},
  openStudent: () => {},
  record: () => {},
  saveSeatNote: () => {},
  correct: () => {},
  remove: () => {},
};

const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
const name = new URLSearchParams(location.search).get("state") ?? "qr-check-in";
const ui: StudentUi = { ...emptyStudentUi(), ...states[name] };
const dashboard = () => {
  // After the run ended: one change still waiting, one rejected.
  const ended = observed(snapshot({ run: null, session: { unlocked: true, driverName: "Dana Driver" } , studentChanges: { pending: 1, rejected: [rejected] } }));
  const lines = studentChangeLines(ended.snapshot?.studentChanges).map((l) => h("div", { class: `banner lv-${l.level}` }, l.text));
  return dashboardView(ended, { go: () => {}, action: () => {} }, lines);
};
// D14: staff cancelled this bus's run (GPS was lost, the driver couldn't end it).
const cancelledRun: EndedRun = {
  runId: RUN,
  endedBy: "school",
  cancelledAtMs: at(4),
  cancelNotedAtMs: at(3),
  endedAtMs: at(4),
  endSync: "not_needed",
  endError: null,
  endAttempts: 0,
  positionsRecorded: 412,
  positionsWaiting: 0,
  positionsAccepted: 409,
  positionsRejected: 3,
};
const cancelledO = observed(snapshot({ run: null, session: { unlocked: true, driverName: "Dana Driver" }, lastEndedRun: cancelledRun, generatedAtMs: NOW }));
const cancelledDashboard = () => {
  const line = cancelledBanner(cancelledO);
  return dashboardView(cancelledO, { go: () => {}, action: () => {} }, line ? [h("div", { class: `banner lv-${line.level}` }, line.text)] : []);
};
// D12: low space (warning) and nearly full (critical, recording reduced), during a run.
const MB = 1_000_000;
const storageFor = (level: "warning" | "critical"): StoragePart => ({
  level,
  recording: level === "critical" ? "reduced" : "normal",
  reducedIntervalS: 60,
  disk: { level, freeBytes: level === "critical" ? 95 * MB : 410 * MB, totalBytes: 29_000 * MB, warnFreeBytes: 512 * MB, criticalFreeBytes: 128 * MB, error: null },
  queue: { level: "ok", pending: 184, warnPending: 10_000, criticalPending: 50_000 },
});
const storageScreen = (level: "warning" | "critical") => {
  const so = observed(
    snapshot({
      gps: { status: "valid", gpsd: "connected", receivers: 1, lastReportAgeMs: 300, lastValidFixAgeMs: 400, lastValidFixCapturedAtMs: NOW - 400, lastValidFixMode: 3 },
      network: { status: "offline", detail: null, lastCheckedAtMs: NOW - 2_000, lastOnlineAtMs: NOW - 900_000 },
      backend: { status: "unreachable", detail: null, lastOkAtMs: NOW - 900_000 },
      outbox: { pending: 184, acknowledged: 0, rejected: 0, oldestPendingCapturedAtMs: NOW - 900_000 },
      run: { runId: RUN, state: "active" },
      motion: { state: "moving", parked: false },
      storage: storageFor(level),
      generatedAtMs: NOW,
    }),
  );
  const nav = { go: () => {}, action: () => {} };
  return h("div", {}, statusBar(so, nav), drivingView(so, nav));
};
// ── Route review (D06, D10, D11) ──
const parkedO = observed(
  snapshot({
    generatedAtMs: NOW,
    motion: { state: "stopped", parked: true },
    session: { unlocked: true, driverName: "Dana Driver" },
    capabilities: { submitRoute: { available: true } },
  }),
);
const sub = (over: Partial<SubmissionDetail>): SubmissionDetail => ({
  requestId: "4f1e2d3c-5b6a-4978-8a6b-5c4d3e2f1a0b",
  queuedAtMs: at(40),
  attempts: 0,
  waitingReason: null,
  code: null,
  problem: null,
  decisionReason: null,
  reviewedAtMs: null,
  reviewCheckedAtMs: null,
  ...over,
});
const base: DraftDetail = {
  draftId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  name: "Maple Loop Morning",
  direction: "to_school",
  status: "finished",
  submission: "not_submitted",
  submissionDetail: null,
  startedAtMs: at(75),
  finishedAtMs: at(50),
  pointCount: 9,
  gapCount: 1,
  lastPointCapturedAtMs: at(50),
  stopCount: 3,
  path: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    capturedAtMs: at(75 - i * 3),
    latitude: 34.1 + i * 0.0006,
    longitude: -83.98 + (i > 4 ? (i - 4) * 0.0008 : 0),
    gapBefore: i === 6,
  })),
  stops: [
    { stopId: "s1", position: 1, name: "Example Oak Corner", latitude: 34.1012, longitude: -83.98, capturedAtMs: at(72) },
    { stopId: "s2", position: 2, name: "Example Elm Court", latitude: 34.1024, longitude: -83.98, capturedAtMs: at(66) },
    { stopId: "s3", position: 3, name: "Example School Gate", latitude: 34.1048, longitude: -83.9768, capturedAtMs: at(51) },
  ],
};
const drafts: Record<string, DraftDetail> = {
  "review-draft": base,
  "review-pending": { ...base, submission: "pending", submissionDetail: sub({ attempts: 2, queuedAtMs: at(3) }) },
  "review-refused": {
    ...base,
    submission: "refused",
    submissionDetail: sub({
      code: "grant_not_authorized",
      problem: "Your driver authorization had ended or was withdrawn before this reached the school server. Unlock with your PIN and submit again.",
    }),
  },
  "review-awaiting": { ...base, submission: "submitted", submissionDetail: sub({ reviewCheckedAtMs: at(2) }) },
  "review-approved": { ...base, submission: "approved", submissionDetail: sub({ reviewCheckedAtMs: at(1), reviewedAtMs: at(12) }) },
  "review-rejected": {
    ...base,
    submission: "rejected",
    submissionDetail: sub({ reviewCheckedAtMs: at(1), reviewedAtMs: at(12), decisionReason: "Stop 2 is on the wrong side of the road." }),
  },
};
const summary = ({ path: _p, stops: _s, ...d }: DraftDetail, over: Partial<DraftSummary> = {}): DraftSummary => ({ ...d, ...over });
const library: DraftSummary[] = [
  summary(drafts["review-awaiting"]!, { name: "Maple Loop Morning" }),
  summary(drafts["review-pending"]!, { draftId: "d2", name: "Maple Loop Afternoon", direction: "from_school" }),
  summary(drafts["review-rejected"]!, { draftId: "d3", name: "Cedar Hill Morning" }),
  summary(drafts["review-approved"]!, { draftId: "d4", name: "Birch Road Morning" }),
  summary(base, { draftId: "d5", name: "Birch Road Afternoon", direction: "from_school" }),
];
const draftUi = (detail: DraftDetail | null): UiState => ({
  draftId: detail?.draftId ?? null,
  detail,
  drafts: library,
  pinDriverId: null,
  pin: "",
  name: "",
  direction: "to_school",
  renameStopId: null,
  confirmRemoveStopId: null,
  message: null,
  busy: false,
  routeVersionId: null,
});
const draftCtl: Controller = {
  go: () => {},
  set: () => {},
  unlock: () => {},
  lock: () => {},
  confirmParked: () => {},
  openDraft: () => {},
  startRecording: () => {},
  markStop: () => {},
  finish: () => {},
  submitDraft: () => {},
  refreshReview: () => {},
  renameStop: () => {},
  moveStop: () => {},
  removeStop: () => {},
  startRun: () => {},
  endRun: () => {},
};
const reviewState = (): HTMLElement => {
  if (name === "review-library") return libraryView(parkedO, draftUi(null), draftCtl);
  const d = drafts[name]!;
  const sent = d.submission === "submitted" || d.submission === "approved" || d.submission === "rejected";
  return sent ? awaitingView(parkedO, draftUi(d), draftCtl, NOW) : reviewView(parkedO, draftUi(d), draftCtl, NOW);
};

// D21 with measurements, and on a machine that cannot read them.
const diagnostics = (): HTMLElement => {
  const unavailable = name === "diagnostics-unavailable";
  const s = snapshot({
    backend: { status: "ok", detail: null, lastOkAtMs: 1_795_608_000_000 - 4_000 },
    network: { status: "online", detail: null, lastCheckedAtMs: 1_795_608_000_000 - 4_000, lastOnlineAtMs: 1_795_608_000_000 - 4_000 },
    upload: { consecutiveFailures: 0, retriesSinceStart: 6, lastErrorClass: "http_503", lastErrorAtMs: 1_795_608_000_000 - 1_260_000 },
    system: unavailable
      ? { processRssBytes: null, memAvailableBytes: null, cpuTemperatureC: null, databaseBytes: 3_158_016 }
      : { processRssBytes: 41_236_000, memAvailableBytes: 1_203_572_000, cpuTemperatureC: 48.3, databaseBytes: 3_158_016 },
  });
  return diagnosticsView(observed(s), { go: () => {}, action: () => {} });
};

const view = name.startsWith("diagnostics")
  ? diagnostics()
  : name.startsWith("review")
  ? reviewState()
  : name === "dashboard-changes"
  ? dashboard()
  : name === "dashboard-cancelled"
  ? cancelledDashboard()
  : name === "summary-cancelled"
  ? summaryView(cancelledO, draftUi(null), draftCtl)
  : name === "storage-warning" || name === "storage-critical"
  ? storageScreen(name === "storage-warning" ? "warning" : "critical")
  : name.startsWith("qr")
  ? qrView(o, ui, noop, NOW, "Route 17 Morning")
  : name.startsWith("roster")
    ? rosterView(ui, noop, NOW)
    : name === "correction"
      ? correctionView(o, ui, noop)
      : detailView(ui, noop, "Route 17 Morning");
document.getElementById("app")?.replaceChildren(view);
document.body.dataset.ready = "true";

export const GALLERY_STATES = [
  ...Object.keys(states),
  ...Object.keys(drafts),
  "review-library",
  "diagnostics-measured",
  "diagnostics-unavailable",
  "dashboard-cancelled",
  "summary-cancelled",
];
