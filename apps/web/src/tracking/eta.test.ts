import { ETA_VALID_FOR_MS, type MyRunResult, POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { myAlertsReady, myPreferenceDefault, myRunReady } from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { type Instant, queryClock, type ServerClock, verifiedClock } from "./clock";
import { alertsSnapshot, preferenceSnapshot, runSnapshot } from "./mapping";
import type { TrackedRun } from "./model";
import { alertRow, etaView, stopProgressText } from "./presentation";

const ready = myRunReady as Extract<MyRunResult, { status: "ready" }>;
const eta = ready.run.eta!;
const CAPTURED = ready.run.lastPosition!.capturedAtMs;

function verifiedAt(serverNowMs: number, instant: Instant): ServerClock {
  const clock = verifiedClock(instant, instant, serverNowMs);
  if (!clock) throw new Error("sample rejected");
  return clock;
}

function runWith(patch: Partial<(typeof ready)["run"]> = {}): TrackedRun {
  const snap = runSnapshot({ ...ready, run: { ...ready.run, ...patch } });
  if (snap.kind !== "ready") throw new Error("not ready");
  return snap.run;
}

/** Verified server time `offsetMs` after the fixture position was captured. */
function at(offsetMs: number): { clock: ServerClock; now: Instant } {
  const now: Instant = { wallMs: CAPTURED + offsetMs, monoMs: 50_000 };
  return { clock: verifiedAt(CAPTURED + offsetMs, now), now };
}

describe("ETA display (docs/08 §8, docs/10 §4)", () => {
  it("shows the estimate with the time it was made", () => {
    const { clock, now } = at(15_000);
    const view = etaView(runWith(), clock, now, "UTC");
    expect(view).not.toBeNull();
    expect(view!.headline).toBe("About 6 min");
    expect(view!.madeText).toBe("Estimate made 14s ago");
    expect(view!.arrivalText).toBe(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(eta.arrivalAtMs));
  });

  it("is never shown before verified time exists", () => {
    const now: Instant = { wallMs: CAPTURED + 5_000, monoMs: 1 };
    expect(etaView(runWith(), queryClock(CAPTURED + 5_000, now.wallMs), now)).toBeNull();
  });

  it("disappears at validUntilMs even with no new update", () => {
    const before = at(ETA_VALID_FOR_MS - 1_000);
    expect(etaView(runWith(), before.clock, before.now)).not.toBeNull();
    const end = at(eta.validUntilMs - CAPTURED);
    expect(etaView(runWith(), end.clock, end.now)).toBeNull();
  });

  it("is withheld when the position is stale, even if the server sent a long validity", () => {
    const long = runWith({ eta: { ...eta, validUntilMs: CAPTURED + 10 * 60_000 } });
    const stale = at(POSITION_STALE_AFTER_MS);
    expect(etaView(long, stale.clock, stale.now)).toBeNull();
  });

  it("is withheld when it was not made from the position on screen", () => {
    const { clock, now } = at(5_000);
    expect(etaView(runWith({ eta: { ...eta, sourceEventId: "other-event" } }), clock, now)).toBeNull();
  });

  it("is withheld once the run has ended or the stop is reached", () => {
    const { clock, now } = at(5_000);
    expect(etaView(runWith({ state: "completed" }), clock, now)).toBeNull();
    expect(etaView(runWith({ state: "cancelled" }), clock, now)).toBeNull();
    const atStop = runWith({ assignedStop: { ...ready.run.assignedStop, status: "at_stop" } });
    expect(etaView(atStop, clock, now)).toBeNull();
    expect(stopProgressText(atStop)).toBe("The bus is at your stop.");
    const passed = runWith({ assignedStop: { ...ready.run.assignedStop, status: "passed" } });
    expect(stopProgressText(passed)).toBe("The bus has passed your stop.");
  });

  it("never counts below one minute into a false 'arriving now'", () => {
    const soon = runWith({ eta: { ...eta, arrivalAtMs: CAPTURED + 20_000 } });
    const { clock, now } = at(30_000);
    expect(etaView(soon, clock, now)!.headline).toBe("Less than a minute");
  });

  it("drops a malformed estimate without failing the whole run", () => {
    const run = runWith({ eta: { ...eta, validUntilMs: eta.generatedAtMs - 1 } });
    expect(run.eta).toBeNull();
    expect(run.position).not.toBeNull();
  });
});

describe("alerts inbox and preference", () => {
  it("maps the inbox and shows each alert with when its estimate was made", () => {
    const snap = alertsSnapshot(myAlertsReady);
    expect(snap.kind).toBe("ready");
    if (snap.kind !== "ready") return;
    const row = alertRow(snap.alerts[0]!, "UTC");
    expect(row.title).toBe("Bus approaching Oak & Pine");
    expect(row.detail).toMatch(/^Estimated arrival .+, from an estimate made at .+\.$/);
  });

  it("maps the default preference as off", () => {
    expect(preferenceSnapshot(myPreferenceDefault)).toEqual({
      kind: "ready",
      preference: { assignmentId: "demo_assignment_001", approachingEnabled: false, approachingMinutes: 5, updatedAtMs: null },
    });
  });
});
