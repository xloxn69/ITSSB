/**
 * What the tracking screen may honestly claim at one instant, and the words
 * for it. Pure ports of the iOS `LivePresentation`, `StatusCopy`, and
 * `AgeFormatter`, so Android families read the same meaning as iPhone
 * families. Re-derived every second, so the screen goes stale on its own.
 */
import { type GpsStatus, POSITION_STALE_AFTER_MS, type RunState } from "@itssb/contracts";
import { ageClockMs, type Instant, type ServerClock } from "./clock";
import {
  type AlertItem,
  type Freshness,
  positionAgeMs,
  positionFreshness,
  type ServiceNotice,
  type TrackedRun,
  type TripNotices,
} from "./model";

export type LivePresentation =
  /** A recent position. `aging` means an update is overdue but not yet stale. */
  | { kind: "live"; freshness: Exclude<Freshness, "stale"> }
  /** Past the stale cutoff: dim it and show its capture time. */
  | { kind: "stale" }
  /** Active run, but no usable position yet. */
  | { kind: "awaiting_first_position" }
  /** Reporting, but GPS has no fix or no receiver (docs/06 I26). */
  | { kind: "gps_unavailable"; status: Exclude<GpsStatus, "valid"> }
  /** Completed, cancelled, or not started: no live marker (docs/08 §8). */
  | { kind: "not_live"; state: RunState };

export function livePresentation(run: TrackedRun, clock: ServerClock, now: Instant): LivePresentation {
  if (run.state !== "active") return { kind: "not_live", state: run.state };
  const gpsProblem = run.gpsStatus && run.gpsStatus !== "valid" && contactIsRecent(run, clock, now) ? run.gpsStatus : null;
  if (!run.position) {
    return gpsProblem ? { kind: "gps_unavailable", status: gpsProblem } : { kind: "awaiting_first_position" };
  }
  const freshness = positionFreshness(run.position, clock, now);
  if (freshness === "stale") return { kind: "stale" };
  if (gpsProblem) return { kind: "gps_unavailable", status: gpsProblem };
  return { kind: "live", freshness };
}

/**
 * `gpsStatus` is the bus's last health report and is never expired by the
 * backend, so it counts only while the bus was heard from recently: past the
 * stale cutoff it may describe a bus that has since gone silent (docs/08 §8).
 */
function contactIsRecent(run: TrackedRun, clock: ServerClock, now: Instant): boolean {
  return run.lastDeviceContactAtMs !== null && ageClockMs(clock, now) - run.lastDeviceContactAtMs < POSITION_STALE_AFTER_MS;
}

/**
 * While live updates can't arrive, nothing is called fresh: at best the bus
 * is "waiting for an update", exactly as without verified time.
 */
export function whileDisconnected(p: LivePresentation, connectionLost: boolean): LivePresentation {
  return connectionLost && p.kind === "live" && p.freshness === "fresh" ? { kind: "live", freshness: "aging" } : p;
}

/** Whether to draw the bus marker at the last position. */
export function showsMarker(p: LivePresentation): boolean {
  return p.kind === "live" || p.kind === "stale" || p.kind === "gps_unavailable";
}

/** Whether the marker must look like an old, last-known point. */
export function dimsMarker(p: LivePresentation): boolean {
  return p.kind !== "live";
}

/** "Updated 8s ago", "Updated 3 min ago". */
export function updatedText(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 5) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)} min ago`;
  return "Updated over an hour ago";
}

export type Tone = "fresh" | "aging" | "stale" | "unknown";

export interface StatusCopy {
  title: string;
  detail: string;
  /** Null when there is no position to age. */
  age: string | null;
  tone: Tone;
}

export function capturedTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(ms);
}

const NOT_LIVE_TITLE: Record<RunState, string> = {
  completed: "Trip completed",
  cancelled: "Trip cancelled",
  scheduled: "Trip hasn't started",
  active: "Trip in progress",
};

export function statusCopy(
  p: LivePresentation,
  run: TrackedRun,
  clock: ServerClock,
  now: Instant,
  timeZone?: string,
): StatusCopy {
  const age = run.position ? updatedText(positionAgeMs(run.position, clock, now)) : null;
  const stop = run.assignedStop.label;
  switch (p.kind) {
    case "live":
      return p.freshness === "fresh"
        ? {
            // Location only: route progress is unknown until the backend tracks it.
            title: `${run.busLabel} is reporting its location`,
            detail: `Shown on the map with your stop, ${stop}.`,
            age,
            tone: "fresh",
          }
        : {
            title: "Waiting for an update",
            detail: `${run.busLabel} hasn't reported for a little while.`,
            age,
            tone: "aging",
          };
    case "stale": {
      const reported = run.position ? capturedTime(run.position.capturedAtMs, timeZone) : "earlier";
      return {
        title: "Last known location",
        detail: `Reported at ${reported}. The bus may have moved since then.`,
        age,
        tone: "stale",
      };
    }
    case "awaiting_first_position":
      return {
        title: "Waiting for the bus's location",
        detail: `The trip has started, but ${run.busLabel} hasn't reported a location yet.`,
        age: null,
        tone: "unknown",
      };
    case "gps_unavailable": {
      const problem =
        p.status === "receiver_missing" ? "Its GPS receiver isn't working." : "Its GPS can't get a signal right now.";
      return {
        title: "Bus location unavailable",
        detail: `${run.busLabel} is connected. ${problem} The marker shows its last fix.`,
        age,
        tone: "stale",
      };
    }
    case "not_live":
      return {
        title: NOT_LIVE_TITLE[p.state],
        detail: "There's no live bus location for this trip.",
        age: null,
        tone: "unknown",
      };
  }
}

