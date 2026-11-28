import { describe, expect, it } from "vitest";
import {
  cancelledBanner,
  draftFrozen,
  positionsText,
  SENT_STATES,
  submissionLabel,
  submissionStatus,
  submitBlocked,
  summaryChecks,
} from "./flows.js";
import { selectScreen } from "./screens.js";
import type { DraftSummary, SubmissionDetail } from "./snapshot.js";
import { observed, snapshot } from "./testing.js";

const base = { runId: "demo_run_001", endedAtMs: 0, endSync: "accepted", endError: null, endAttempts: 1 } as const;

describe("trip summary positions", () => {
  it("never says all accepted when some were rejected", () => {
    const t = positionsText({ ...base, positionsRecorded: 5, positionsWaiting: 0, positionsAccepted: 4, positionsRejected: 1 });
    expect(t).toContain("1 rejected");
    expect(t).not.toContain("all accepted");
  });

  it("names waiting positions", () => {
    const t = positionsText({ ...base, positionsRecorded: 3, positionsWaiting: 2, positionsAccepted: 1, positionsRejected: 0 });
    expect(t).toBe("3 recorded; 1 accepted by the school server; 2 waiting to sync.");
  });
});

describe("run cancelled by the school (docs/13 D14)", () => {
  const cancelledAtMs = 1_795_611_000_000;
  const cancelled = {
    ...base,
    endedBy: "school",
    cancelledAtMs,
    cancelNotedAtMs: cancelledAtMs + 20_000,
    endedAtMs: cancelledAtMs,
    endSync: "not_needed",
    endAttempts: 0,
    positionsRecorded: 5,
    positionsWaiting: 0,
    positionsAccepted: 3,
    positionsRejected: 2,
  } as const;
  const time = new Date(cancelledAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("tells the driver on the dashboard, with the time, until another run starts", () => {
    const o = observed(snapshot({ run: null, lastEndedRun: cancelled }));
    expect(cancelledBanner(o)?.text).toBe(`Run cancelled by the school at ${time}. This bus stopped recording it.`);
    expect(cancelledBanner(observed(snapshot({ run: { runId: "demo_run_002", state: "active" }, lastEndedRun: cancelled })))).toBeNull();
    expect(cancelledBanner(observed(snapshot({ run: null, lastEndedRun: { ...base, positionsRecorded: 1, positionsWaiting: 0 } })))).toBeNull();
  });

  it("never calls the cancelled run completed or its end synced", () => {
    const rows = summaryChecks(cancelled);
    expect(rows.map(([label]) => label)).toEqual(["Cancelled by the school", "Positions"]);
    expect(rows[0]?.[2]).toContain(`Run cancelled by the school at ${time}.`);
    expect(rows[1]?.[2]).toContain("2 rejected");
  });

  it("still shows a driver-ended run as completed", () => {
    const rows = summaryChecks({ ...base, positionsRecorded: 1, positionsWaiting: 0 });
    expect(rows.map(([label]) => label)).toEqual(["Completed on this device", "End synced", "Positions"]);
  });
});

const NOW = 1_795_612_000_000;
const detail = (over: Partial<SubmissionDetail> = {}): SubmissionDetail => ({
  requestId: "4f1e2d3c-5b6a-4978-8a6b-5c4d3e2f1a0b",
  queuedAtMs: NOW - 600_000,
  attempts: 0,
  waitingReason: null,
  code: null,
  problem: null,
  decisionReason: null,
  reviewedAtMs: null,
  reviewCheckedAtMs: null,
  ...over,
});
const draft = (submission: DraftSummary["submission"], over: Partial<SubmissionDetail> | null = {}): DraftSummary => ({
  draftId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  name: "Maple Loop Morning",
  direction: "to_school",
  status: "finished",
  submission,
  submissionDetail: submission === "not_submitted" || over === null ? null : detail(over),
  startedAtMs: NOW - 3_600_000,
  finishedAtMs: NOW - 1_800_000,
  pointCount: 120,
  gapCount: 0,
  lastPointCapturedAtMs: NOW - 1_800_000,
  stopCount: 4,
});
const parkedUnlocked = (submitRoute: { available: boolean; reason?: string } = { available: true }) =>
  observed(snapshot({ motion: { state: "stopped", parked: true }, session: { unlocked: true }, capabilities: { submitRoute } }));

describe("D10/D11 review wording", () => {
  it("never calls a draft submitted before the school server accepted it", () => {
    for (const state of ["not_submitted", "pending", "refused"] as const) {
      const words = `${submissionLabel(draft(state))} ${submissionStatus(draft(state, { attempts: 2 }), NOW).text}`;
      expect(words).not.toMatch(/Submitted\.|Awaiting approval|Approved/);
      expect(words).toContain("ot submitted");
    }
  });

  it("pending says it is saved here and how often it was tried", () => {
    const s = submissionStatus(draft("pending", { attempts: 3, waitingReason: "The school server did not accept this device's credential." }), NOW);
    expect(s.level).toBe("warn");
    expect(s.text).toContain("Saved on this device. Waiting to send");
    expect(s.text).toContain("Tried 3 times.");
    expect(s.text).toContain("credential");
  });

  it("refused names the server's reason", () => {
    const s = submissionStatus(draft("refused", { problem: "Your driver authorization had ended." }), NOW);
    expect(s).toEqual({ level: "problem", text: "Not submitted. Your driver authorization had ended." });
  });

  it("awaiting approval shows when the status was last read", () => {
    expect(submissionStatus(draft("submitted", { reviewCheckedAtMs: NOW - 180_000 }), NOW).text).toContain("Awaiting approval by school staff (checked 3 min ago)");
    expect(submissionStatus(draft("submitted", { reviewCheckedAtMs: null }), NOW).text).toContain("not checked yet");
    expect(submissionLabel(draft("submitted"))).toBe("Awaiting approval");
  });

  it("approved and rejected carry the decision, the reason and its age", () => {
    const ok = submissionStatus(draft("approved", { reviewCheckedAtMs: NOW - 5_000 }), NOW);
    expect(ok.level).toBe("ok");
    expect(ok.text).toContain("a run already started keeps its route");
    const no = submissionStatus(draft("rejected", { reviewCheckedAtMs: NOW, decisionReason: "Stop 2 is on the wrong side of the road." }), NOW);
    expect(no.level).toBe("problem");
    expect(no.text).toContain("Stop 2 is on the wrong side of the road. Record");
    expect(no.text).toContain("Record the route again");
  });

  it("only drafts the server holds open D11; anything submitted is frozen", () => {
    expect([...SENT_STATES].toSorted()).toEqual(["approved", "rejected", "submitted", "unknown"]);
    expect(draftFrozen(draft("not_submitted"))).toBe(false);
    expect(draftFrozen(draft("pending"))).toBe(true);
    expect(draftFrozen(draft("refused"))).toBe(true);
  });

  it("D11 needs an unlocked driver", () => {
    expect(selectScreen(observed(snapshot({ session: { unlocked: false } })), "D11")).toBe("D04");
    expect(selectScreen(parkedUnlocked(), "D11")).toBe("D11");
  });
});

describe("Submit for review availability", () => {
  it("is available for a finished draft with stops, unlocked and parked", () => {
    expect(submitBlocked(parkedUnlocked(), draft("not_submitted"))).toBeNull();
  });

  it("says why not, in the order a driver can fix it", () => {
    const reason = "Route review is on the school server, and this device has none set up.";
    expect(submitBlocked(parkedUnlocked({ available: false, reason }), draft("not_submitted"))).toBe(reason);
    expect(submitBlocked(parkedUnlocked(), { ...draft("not_submitted"), stopCount: 0 })).toBe("Mark at least one stop to submit.");
    expect(submitBlocked(parkedUnlocked(), { ...draft("not_submitted"), pointCount: 1 })).toContain("Too few points");
    const moving = observed(snapshot({ motion: { state: "moving", parked: false }, session: { unlocked: true }, capabilities: { submitRoute: { available: true } } }));
    expect(submitBlocked(moving, draft("not_submitted"))).toBe("Stop safely and confirm the bus is parked.");
  });
});
