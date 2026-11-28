import type { MyRunResult } from "@itssb/contracts";
import {
  myAssignmentsReady,
  myRunCancelled,
  myRunCancelledReplacementPending,
  myRunCompleted,
  myRunLateStart,
  myRunNoActiveRun,
  myRunNoService,
  myRunReady,
} from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { type Instant, queryClock, type ServerClock, verifiedClock } from "./clock";
import { MappingError, runSnapshot } from "./mapping";
import type { TripNotices } from "./model";
import { currentNotices, noTripCopy } from "./presentation";
import { TrackStore, type TrackingSource } from "./store";

/** D14 and docs/06 I19/I27 on the web: today's ended trip and calendar notice. */

type NoRun = Extract<MyRunResult, { status: "no_active_run" }>;
const at: Instant = { wallMs: myRunNoActiveRun.serverNowMs, monoMs: 0 };

function verifiedAt(serverNowMs: number): ServerClock {
  const clock = verifiedClock(at, at, serverNowMs);
  if (!clock) throw new Error("sample rejected");
  return clock;
}

function noticesFrom(raw: MyRunResult): TripNotices {
  const snap = runSnapshot(raw);
  if (snap.kind === "access_unavailable") throw new Error("denied");
  return snap.notices;
}

describe("myRun ended-run and notice mapping", () => {
  it("maps cancelled, replacement pending, completed, no service, and late start", () => {
    expect(noticesFrom(myRunCancelled).endedRun).toMatchObject({ state: "cancelled", replacement: null });
    expect(noticesFrom(myRunCancelledReplacementPending).endedRun).toMatchObject({ replacement: "pending" });
    expect(noticesFrom(myRunCompleted).endedRun).toMatchObject({ state: "completed" });
    expect(noticesFrom(myRunNoService).serviceNotice).toMatchObject({ status: "no_service", lateStartMinutes: null });
    expect(noticesFrom(myRunLateStart).serviceNotice).toMatchObject({ status: "late_start", lateStartMinutes: 20 });
  });

  it("an older deployment without the new keys still maps, with no notices", () => {
    const { endedRun: _e, serviceNotice: _n, ...old } = myRunNoActiveRun as NoRun;
    expect(noticesFrom(old as MyRunResult)).toEqual({ endedRun: null, serviceNotice: null });
    const { serviceNotice: _r, ...oldReady } = myRunReady as Extract<MyRunResult, { status: "ready" }>;
    expect(noticesFrom(oldReady as MyRunResult)).toEqual({ endedRun: null, serviceNotice: null });
  });

  it.each([
    ["an unknown ended state", { ...myRunCancelled, endedRun: { ...(myRunCancelled as NoRun).endedRun, state: "active" } }],
    ["a replacement claimed active", { ...myRunCancelled, endedRun: { ...(myRunCancelled as NoRun).endedRun, replacement: "active" } }],
    ["a late start without minutes", { ...myRunLateStart, serviceNotice: { ...(myRunLateStart as NoRun).serviceNotice, lateStartMinutes: null } }],
    ["no service with minutes", { ...myRunNoService, serviceNotice: { ...(myRunNoService as NoRun).serviceNotice, lateStartMinutes: 5 } }],
    ["a notice without an expiry", { ...myRunNoService, serviceNotice: { ...(myRunNoService as NoRun).serviceNotice, validUntilMs: null } }],
  ])("%s is a mapping error, never 'no trip'", (_name, raw) => {
    expect(() => runSnapshot(raw)).toThrow(MappingError);
  });
});

describe("a malformed notice on a running trip", () => {
  it("is dropped and the live trip stays usable", () => {
    const raw = { ...myRunReady, serviceNotice: { ...(myRunLateStart as NoRun).serviceNotice, status: "maybe" } };
    expect(runSnapshot(raw)).toMatchObject({ kind: "ready", notices: { endedRun: null, serviceNotice: null } });
  });
});

describe("no-trip status copy", () => {
  it.each([
    [myRunCancelled, "Trip cancelled", "The school cancelled today's trip"],
    [myRunCancelledReplacementPending, "Trip cancelled", "is sending a replacement bus"],
    [myRunCompleted, "Trip completed", "has finished"],
    [myRunNoService, "No service today", "teacher workday"],
    [myRunLateStart, "Starts 20 minutes late today", "because of fog"],
    [myRunNoActiveRun, "No trip right now", "isn't running"],
  ] as const)("%#: %s", (raw, title, detail) => {
    const copy = noTripCopy(noticesFrom(raw), "America/New_York");
    expect(copy.title).toBe(title);
    expect(copy.detail).toContain(detail);
  });

  it("a pending replacement is never called on the way", () => {
    expect(noTripCopy(noticesFrom(myRunCancelledReplacementPending)).detail).not.toMatch(/on the way/i);
  });

  it("says when the trip was cancelled, in local time", () => {
    // 1795608600000 is 07:10 in New York.
    expect(noTripCopy(noticesFrom(myRunCancelled), "America/New_York").age).toMatch(/^Cancelled at 7:10/);
  });

  it("a cancellation keeps the card title even when a notice exists", () => {
    const both = { ...noticesFrom(myRunCancelled), serviceNotice: noticesFrom(myRunLateStart).serviceNotice };
    expect(noTripCopy(both).title).toBe("Trip cancelled");
  });
});

describe("notices expire with their service day", () => {
  it("are shown before the end of the day and hidden from then on", () => {
    const notices = { ...noticesFrom(myRunCancelled), serviceNotice: noticesFrom(myRunNoService).serviceNotice };
    const end = notices.endedRun!.validUntilMs;
    expect(currentNotices(notices, verifiedAt(end - 1), at)).toEqual(notices);
    expect(currentNotices(notices, verifiedAt(end), at)).toEqual({ endedRun: null, serviceNotice: null });
    expect(noTripCopy(currentNotices(notices, verifiedAt(end), at)).title).toBe("No trip right now");
  });

  it("an unverified clock never keeps yesterday's status by trusting a slow device clock", () => {
    const notices = noticesFrom(myRunCancelled);
    const end = notices.endedRun!.validUntilMs;
    // The server said it is past the end of the day; the device clock is behind.
    const clock = queryClock(end + 1, at.wallMs - 60 * 60_000);
    expect(currentNotices(notices, clock, at).endedRun).toBeNull();
  });
});

describe("TrackStore with an ended trip", () => {
  it("carries the notices and a clock into the no-trip state", () => {
    const runs = new Map<string, (raw: unknown) => void>();
    const pushed: { assignments?: (raw: unknown) => void } = {};
    const source: TrackingSource = {
      assignments: (onValue) => ((pushed.assignments = onValue), () => {}),
      run: (id, onValue) => (runs.set(id, onValue), () => runs.delete(id)),
      route: () => () => {},
      serverTime: () => Promise.reject(new Error("unavailable")),
    };
    const store = new TrackStore(source, () => at);
    store.start();
    pushed.assignments?.(myAssignmentsReady);
    runs.get("demo_assignment_001")?.(myRunCancelledReplacementPending);
    expect(store.state).toMatchObject({
      kind: "no_active_run",
      context: { notices: { endedRun: { state: "cancelled", replacement: "pending" }, serviceNotice: null } },
      clock: { kind: "query" },
    });
  });
});
