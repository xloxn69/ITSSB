import { describe, expect, it } from "vitest";
import { RUN_REPORT_CATEGORIES, reportedDelayText } from "../../../packages/contracts/src/runReports.js";
import { selectScreen } from "./screens.js";
import {
  expectedHere,
  REPORT_CATEGORIES,
  REPORT_MINUTES,
  type RunReport,
  reportLines,
  reportSentence,
  reportSyncText,
  type StopResponse,
  stopExplain,
  stopHeading,
} from "./stopViews.js";
import { observed, snapshot } from "./testing.js";
import { NEXT_STOP } from "./views.js";

const RUN = "demo_run_001";
const student = (id: string, name: string, stopId: string, seq: number) => ({
  assignmentId: id,
  studentDisplayName: name,
  stopId,
  stopLabel: stopId === "s1" ? "Oak & Pine" : "Maple Court",
  stopSequence: seq,
  seatLabel: null,
  driverNote: null,
  checkIn: null,
});
const oak = { stopId: "s1", label: "Oak & Pine", sequence: 0, distanceM: 12 };
const base: StopResponse = {
  runId: RUN,
  routeVersionId: "demo_route_version_003",
  students: [student("a1", "Blake Example", "s1", 0), student("a2", "Sam Example", "s2", 1)],
  stops: [
    { stopId: "s1", label: "Oak & Pine", sequence: 0 },
    { stopId: "s2", label: "Maple Court", sequence: 1 },
  ],
  fetchedAtMs: 0,
  ageMs: 0,
  stale: false,
  staleReason: null,
  actions: [],
  position: "fresh",
  nearStop: oak,
  nearestStop: oak,
  nearRadiusM: 75,
};

describe("D14 stopped at a bus stop", () => {
  it("names the stop from local GPS, never as an arrival", () => {
    expect(stopHeading(base)).toBe("Stopped near Oak & Pine");
    expect(stopExplain(base)).toContain("not an arrival record");
    for (const s of [base, { ...base, nearStop: null }, { ...base, position: "unknown" as const }]) {
      expect(stopHeading(s)).not.toMatch(/arriv|\bat /i);
    }
  });

  it("lists only the students assigned to that stop", () => {
    expect(expectedHere(base).map((r) => r.name)).toEqual(["Blake Example"]);
  });

  it("away from every stop, says so and lists nobody", () => {
    const far = { ...base, nearStop: null, nearestStop: { ...oak, distanceM: 420 } };
    expect(stopHeading(far)).toBe("Parked · not near a stop on this route");
    expect(stopExplain(far)).toBe("The nearest stop on this route is Oak & Pine, about 420 m away.");
    expect(expectedHere(far)).toEqual([]);
  });

  it("without a fix or without stop locations, claims no stop", () => {
    expect(stopHeading({ ...base, position: "unknown", nearStop: null })).toBe("Parked · position unknown");
    expect(stopHeading({ ...base, stops: [], nearStop: null, nearestStop: null })).toBe("Parked · no stop locations for this run");
  });

  it("is reachable only for an unlocked driver, parked, during the active run", () => {
    const ok = { run: { runId: RUN, state: "active" as const }, session: { unlocked: true }, motion: { state: "stopped" as const, parked: true } };
    for (const screen of ["D14", "D20"] as const) {
      expect(selectScreen(observed(snapshot(ok)), screen)).toBe(screen);
      expect(selectScreen(observed(snapshot({ ...ok, motion: { state: "moving", parked: false } })), screen)).toBe("D13");
      expect(selectScreen(observed(snapshot({ ...ok, session: { unlocked: false } })), screen)).toBe("D04");
      expect(selectScreen(observed(snapshot({ ...ok, run: null })), screen)).toBe("D05");
    }
  });
});

const report = (over: Partial<RunReport>): RunReport => ({
  requestId: "r1",
  runId: RUN,
  category: "traffic",
  minutes: 10,
  sync: "pending",
  capturedAtMs: 0,
  resolvedAtMs: null,
  attempts: 0,
  waitingReason: null,
  problem: null,
  ...over,
});

describe("D20 report a delay or issue", () => {
  it("offers exactly the contract's categories and minutes within its limits", () => {
    expect(REPORT_CATEGORIES.map((c) => c.id)).toEqual([...RUN_REPORT_CATEGORIES]);
    const minutes = REPORT_MINUTES.filter((m) => m !== null);
    expect(minutes.every((m) => m >= 1 && m <= 120)).toBe(true);
  });

  it("previews the same sentence the family apps show", () => {
    for (const c of RUN_REPORT_CATEGORIES) {
      for (const m of [null, 10]) expect(reportSentence(c, m)).toBe(reportedDelayText({ category: c, minutes: m }));
    }
  });

  it("says Sent only after the school server accepted it", () => {
    expect(reportSyncText(report({ sync: "pending" })).text).not.toContain("Sent");
    expect(reportSyncText(report({ sync: "pending" })).text).toContain("waiting to send");
    expect(reportSyncText(report({ sync: "sent" })).text).toBe("Sent to the school server");
    expect(reportSyncText(report({ sync: "refused", problem: "No." })).text).toBe("Not accepted: No.");
  });

  it("keeps waiting and refused reports on the dashboard", () => {
    const lines = reportLines([report({}), report({ requestId: "r2", sync: "refused", problem: "No." }), report({ requestId: "r3", sync: "sent" })]);
    expect(lines.map((l) => l.level)).toEqual(["warn", "problem"]);
    expect(lines[0]?.text).toBe("1 delay report is waiting to send to the school server.");
    expect(reportLines(null)).toEqual([]);
  });
});

describe("D13 next stop", () => {
  it("does not claim the device has no stops, and points to the stop screen", () => {
    expect(`${NEXT_STOP.title} ${NEXT_STOP.detail}`).not.toMatch(/no (approved )?(route )?stops/i);
    expect(NEXT_STOP.detail).toContain("At this stop");
  });
});
