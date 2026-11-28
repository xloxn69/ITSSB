import { describe, expect, it } from "vitest";
import { ACTIONS, type ActionId, actionAvailability, editBlocked, selectScreen, unlockOfferedWhileStopped, unlockSubmitAllowed } from "./screens.js";
import type { CapabilitiesPart, DeviceSnapshot } from "./snapshot.js";
import { observed, snapshot } from "./testing.js";

const allCaps: CapabilitiesPart = {
  recordRoute: { available: true },
  startRoute: { available: true },
  showQr: { available: true },
  showStudents: { available: true },
};
const activeRun = { runId: "demo_run_001", state: "active" } as const;
const unlocked = { unlocked: true, driverName: "Demo Driver" };

function ready(overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return snapshot({
    capabilities: allCaps,
    session: unlocked,
    motion: { state: "stopped", parked: true },
    ...overrides,
  });
}

const ids: ActionId[] = ACTIONS.map((a) => a.id);

describe("dashboard actions", () => {
  it("keeps the four original actions, in order and wording", () => {
    expect(ACTIONS.map((a) => a.label)).toEqual(["Show QR Code", "Record Route", "Start Route", "Show Students"]);
  });

  it("all four work for an unlocked, parked driver with no run", () => {
    for (const id of ids) expect(actionAvailability(observed(ready()), id)).toEqual({ enabled: true, reason: null });
  });

  it("an older service that reports no capabilities disables everything", () => {
    for (const id of ids) expect(actionAvailability(observed(snapshot()), id).enabled).toBe(false);
  });

  it("passes the service's own reason through", () => {
    const s = ready({ capabilities: { ...allCaps, showQr: { available: false, reason: "QR service not set up." } } });
    expect(actionAvailability(observed(s), "showQr").reason).toBe("QR service not set up.");
  });

  it("cannot start a second run or record while a run is active", () => {
    const o = observed(ready({ run: activeRun }));
    expect(actionAvailability(o, "startRoute").reason).toBe("A run is already active.");
    expect(actionAvailability(o, "recordRoute").enabled).toBe(false);
  });

  it("needs an unlocked driver", () => {
    const o = observed(ready({ session: { unlocked: false } }));
    for (const id of ids) expect(actionAvailability(o, id).reason).toBe("Unlock with your driver PIN first.");
  });

  it("an unreachable service disables every action", () => {
    for (const id of ids) expect(actionAvailability(observed(ready(), 0, true), id).enabled).toBe(false);
  });
});

describe("moving-view lockout", () => {
  it("an active run that is moving forces the read-only driving view", () => {
    const o = observed(ready({ run: activeRun, motion: { state: "moving", parked: false } }));
    expect(selectScreen(o, null)).toBe("D13");
    expect(selectScreen(o, "D05")).toBe("D13");
    expect(selectScreen(o, "D21")).toBe("D13");
    expect(selectScreen(o, "D22")).toBe("D22");
  });

  it("unknown motion locks like moving, and never unlocks silently", () => {
    const unknown = observed(ready({ run: activeRun, motion: { state: "unknown", parked: false } }));
    expect(selectScreen(unknown, "D05")).toBe("D13");
    // An older service without motion data at all:
    const missing = observed(snapshot({ run: activeRun, capabilities: allCaps, session: unlocked }));
    expect(selectScreen(missing, "D05")).toBe("D13");
    for (const id of ids) expect(actionAvailability(missing, id).enabled).toBe(false);
  });

  it("a low speed without the driver's confirmed stop is not parked", () => {
    const o = observed(ready({ motion: { state: "stopped", parked: false } }));
    for (const id of ids) expect(actionAvailability(o, id).reason).toBe("Stop safely and confirm the bus is parked.");
  });

  it("a locked driver on a stopped bus mid-run can unlock, so the run can be parked and ended", () => {
    // After a lock or a service restart mid-run the session is locked; parking
    // needs an unlocked driver, so without this the bus was stuck on D13.
    const locked = { unlocked: false, driverName: null };
    const fix = (ageMs: number): DeviceSnapshot["gps"] => ({
      status: "valid",
      gpsd: "connected",
      receivers: 1,
      lastReportAgeMs: ageMs,
      lastValidFixAgeMs: ageMs,
      lastValidFixCapturedAtMs: 1_795_608_000_000 - ageMs,
    });
    const at = (ageMs: number, elapsedMs = 0, gps = fix(ageMs)) =>
      observed(ready({ run: activeRun, session: locked, gps, motion: { state: "stopped", parked: false } }), elapsedMs);
    const stopped = at(400);
    expect(unlockOfferedWhileStopped(stopped)).toBe(true);
    expect(selectScreen(stopped, "D04")).toBe("D04");
    expect(selectScreen(stopped, "D05")).toBe("D13");

    for (const state of ["moving", "unknown"] as const) {
      const o = observed(ready({ run: activeRun, session: locked, motion: { state, parked: false } }));
      expect(unlockOfferedWhileStopped(o)).toBe(false);
      expect(selectScreen(o, "D04")).toBe("D13");
    }
    // Already unlocked: the driver confirms parked instead.
    const open = observed(ready({ run: activeRun, motion: { state: "stopped", parked: false } }));
    expect(unlockOfferedWhileStopped(open)).toBe(false);
    // A stale snapshot is never trusted.
    expect(unlockOfferedWhileStopped(at(400, 10_000))).toBe(false);
    // Nor a stopped reading whose fix has aged past the device's 5 s limit,
    // counting the time since the snapshot (a stalled poll).
    expect(unlockOfferedWhileStopped(at(4_000, 1_000))).toBe(true);
    expect(unlockOfferedWhileStopped(at(4_000, 1_001))).toBe(false);
    expect(selectScreen(at(4_000, 1_001), "D04")).toBe("D13");
    expect(unlockOfferedWhileStopped(at(5_001))).toBe(false);
    // The same rule at the moment the PIN is submitted (render and tap differ).
    expect(unlockSubmitAllowed(at(4_000, 1_000))).toBe(true);
    expect(unlockSubmitAllowed(at(4_000, 1_001))).toBe(false);
    // No run, or parked: unlocking is unaffected.
    expect(unlockSubmitAllowed(observed(ready({ session: locked, motion: { state: "unknown", parked: false } })))).toBe(true);
    expect(unlockSubmitAllowed(observed(ready({ run: activeRun, session: locked })))).toBe(true);
    // No valid fix at all: never.
    expect(unlockOfferedWhileStopped(at(400, 0, { ...fix(400), status: "no_fix" as const }))).toBe(false);
  });

  it("parked with an active run opens the dashboard", () => {
    expect(selectScreen(observed(ready({ run: activeRun })), null)).toBe("D05");
  });

  it("parked is not trusted from a stale snapshot", () => {
    const o = observed(ready({ run: activeRun }), 10_000);
    expect(selectScreen(o, "D05")).toBe("D01");
  });
});

