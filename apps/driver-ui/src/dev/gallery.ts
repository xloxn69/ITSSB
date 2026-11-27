/**
 * Development-only gallery of the driver screen's student states (D15–D18),
 * rendered from fictional data with the real view functions. Used by
 * `bun run screenshots`; never part of the device build (vite builds
 * index.html only). `gallery.html?state=<name>`.
 */
import { css } from "../styles.js";
import type { ScreenId } from "../screens.js";
import { correctionView, detailView, emptyStudentUi, qrView, rosterView, type StudentController, type StudentUi } from "../studentViews.js";
import { type DeviceQrCode, type RosterAction, type RosterResponse, studentChangeLines } from "../students.js";
import { dashboardView, h } from "../views.js";
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
const view = name === "dashboard-changes"
  ? dashboard()
  : name.startsWith("qr")
  ? qrView(o, ui, noop, NOW, "Route 17 Morning")
  : name.startsWith("roster")
    ? rosterView(ui, noop, NOW)
    : name === "correction"
      ? correctionView(o, ui, noop)
      : detailView(ui, noop, "Route 17 Morning");
document.getElementById("app")?.replaceChildren(view);
document.body.dataset.ready = "true";

export const GALLERY_STATES = Object.keys(states);
