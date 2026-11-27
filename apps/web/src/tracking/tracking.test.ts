import type { MyRunResult } from "@itssb/contracts";
import {
  myAssignmentsReady,
  myRouteReady,
  myRunAccessUnavailable,
  myRunNoActiveRun,
  myRunReady,
  myRunReadyNoPosition,
  myRunStale,
} from "@itssb/contracts/fixtures";
import { POSITION_AGING_AFTER_MS, POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { describe, expect, it } from "vitest";
import { ageClockMs, type Instant, queryClock, type ServerClock, verifiedClock } from "./clock";
import { MappingError, runSnapshot } from "./mapping";
import { freshnessForAge, positionFreshness, type TrackedRun } from "./model";
import { livePresentation, showsMarker, statusCopy, updatedText } from "./presentation";
import { SessionExpiredError, TRANSPORT_FAILURE, TrackStore, type TrackingSource } from "./store";

const ready = myRunReady as Extract<MyRunResult, { status: "ready" }>;
const CAPTURED = ready.run.lastPosition?.capturedAtMs ?? 0;

/** A verified clock whose server time equals `serverNowMs` at `at`, with no round-trip error. */
function verifiedAt(serverNowMs: number, at: Instant): ServerClock {
  const clock = verifiedClock(at, at, serverNowMs);
  if (!clock) throw new Error("sample rejected");
  return clock;
}

function runFrom(raw: MyRunResult): TrackedRun {
  const snap = runSnapshot(raw);
  if (snap.kind !== "ready") throw new Error("not ready");
  return snap.run;
}

function withRun(patch: Partial<Extract<MyRunResult, { status: "ready" }>["run"]>): MyRunResult {
  return { ...ready, run: { ...ready.run, ...patch } };
}

describe("freshness cutoffs come from the contract", () => {
  it("is fresh below aging, aging below stale, stale from the stale cutoff", () => {
    expect(freshnessForAge(POSITION_AGING_AFTER_MS - 1)).toBe("fresh");
    expect(freshnessForAge(POSITION_AGING_AFTER_MS)).toBe("aging");
    expect(freshnessForAge(POSITION_STALE_AFTER_MS - 1)).toBe("aging");
    expect(freshnessForAge(POSITION_STALE_AFTER_MS)).toBe("stale");
  });
});

describe("server clock", () => {
  const at: Instant = { wallMs: CAPTURED + 1_000, monoMs: 10_000 };

  it("never calls a position fresh without verified time", () => {
    const run = runFrom(myRunReady);
    const clock = queryClock(CAPTURED + 1_000, at.wallMs);
    expect(positionFreshness(run.position!, clock, at)).toBe("aging");
  });

  it("calls a recent position fresh once time is verified", () => {
    const run = runFrom(myRunReady);
    expect(positionFreshness(run.position!, verifiedAt(CAPTURED + 1_000, at), at)).toBe("fresh");
  });

  it("review case: slow browser clock plus cached snapshot is stale once verified", () => {
    // Browser clock 15 min slow; the cached query claims 1 s after capture; the
    // position is really 10 min old.
    const realNow = CAPTURED + 10 * 60_000;
    const browser: Instant = { wallMs: realNow - 15 * 60_000, monoMs: 50_000 };
    const run = runFrom(myRunReady);
    const cached = queryClock(CAPTURED + 1_000, browser.wallMs);
    expect(positionFreshness(run.position!, cached, browser)).not.toBe("fresh");
    expect(positionFreshness(run.position!, verifiedAt(realNow, browser), browser)).toBe("stale");
  });

  it("keeps aging while the monotonic clock pauses during device sleep", () => {
    const clock = verifiedAt(CAPTURED + 1_000, at);
    // Ten minutes of sleep: wall clock advanced, performance.now() did not.
    const woke: Instant = { wallMs: at.wallMs + 10 * 60_000, monoMs: at.monoMs };
    expect(positionFreshness(runFrom(myRunReady).position!, clock, woke)).toBe("stale");
  });

  it("ignores the wall clock being set back", () => {
    const clock = verifiedAt(CAPTURED + 1_000, at);
    const later: Instant = { wallMs: at.wallMs - 60 * 60_000, monoMs: at.monoMs + 200_000 };
    expect(ageClockMs(clock, later)).toBe(CAPTURED + 1_000 + 200_000);
  });

  it("pins to the round-trip midpoint and adds half the round trip", () => {
    const sent: Instant = { wallMs: 1_000, monoMs: 0 };
    const clock = verifiedClock(sent, { wallMs: 3_000, monoMs: 2_000 }, 500_000)!;
    expect(ageClockMs(clock, { wallMs: 2_000, monoMs: 1_000 })).toBe(500_000 + 1_000);
  });

  it("rejects a sample whose round trip took over 5 s", () => {
    expect(verifiedClock({ wallMs: 0, monoMs: 0 }, { wallMs: 5_001, monoMs: 5_001 }, 1)).toBeNull();
  });

  it("never shows a negative age", () => {
    const run = runFrom(myRunReady);
    const before = verifiedAt(CAPTURED - 60_000, at);
    expect(statusCopy(livePresentation(run, before, at), run, before, at).age).toBe("Updated just now");
  });
});

describe("state mapping from the tracking contract", () => {
  const at: Instant = { wallMs: CAPTURED + 2_000, monoMs: 0 };
  const verified = verifiedAt(CAPTURED + 2_000, at);

  it("ready fixture: live and fresh, with the iOS copy", () => {
    const run = runFrom(myRunReady);
    const p = livePresentation(run, verified, at);
    expect(p).toEqual({ kind: "live", freshness: "fresh" });
    expect(showsMarker(p)).toBe(true);
    expect(statusCopy(p, run, verified, at)).toMatchObject({
      title: "Bus 12 is reporting its location",
      detail: "Shown on the map with your stop, Oak & Pine.",
      tone: "fresh",
    });
  });

  it("stale fixture: last known location", () => {
    const snap = runSnapshot(myRunStale);
    if (snap.kind !== "ready") throw new Error("not ready");
    const now: Instant = { wallMs: snap.serverNowMs, monoMs: 0 };
    const p = livePresentation(snap.run, verifiedAt(snap.serverNowMs, now), now);
    expect(p).toEqual({ kind: "stale" });
    expect(statusCopy(p, snap.run, verifiedAt(snap.serverNowMs, now), now).title).toBe("Last known location");
  });

  it("goes stale on its own as local time advances, with no new update", () => {
    const run = runFrom(myRunReady);
    const later: Instant = { wallMs: at.wallMs + POSITION_STALE_AFTER_MS, monoMs: POSITION_STALE_AFTER_MS };
    expect(livePresentation(run, verified, at).kind).toBe("live");
    expect(livePresentation(run, verified, later)).toEqual({ kind: "stale" });
    expect(statusCopy({ kind: "stale" }, run, verified, later).age).toBe("Updated 2 min ago");
  });

  it("no position yet: waiting, no marker", () => {
    const run = runFrom(myRunReadyNoPosition);
    const p = livePresentation(run, verified, at);
    expect(p).toEqual({ kind: "awaiting_first_position" });
    expect(showsMarker(p)).toBe(false);
  });

  it("no fix: GPS unavailable, independent of the connection", () => {
    const run = runFrom(withRun({ gpsStatus: "no_fix" }));
    const p = livePresentation(run, verified, at);
    expect(p).toEqual({ kind: "gps_unavailable", status: "no_fix" });
    expect(statusCopy(p, run, verified, at).detail).toContain("can't get a signal");
  });

  it("no fix and no position: GPS unavailable without a marker position", () => {
    const run = runFrom(withRun({ gpsStatus: "receiver_missing", lastPosition: null }));
    expect(livePresentation(run, verified, at)).toEqual({ kind: "gps_unavailable", status: "receiver_missing" });
  });

  it("stale wins over no fix", () => {
    const run = runFrom(withRun({ gpsStatus: "no_fix" }));
    const later: Instant = { wallMs: at.wallMs, monoMs: POSITION_STALE_AFTER_MS };
    expect(livePresentation(run, verified, later)).toEqual({ kind: "stale" });
  });

  it.each(["completed", "cancelled", "scheduled"] as const)("%s run: not live, no marker", (state) => {
    const run = runFrom(withRun({ state }));
    const p = livePresentation(run, verified, at);
    expect(p).toEqual({ kind: "not_live", state });
    expect(showsMarker(p)).toBe(false);
  });

  it("an implausible coordinate never becomes a marker", () => {
    const run = runFrom(withRun({ lastPosition: { ...ready.run.lastPosition!, latitude: 123 } }));
    expect(run.position).toBeNull();
    expect(livePresentation(run, verified, at)).toEqual({ kind: "awaiting_first_position" });
  });

  it("a future capture time beyond the skew bound is dropped", () => {
    const run = runFrom(withRun({ lastPosition: { ...ready.run.lastPosition!, capturedAtMs: ready.serverNowMs + 600_000 } }));
    expect(run.position).toBeNull();
  });

  it("no-active-run and access-unavailable fixtures map to their own kinds", () => {
    expect(runSnapshot(myRunNoActiveRun).kind).toBe("no_active_run");
    expect(runSnapshot(myRunAccessUnavailable)).toEqual({ kind: "access_unavailable", reason: "not_permitted" });
  });

  it("a wrong schema version is a mapping error, not no-trip", () => {
    expect(() => runSnapshot({ ...myRunNoActiveRun, schemaVersion: 2 })).toThrow(MappingError);
  });

  it("formats ages like iOS", () => {
    expect(updatedText(4_999)).toBe("Updated just now");
    expect(updatedText(12_000)).toBe("Updated 12s ago");
    expect(updatedText(180_000)).toBe("Updated 3 min ago");
    expect(updatedText(3_600_000)).toBe("Updated over an hour ago");
  });
});

/** Manually driven source: tests push values and errors. */
class FakeSource implements TrackingSource {
  assignmentsCb: ((raw: unknown) => void) | null = null;
  assignmentsErr: ((e: unknown) => void) | null = null;
  runCbs = new Map<string, (raw: unknown) => void>();
  runErrs = new Map<string, (e: unknown) => void>();
  routeCbs = new Map<string, (raw: unknown) => void>();
  /** Null: unavailable (the call rejects). */
  serverTimeResult: Promise<number> | null = null;

  assignments(onValue: (raw: unknown) => void, onError: (e: unknown) => void) {
    this.assignmentsCb = onValue;
    this.assignmentsErr = onError;
    return () => {
      this.assignmentsCb = null;
    };
  }
  run(id: string, onValue: (raw: unknown) => void, onError: (e: unknown) => void) {
    this.runCbs.set(id, onValue);
    this.runErrs.set(id, onError);
    return () => this.runCbs.delete(id);
  }
  route(id: string, onValue: (raw: unknown) => void) {
    this.routeCbs.set(id, onValue);
    return () => this.routeCbs.delete(id);
  }
  serverTime() {
    return this.serverTimeResult ?? Promise.reject(new Error("unavailable"));
  }
}

const TWO_STUDENTS = {
  ...myAssignmentsReady,
  assignments: [
    ...(myAssignmentsReady.status === "ready" ? myAssignmentsReady.assignments : []),
    {
      assignmentId: "demo_assignment_002",
      relationship: "guardian",
      studentDisplayName: "Jordan Example",
      routeLabel: "Route 17 Morning",
      stopLabel: "Maple & 3rd",
    },
  ],
};

const now = () => ({ wallMs: CAPTURED + 1_000, monoMs: 0 });

describe("TrackStore", () => {

  it("loads, then tracks the first assignment", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    expect(store.state.kind).toBe("loading");
    source.assignmentsCb?.(myAssignmentsReady);
    expect(store.state.kind).toBe("loading");
    source.routeCbs.get("demo_assignment_001")?.(myRouteReady);
    source.runCbs.get("demo_assignment_001")?.(myRunReady);
    expect(store.state).toMatchObject({ kind: "tracking", context: { route: { routeLabel: "Route 17 Morning" } } });
  });

  it("drops a late result for the previously selected student", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.(TWO_STUDENTS);
    const oldRun = source.runCbs.get("demo_assignment_001");
    store.select("demo_assignment_002");
    oldRun?.(myRunReady);
    expect(store.state.kind).toBe("loading");
    expect(store.selectedAssignmentId).toBe("demo_assignment_002");
  });

  it("an empty assignment list is access unavailable", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.({ ...myAssignmentsReady, assignments: [] });
    expect(store.state).toEqual({ kind: "access_unavailable" });
  });

  it("unauthenticated is session expired, not access unavailable", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.({ ...myRunAccessUnavailable, reason: "unauthenticated" });
    expect(store.state).toEqual({ kind: "session_expired" });
  });

  it("revoked access mid-trip clears the run", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.(myAssignmentsReady);
    source.runCbs.get("demo_assignment_001")?.(myRunReady);
    source.runCbs.get("demo_assignment_001")?.(myRunAccessUnavailable);
    expect(store.state).toEqual({ kind: "access_unavailable" });
    expect(store.selectedAssignmentId).toBeNull();
  });

  it("a transport error is a recoverable failure, never no-trip", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.(myAssignmentsReady);
    source.runErrs.get("demo_assignment_001")?.(new Error("socket closed"));
    expect(store.state).toEqual({ kind: "failed", message: TRANSPORT_FAILURE });
  });

  it("a typed session error is session expired", () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsErr?.(new SessionExpiredError());
    expect(store.state).toEqual({ kind: "session_expired" });
  });

  it("uses verified time once it arrives, and drops it on reverify", async () => {
    const source = new FakeSource();
    source.serverTimeResult = Promise.resolve(CAPTURED + 1_000);
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.(myAssignmentsReady);
    source.runCbs.get("demo_assignment_001")?.(myRunReady);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.state.kind === "tracking" && store.state.clock.kind).toBe("verified");
    source.serverTimeResult = new Promise(() => {});
    store.reverifyServerTime();
    expect(store.state.kind === "tracking" && store.state.clock.kind).toBe("query");
  });

  it("stays unverified when serverTime is unavailable", async () => {
    const source = new FakeSource();
    const store = new TrackStore(source, now);
    store.start();
    source.assignmentsCb?.(myAssignmentsReady);
    source.runCbs.get("demo_assignment_001")?.(myRunReady);
    await Promise.resolve();
    expect(store.state.kind === "tracking" && store.state.clock.kind).toBe("query");
  });
});
