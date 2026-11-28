/**
 * Whether an inbox alert still describes its trip (docs/06 I21, web
 * parity). An alert is a past estimate: it is never called current unless
 * the live run confirms it. Mirrors the iOS `AlertCurrency`.
 */
import type { AlertItem, TrackedRun } from "./model";
import type { TrackState } from "./store";

/** What the page knows about the alert's assignment right now. */
export type TripNow =
  | { kind: "checking" }
  | { kind: "unknown" }
  /** The connection dropped: the last answer may be out of date (I25). */
  | { kind: "disconnected" }
  | { kind: "no_active_run"; assignmentId: string }
  | { kind: "run"; assignmentId: string; run: TrackedRun };

export type AlertCurrency =
  | { kind: "checking" }
  | { kind: "unknown" }
  | { kind: "trip_ended" }
  | { kind: "superseded"; newerEstimateAtMs: number }
  | { kind: "latest" }
  | { kind: "running_no_estimate" }
  | { kind: "unconfirmed" };

export function alertCurrency(alert: AlertItem, trip: TripNow): AlertCurrency {
  switch (trip.kind) {
    case "checking":
    case "unknown":
      return { kind: trip.kind };
    case "disconnected":
      return { kind: "unconfirmed" };
    case "no_active_run":
      return trip.assignmentId === alert.assignmentId ? { kind: "trip_ended" } : { kind: "unknown" };
    case "run": {
      if (trip.assignmentId !== alert.assignmentId) return { kind: "unknown" };
      // `myRun` reports only an active run; another run or state means this one is over.
      if (trip.run.runId !== alert.runId || trip.run.state !== "active") return { kind: "trip_ended" };
      const eta = trip.run.eta;
      if (!eta) return { kind: "running_no_estimate" };
      if (eta.generatedAtMs > alert.predictionGeneratedAtMs) return { kind: "superseded", newerEstimateAtMs: eta.generatedAtMs };
      return { kind: "latest" };
    }
  }
}

export function alertCurrencyText(c: AlertCurrency, time: (ms: number) => string): { title: string; detail: string } {
  switch (c.kind) {
    case "checking":
      return { title: "Checking this trip…", detail: "This alert shows an earlier estimate." };
    case "unknown":
      return { title: "Couldn't check this trip", detail: "This alert shows an earlier estimate. It may be out of date." };
    case "trip_ended":
      return { title: "This trip has ended", detail: "This alert is from a trip that's no longer running." };
    case "superseded":
      return { title: "There's a newer estimate", detail: `This alert is out of date. The trip above shows the estimate made at ${time(c.newerEstimateAtMs)}.` };
    case "latest":
      return { title: "This is the trip's latest estimate", detail: "The trip is still running. The trip above shows how old the estimate is now." };
    case "running_no_estimate":
      return { title: "No current estimate", detail: "The trip is still running, but there's no estimate right now." };
    case "unconfirmed":
      return { title: "Can't confirm right now", detail: "The connection was lost, so this trip's status can't be checked. Reconnecting…" };
  }
}

/** What the alert details may say about the trip: never cached state while the connection is lost. */
export function tripNow(state: TrackState, connectionLost: boolean): TripNow {
  if (connectionLost) return { kind: "disconnected" };
  if (state.kind === "tracking") return { kind: "run", assignmentId: state.context.assignment.assignmentId, run: state.run };
  if (state.kind === "no_active_run") return { kind: "no_active_run", assignmentId: state.context.assignment.assignmentId };
  return { kind: "unknown" };
}