/**
 * Only what still describes today on the server-aligned clock. The backend
 * query isn't re-run when a day ends, so yesterday's cancellation or "no
 * service" would otherwise stay on screen overnight (docs/08 §8).
 */
export function currentNotices(notices: TripNotices, clock: ServerClock, now: Instant): TripNotices {
  const serverNow = ageClockMs(clock, now);
  return {
    endedRun: notices.endedRun && serverNow < notices.endedRun.validUntilMs ? notices.endedRun : null,
    serviceNotice: notices.serviceNotice && serverNow < notices.serviceNotice.validUntilMs ? notices.serviceNotice : null,
  };
}

/** "No service today", "Starts 20 minutes late". */
export function serviceNoticeTitle(notice: ServiceNotice): string {
  if (notice.status === "no_service") return "No service today";
  const minutes = notice.lateStartMinutes ?? 0;
  return `Starts ${minutes} ${minutes === 1 ? "minute" : "minutes"} late today`;
}

/**
 * The card when no trip is running (docs/06 I19/I27). A cancellation uses
 * fixed wording: staff's reason is for staff and drivers. A pending
 * replacement is "being sent", not "on the way", until it actually starts.
 */
export function noTripCopy(notices: TripNotices, timeZone?: string): StatusCopy {
  const ended = notices.endedRun;
  const at = (verb: string) => (ended?.endedAtMs ? `${verb} at ${capturedTime(ended.endedAtMs, timeZone)}` : null);
  if (ended?.state === "cancelled") {
    return ended.replacement === "pending"
      ? {
          title: "Trip cancelled",
          detail: "The school cancelled this trip and is sending a replacement bus. Its location appears here once it starts.",
          age: at("Cancelled"),
          tone: "unknown",
        }
      : {
          title: "Trip cancelled",
          detail: "The school cancelled today's trip on this route. There's no live bus location for it.",
          age: at("Cancelled"),
          tone: "unknown",
        };
  }
  if (ended?.state === "completed") {
    return {
      title: "Trip completed",
      detail: "Today's trip on this route has finished. There's no live bus location now.",
      age: at("Finished"),
      tone: "unknown",
    };
  }
  if (notices.serviceNotice) {
    return {
      title: serviceNoticeTitle(notices.serviceNotice),
      detail: notices.serviceNotice.notice,
      age: null,
      tone: "unknown",
    };
  }
  return {
    title: "No trip right now",
    detail: "Your bus isn't running a route at the moment.",
    age: null,
    tone: "unknown",
  };
}

export interface EtaView {
  /** "About 6 min" or "Less than a minute". */
  headline: string;
  /** Clock time of the estimate. */
  arrivalText: string;
  /** "Estimate made 8s ago": an estimate is never shown without its age. */
  madeText: string;
}

/**
 * The arrival estimate, or null whenever it cannot be trusted right now:
 * time not verified, run not active, stop not upcoming, no position or a
 * stale one, an estimate made from another position, or past `validUntilMs`
 * on the server-aligned clock. Re-derived every second, so it disappears on
 * its own when it expires (docs/08 §8).
 */
export function etaView(run: TrackedRun, clock: ServerClock, now: Instant, timeZone?: string): EtaView | null {
  const e = run.eta;
  if (!e || clock.kind !== "verified" || run.state !== "active") return null;
  if (run.assignedStop.status !== "upcoming" || !run.position) return null;
  if (e.sourceEventId !== run.position.eventId) return null;
  if (positionFreshness(run.position, clock, now) === "stale") return null;
  const serverNow = ageClockMs(clock, now);
  if (serverNow >= e.validUntilMs) return null;
  const minutes = Math.round((e.arrivalAtMs - serverNow) / 60_000);
  const madeAgo = updatedText(Math.max(0, serverNow - e.generatedAtMs)).replace(/^Updated /, "");
  return {
    headline: minutes < 1 ? "Less than a minute" : `About ${minutes} min`,
    arrivalText: capturedTime(e.arrivalAtMs, timeZone),
    madeText: `Estimate made ${madeAgo}`,
  };
}

/** Route progress the server inferred from GPS, for the assigned stop. */
export function stopProgressText(run: TrackedRun): string | null {
  if (run.state !== "active") return null;
  if (run.assignedStop.status === "at_stop") return "The bus is at your stop.";
  if (run.assignedStop.status === "passed") return "The bus has passed your stop.";
  return null;
}

/** One inbox entry. It describes a past estimate, never the current one. */
export function alertRow(alert: AlertItem, timeZone?: string): { title: string; detail: string } {
  return {
    title: `Bus approaching ${alert.stopLabel}`,
    detail: `Estimated arrival ${capturedTime(alert.predictedArrivalAtMs, timeZone)}, from an estimate made at ${capturedTime(alert.predictionGeneratedAtMs, timeZone)}.`,
  };
}
