import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr.js";
import { selectScreen } from "./screens.js";
import type { DeviceSnapshot } from "./snapshot.js";
import {
  type DeviceQrCode,
  QR_MODES,
  type RosterAction,
  type RosterResponse,
  checkInText,
  countdownText,
  displayCode,
  qrRemainingMs,
  qrShowable,
  rosterRows,
  SOURCE_LABELS,
  studentChangeLines,
  syncLabel,
} from "./students.js";
import { observed, snapshot } from "./testing.js";

const RUN = "demo_run_001";

function code(over: Partial<DeviceQrCode> = {}): DeviceQrCode {
  return {
    purpose: "trip_check_in",
    label: "Check in for this trip",
    token: "EXMPLEN0TREALT0KEN00",
    linkPath: "/checkin",
    expiresAtMs: 1_795_608_600_000,
    remainingMs: 600_000,
    refreshInMs: 480_000,
    runId: RUN,
    routeVersionId: "demo_route_version_003",
    refreshFailed: false,
    ...over,
  };
}

function action(over: Partial<RosterAction> = {}): RosterAction {
  return {
    requestId: "7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09",
    type: "recordAttendance",
    assignmentId: "demo_assignment_002",
    studentDisplayName: "Blake Example",
    runId: RUN,
    sync: "pending",
    result: null,
    code: null,
    problem: null,
    checkIn: null,
    capturedAtMs: 1_795_608_500_000,
    details: { status: "boarded" },
    ...over,
  };
}

const roster: RosterResponse = {
  runId: RUN,
  routeVersionId: "demo_route_version_003",
  fetchedAtMs: 1_795_608_400_000,
  ageMs: 0,
  stale: false,
  staleReason: null,
  students: [
    {
      assignmentId: "demo_assignment_001",
      studentDisplayName: "Sam Example",
      stopId: "demo_stop_002",
      stopLabel: "Maple Court",
      stopSequence: 1,
      seatLabel: "4A",
      driverNote: null,
      checkIn: {
        checkInId: "demo_check_in_001",
        status: "boarded",
        source: "student_qr_claim",
        recordedAtMs: 1_795_608_300_000,
        receivedAtMs: 1_795_608_300_000,
      },
    },
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
  ],
  actions: [],
};

describe("QR modes", () => {
  it("has two distinct, labeled purposes and never one generic code", () => {
    expect(QR_MODES.map((m) => m.label)).toEqual(["Check in for this trip", "Join this route"]);
    expect(new Set(QR_MODES.map((m) => m.purpose)).size).toBe(2);
    expect(new Set(QR_MODES.map((m) => m.screen))).toEqual(new Set(["D16", "D15"]));
    for (const m of QR_MODES) expect(m.label.trim()).not.toBe("");
  });

  it("shows the typed code in groups of four", () => {
    expect(displayCode("EXMPLEN0TREALT0KEN00")).toBe("EXMP-LEN0-TREA-LT0K-EN00");
  });
});

describe("QR expiry", () => {
  it("counts down from the device's remaining time, not the wall clock", () => {
    expect(qrRemainingMs(code(), 61_000)).toBe(539_000);
    expect(countdownText(539_000)).toBe("Expires in 8:59");
  });

  it("an expired code is not shown", () => {
    expect(qrShowable(code(), 599_999, RUN)).toBe(true);
    expect(qrShowable(code(), 600_000, RUN)).toBe(false);
    expect(qrShowable(code({ remainingMs: 0 }), 0, RUN)).toBe(false);
  });

  it("a check-in code is not shown once its run ended or changed", () => {
    expect(qrShowable(code(), 0, null)).toBe(false);
    expect(qrShowable(code(), 0, "demo_run_002")).toBe(false);
    expect(qrShowable(null, 0, RUN)).toBe(false);
  });
});