describe("startup", () => {
  it("shows the self-check until the service answers", () => {
    expect(selectScreen(observed(null), "D05")).toBe("D01");
    expect(selectScreen(observed(null, 0, true), null)).toBe("D01");
  });

  it("goes to the dashboard once it answers", () => {
    expect(selectScreen(observed(snapshot()), null)).toBe("D05");
    expect(selectScreen(observed(snapshot()), "D21")).toBe("D21");
  });
});

describe("route recording screens", () => {
  const recording = {
    draftId: "00000000-0000-4000-8000-000000000001",
    name: "Demo Route North",
    direction: "to_school",
    status: "recording",
    submission: "not_submitted",
    startedAtMs: 1_795_608_000_000,
    finishedAtMs: null,
    pointCount: 10,
    gapCount: 0,
    lastPointCapturedAtMs: 1_795_608_009_000,
    stopCount: 1,
  } as const;

  it("a recording that is moving forces the read-only recording view", () => {
    const o = observed(ready({ recording, motion: { state: "moving", parked: false } }));
    expect(selectScreen(o, null)).toBe("D08");
    expect(selectScreen(o, "D05")).toBe("D08");
    expect(selectScreen(o, "D09")).toBe("D08");
    expect(editBlocked(o)).toBe("Stop safely and confirm the bus is parked.");
  });

  it("an active run outranks recording and never shows the recording view while moving", () => {
    const o = observed(ready({ recording, run: activeRun, motion: { state: "moving", parked: false } }));
    expect(selectScreen(o, "D08")).toBe("D13");
  });

  it("parked opens editing; a locked driver is sent to unlock", () => {
    expect(selectScreen(observed(ready({ recording })), "D09")).toBe("D09");
    expect(editBlocked(observed(ready({ recording })))).toBeNull();
    const locked = observed(ready({ session: { unlocked: false } }));
    expect(selectScreen(locked, "D06")).toBe("D04");
    expect(selectScreen(locked, "D07")).toBe("D04");
  });

  it("a new recording cannot be opened while one is in progress or while not parked", () => {
    expect(selectScreen(observed(ready({ recording })), "D07")).toBe("D08");
    expect(selectScreen(observed(ready({ motion: { state: "stopped", parked: false } })), "D07")).toBe("D05");
  });

  it("Record Route reopens an in-progress recording even when not parked", () => {
    const o = observed(ready({ recording, motion: { state: "unknown", parked: false } }));
    expect(actionAvailability(o, "recordRoute").enabled).toBe(true);
    expect(actionAvailability(o, "startRoute").enabled).toBe(false);
  });
});

describe("run start and end screens", () => {
  it("preflight and end confirmation need a parked, unlocked driver", () => {
    expect(selectScreen(observed(ready()), "D12")).toBe("D12");
    expect(selectScreen(observed(ready({ motion: { state: "stopped", parked: false } })), "D12")).toBe("D05");
    expect(selectScreen(observed(ready({ session: { unlocked: false } })), "D12")).toBe("D04");
    expect(selectScreen(observed(ready({ run: activeRun })), "D23")).toBe("D23");
  });

  it("no preflight while a run is active; no end confirmation without one", () => {
    expect(selectScreen(observed(ready({ run: activeRun })), "D12")).toBe("D05");
    expect(selectScreen(observed(ready()), "D23")).toBe("D05");
  });

  it("moving during an active run never shows the end confirmation", () => {
    const o = observed(ready({ run: activeRun, motion: { state: "moving", parked: false } }));
    expect(selectScreen(o, "D23")).toBe("D13");
  });
});
