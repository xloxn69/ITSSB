import { type MyRunResult, REPORTED_DELAY_SHOWN_FOR_MS } from "@itssb/contracts";
import { myRunReady, myRunReportedDelay } from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { type Instant, queryClock, type ServerClock, verifiedClock } from "./clock";
import { reportedDelayLine } from "./delay";
import { runSnapshot } from "./mapping";
import type { TrackedRun } from "./model";

type Ready = Extract<MyRunResult, { status: "ready" }>;
const fixture = myRunReportedDelay as Ready;
const REPORTED = fixture.run.reportedDelay?.reportedAtMs ?? 0;
const at: Instant = { wallMs: 10_000, monoMs: 10_000 };

function clockAt(serverNowMs: number): ServerClock {
  const c = verifiedClock(at, at, serverNowMs);
  if (!c) throw new Error("sample rejected");
  return c;
}

function runFrom(raw: unknown): TrackedRun {
  const snap = runSnapshot(raw);
  if (snap.kind !== "ready") throw new Error("not ready");
  return snap.run;
}

const withDelay = (delay: unknown): unknown => ({ ...fixture, run: { ...fixture.run, reportedDelay: delay } });

describe("reportedDelay mapping", () => {
  it("maps the fixture: category, minutes, times, source", () => {
    expect(runFrom(fixture).reportedDelay).toEqual(fixture.run.reportedDelay);
  });

  it("an older backend without the field still maps the run", () => {
    const run = runFrom(myRunReady);
    expect(run.reportedDelay).toBeNull();
    expect(run.runId).toBe("demo_run_001");
  });

  it.each([
    ["an unknown category", { ...fixture.run.reportedDelay, category: "late" }],
    ["fractional minutes", { ...fixture.run.reportedDelay, minutes: 2.5 }],
    ["a staff source this client does not know", { ...fixture.run.reportedDelay, source: "staff" }],
    ["an expiry before the report", { ...fixture.run.reportedDelay, validUntilMs: REPORTED - 1 }],
  ])("drops %s and keeps the run", (_name, bad) => {
    const run = runFrom(withDelay(bad));
    expect(run.reportedDelay).toBeNull();
    expect(run.busLabel).toBe("Bus 12");
  });

  it("never carries free text, even if a server sent some", () => {
    const run = runFrom(withDelay({ ...fixture.run.reportedDelay, explanation: "Sam Example was hurt" }));
    expect(JSON.stringify(run.reportedDelay)).not.toContain("Sam Example");
  });
});

describe("reportedDelayLine", () => {
  const run = runFrom(fixture);

  it("shows the driver's report with its age, with no ETA", () => {
    expect(run.eta).toBeNull();
    expect(reportedDelayLine(run, clockAt(REPORTED + 3 * 60_000), at)).toBe(
      "Driver reported a delay (traffic), about 10 min — reported 3 min ago",
    );
  });

  it("disappears once the server-aligned clock passes validUntilMs", () => {
    expect(reportedDelayLine(run, clockAt(REPORTED + REPORTED_DELAY_SHOWN_FOR_MS - 1), at)).not.toBeNull();
    expect(reportedDelayLine(run, clockAt(REPORTED + REPORTED_DELAY_SHOWN_FOR_MS), at)).toBeNull();
  });

  it("is never shown for a run that is not active", () => {
    expect(reportedDelayLine({ ...run, state: "completed" }, clockAt(REPORTED + 60_000), at)).toBeNull();
  });

  it("without minutes, says only the category", () => {
    const noMinutes = { ...run, reportedDelay: { ...run.reportedDelay!, minutes: null, category: "mechanical" as const } };
    expect(reportedDelayLine(noMinutes, clockAt(REPORTED + 1_000), at)).toBe(
      "Driver reported a delay (mechanical problem) — reported just now",
    );
  });

  it("is not shown on a cached result before server time is verified, even with a slow device clock", () => {
    // The cached result says the server time is a minute after the report; the
    // device clock is two hours behind, so unverified time would read as fresh.
    const cached = queryClock(REPORTED + 60_000, at.wallMs);
    const slow: Instant = { wallMs: at.wallMs - 2 * 60 * 60_000 + REPORTED_DELAY_SHOWN_FOR_MS, monoMs: at.monoMs };
    expect(reportedDelayLine(run, cached, slow)).toBeNull();
    expect(reportedDelayLine(run, cached, at)).toBeNull();
  });
});