describe("roster wording", () => {
  it("names each source the way the record supports", () => {
    expect(SOURCE_LABELS).toEqual({
      student_qr_claim: "Student QR claim",
      staff_recorded: "Staff recorded",
      staff_correction: "Staff correction",
    });
    expect(checkInText(roster.students[0]?.checkIn ?? null)).toBe("Boarded · Student QR claim");
    expect(checkInText(null)).toBe("Expected · no record yet");
  });

  it("every queued change says pending, synced, or rejected with the reason", () => {
    expect(syncLabel(action())).toBe("Pending sync");
    expect(syncLabel(action({ sync: "synced", result: "accepted" }))).toBe("Synced");
    expect(syncLabel(action({ sync: "rejected", code: "grant_not_authorized", problem: "Not authorized when recorded." }))).toBe(
      "Rejected: Not authorized when recorded.",
    );
    expect(syncLabel(action({ sync: "rejected", code: "run_not_authorized", problem: null }))).toBe("Rejected: run_not_authorized");
    // An older correction or seat note than the server's current one was not applied.
    expect(syncLabel(action({ sync: "synced", result: "superseded" }))).toBe("Synced · a newer change was kept");
  });

  it("a removal is never shown as done before the server accepts it", () => {
    const removal = action({ type: "removeAssignment", assignmentId: "demo_assignment_001", studentDisplayName: "Sam Example", details: { reason: "Moved" } });
    expect(syncLabel(removal)).toBe("Removal pending sync");
    const rows = rosterRows({ ...roster, actions: [removal] });
    const sam = rows.find((r) => r.assignmentId === "demo_assignment_001");
    expect(sam?.removal).toBe("Removal pending sync");
    expect(sam?.onRoster).toBe(true);
    const rejected = rosterRows({ ...roster, actions: [{ ...removal, sync: "rejected", code: "already_removed", problem: "Already removed." }] });
    expect(rejected.find((r) => r.assignmentId === "demo_assignment_001")?.removal).toBe("Rejected: Already removed.");
  });

  it("an accepted removal stays listed as removed, off the roster", () => {
    const removal = action({ type: "removeAssignment", assignmentId: "demo_assignment_009", studentDisplayName: "Robin Example", sync: "synced", result: "accepted", details: { reason: "Moved" } });
    const rows = rosterRows({ ...roster, actions: [removal] });
    const robin = rows.find((r) => r.assignmentId === "demo_assignment_009");
    expect(robin?.onRoster).toBe(false);
    expect(robin?.removal).toBe("Removed from route · Synced");
  });

  it("a synced change's record shows before the roster catches up, and an older one does not", () => {
    const rec = { checkInId: "demo_check_in_009", status: "boarded", source: "staff_recorded", recordedAtMs: 5, receivedAtMs: 1_795_608_900_000 } as const;
    const synced = action({ sync: "synced", result: "accepted", checkIn: rec });
    expect(rosterRows({ ...roster, actions: [synced] }).find((r) => r.assignmentId === "demo_assignment_002")?.checkIn).toEqual(rec);
    const older = action({ assignmentId: "demo_assignment_001", sync: "synced", result: "already_recorded", checkIn: { ...rec, receivedAtMs: 1 } });
    expect(rosterRows({ ...roster, actions: [older] }).find((r) => r.assignmentId === "demo_assignment_001")?.checkIn?.source).toBe("student_qr_claim");
  });

  it("lists students in stop order", () => {
    expect(rosterRows(roster).map((r) => r.name)).toEqual(["Blake Example", "Sam Example"]);
  });

  it("already recorded shows the server's record, not the driver's tap", () => {
    const a = action({
      sync: "synced",
      result: "already_recorded",
      details: { status: "not_boarded" },
      checkIn: { checkInId: "demo_check_in_001", status: "boarded", source: "student_qr_claim", recordedAtMs: 1, receivedAtMs: 1 },
    });
    expect(syncLabel(a)).toBe("Synced · already recorded: Boarded · Student QR claim");
  });
});

describe("QR encoder", () => {
  it("builds a square module grid with the three finder patterns", () => {
    const m = qrMatrix("EXMP-LEN0-TREA-LT0K-EN00");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    const n = m.length;
    for (const [r, c] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      expect(m[r]?.slice(c, c + 7)).toEqual([true, true, true, true, true, true, true]);
    }
  });
});

function ready(over: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return snapshot({
    capabilities: { showQr: { available: true }, showStudents: { available: true } },
    session: { unlocked: true, driverName: "Demo Driver" },
    motion: { state: "stopped", parked: true },
    run: { runId: RUN, state: "active" },
    ...over,
  });
}

describe("student screens", () => {

  it("opens for an unlocked, parked driver during an active run", () => {
    for (const s of ["D15", "D16", "D17", "D18", "D19"] as const) expect(selectScreen(observed(ready()), s)).toBe(s);
  });

  it("a locked driver gets the unlock screen, never the roster or a code", () => {
    const o = observed(ready({ session: { unlocked: false } }));
    for (const s of ["D15", "D16", "D17", "D18", "D19"] as const) expect(selectScreen(o, s)).toBe("D04");
  });

  it("no active run, no code and no roster", () => {
    const o = observed(ready({ run: null }));
    for (const s of ["D15", "D16", "D17", "D18", "D19"] as const) expect(selectScreen(o, s)).toBe("D05");
  });

  it("moving hides the code and the roster behind the driving view", () => {
    const o = observed(ready({ motion: { state: "moving", parked: false } }));
    for (const s of ["D15", "D16", "D17", "D18", "D19"] as const) expect(selectScreen(o, s)).toBe("D13");
  });
});

describe("student changes on the dashboard", () => {
  const rejected: RosterAction = {
    requestId: "r9",
    type: "recordAttendance",
    assignmentId: "demo_assignment_002",
    studentDisplayName: "Blake Example",
    runId: RUN,
    sync: "rejected",
    result: "rejected",
    code: "grant_not_authorized",
    problem: "Ask staff to make the change.",
    checkIn: null,
    capturedAtMs: 1_795_608_000_000,
    details: { status: "boarded" },
  };

  it("names pending and rejected changes even with no run", () => {
    const lines = studentChangeLines({ pending: 2, rejected: [rejected] });
    expect(lines).toEqual([
      { level: "warn", text: "2 student changes are waiting to sync with the school server." },
      { level: "problem", text: "Blake Example: Recorded boarded · Rejected: Ask staff to make the change." },
    ]);
  });

  it("says nothing when there is nothing to report, or no data behind the lock", () => {
    expect(studentChangeLines({ pending: 0, rejected: [] })).toEqual([]);
    expect(studentChangeLines(null)).toEqual([]);
    expect(studentChangeLines(undefined)).toEqual([]);
    expect(studentChangeLines({ pending: 1, rejected: [] })[0]?.text).toBe(
      "1 student change is waiting to sync with the school server.",
    );
  });
});
