/**
 * Route progress along an approved route version (docs/10 §2). Pure code with
 * no Convex imports, so the evaluation script replays it exactly as the
 * backend runs it.
 *
 * Progress is distance along the approved path. Each fix is matched only to
 * path segments inside a window around the last accepted progress, so a loop's
 * return leg or a far-ahead segment is never chosen just because it is
 * geometrically nearest. A fix that matches nothing is `off_route`; one that
 * matches two separate parts of the path is `ambiguous`. Neither moves
 * progress, and neither supports an estimate.
 *
 * Every distance below is a tuning parameter for controlled tests, not a
 * guaranteed distance or a safety check.
 */
import type { RoutePoint, StopStatus } from "@itssb/contracts";

/** Base lateral distance from the path a fix may be and still match it. */
export const MATCH_LATERAL_M = 25;
/** Worst reported GPS accuracy added to the lateral tolerance. */
export const MAX_ACCURACY_ALLOWANCE_M = 25;
/**
 * A fix may change stop outcomes only if its distance from the path plus its
 * reported accuracy is within this: the whole error circle must support being
 * on the route, so a biased fix from a parallel street cannot serve a stop.
 */
export const CONFIDENT_LATERAL_M = 30;
/**
 * Accuracy assumed for the confidence gate when a fix reports none (GPSD
 * often omits it). Typical for a consumer receiver in open sky; a provisional
 * tuning value like the others.
 */
export const UNREPORTED_ACCURACY_M = 10;
/** How far from the path a recorded stop may be and still be placed on it. */
export const STOP_PLACEMENT_LATERAL_M = 40;
/** An arrival also needs the fix itself this close to the stop (plus up to 20 m of accuracy). */
export const ARRIVE_RADIUS_M = 40;
/** How far behind accepted progress a fix may match (GPS noise). */
export const BACKTRACK_M = 50;
/** Fastest plausible bus speed for the forward search window. */
export const MAX_PLAUSIBLE_SPEED_MPS = 35;
/** Fixed forward slack on top of the speed allowance. */
export const FORWARD_SLACK_M = 200;
/** Progress within this distance before a stop counts as arrived. */
export const ARRIVE_BEFORE_M = 30;
/** Progress this far beyond a stop counts as departed. */
export const DEPART_AFTER_M = 50;

export interface RouteStopInput {
  stopId: string;
  /** Travel order; a stop without one cannot be placed honestly. */
  sequence: number | undefined;
  latitude: number;
  longitude: number;
}

export interface PreparedStop {
  stopId: string;
  sequence: number;
  /** Distance along the path, in meters. */
  alongM: number;
}

export interface PreparedRoute {
  points: RoutePoint[];
  /** Cumulative distance at each point, meters; `cumM[0] === 0`. */
  cumM: number[];
  totalM: number;
  /** In travel order. */
  stops: PreparedStop[];
  /** Each stop's recorded coordinate, same order as `stops`. */
  stopPoints: RoutePoint[];
}

export type MatchStatus = "on_route" | "off_route" | "ambiguous";

export interface Fix {
  latitude: number;
  longitude: number;
  horizontalAccuracyM: number | null;
  capturedAtMs: number;
}

export interface StopOutcome {
  stopId: string;
  /** Capture time of the first fix within the arrival band, if seen. */
  arrivedAtMs: number | null;
  /** Capture time of the first fix past the departure band. */
  departedAtMs: number | null;
}

export interface ProgressState {
  /** Last accepted distance along the path; never decreases. */
  alongM: number;
  /** Capture time of the last accepted fix (or the run start). */
  atMs: number;
  /** Result of matching the most recent fix. */
  lastStatus: MatchStatus;
  stops: StopOutcome[];
}

export type Located = { status: "on_route"; alongM: number; lateralM: number } | { status: "off_route" | "ambiguous" };

const EARTH_RADIUS_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Local planar coordinates in meters around `origin` (fine at route scale). */
function planar(origin: RoutePoint, p: RoutePoint): [number, number] {
  const x = rad(p.longitude - origin.longitude) * Math.cos(rad(origin.latitude)) * EARTH_RADIUS_M;
  const y = rad(p.latitude - origin.latitude) * EARTH_RADIUS_M;
  return [x, y];
}

function planarDistance(a: RoutePoint, b: RoutePoint): number {
  const [x, y] = planar(a, b);
  return Math.hypot(x, y);
}

function segmentLength(a: RoutePoint, b: RoutePoint): number {
  const [x, y] = planar(a, b);
  return Math.hypot(x, y);
}

/** Projection of `p` onto segment `i`: distance along the path and lateral distance. */
function projectOnSegment(route: Pick<PreparedRoute, "points" | "cumM">, i: number, p: RoutePoint) {
  const a = route.points[i]!;
  const b = route.points[i + 1]!;
  const [bx, by] = planar(a, b);
  const [px, py] = planar(a, p);
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const lateralM = Math.hypot(px - t * bx, py - t * by);
  const segLen = route.cumM[i + 1]! - route.cumM[i]!;
  return { alongM: route.cumM[i]! + t * segLen, lateralM };
}

/**
 * Measures the path and places each stop on it in sequence order: a stop is
 * matched only at or after the previous stop, at the earliest place the path
 * passes close to it. Returns null (no progress, no estimate) for a path with
 * fewer than two points or a stop without a sequence.
 */
export function prepareRoute(path: RoutePoint[], stops: RouteStopInput[]): PreparedRoute | null {
  if (path.length < 2) return null;
  if (stops.some((s) => s.sequence === undefined)) return null;
  const cumM = [0];
  for (let i = 1; i < path.length; i++) cumM.push(cumM[i - 1]! + segmentLength(path[i - 1]!, path[i]!));
  const base = { points: path, cumM };
  const ordered = stops.toSorted((a, b) => a.sequence! - b.sequence!);
  const placed: PreparedStop[] = [];
  let minAlong = 0;
  for (const s of ordered) {
    // Every separate pass of the path near the stop after the previous stop,
    // each with its closest point. The stop goes on the first pass whose
    // closest point is past the previous stop: a stop on the same street lands
    // at its own position, and a later stop at the same place as an earlier
    // one (a loop's return leg) lands on the later pass.
    const passes: { alongM: number; lateralM: number }[] = [];
    let inPass = false;
    let lastAlong = 0;
    let nearest: { alongM: number; lateralM: number } | null = null;
    for (let i = 0; i < path.length - 1; i++) {
      if (cumM[i + 1]! < minAlong) continue;
      const proj = projectOnSegment(base, i, s);
      if (proj.alongM < minAlong) {
        inPass = false;
        continue;
      }
      if (!nearest || proj.lateralM < nearest.lateralM) nearest = proj;
      if (proj.lateralM > STOP_PLACEMENT_LATERAL_M) {
        inPass = false;
        continue;
      }
      // One pass is one stretch of path near the stop. Adjacent segments whose
      // closest points are far apart along the path (the two long legs of an
      // out-and-back) are separate passes.
      const current = passes[passes.length - 1];
      if (inPass && current && Math.abs(proj.alongM - lastAlong) <= 2 * STOP_PLACEMENT_LATERAL_M) {
        if (proj.lateralM < current.lateralM) passes[passes.length - 1] = proj;
      } else {
        passes.push(proj);
        inPass = true;
      }
      lastAlong = proj.alongM;
    }
    // The first stop takes the first pass (it may sit at the very start);
    // each later stop the first pass past the previous stop.
    const chosen = placed.length === 0 ? passes[0] : passes.find((p) => p.alongM > minAlong + 0.5);
    const alongM = chosen?.alongM ?? nearest?.alongM ?? minAlong;
    placed.push({ stopId: s.stopId, sequence: s.sequence!, alongM });
    minAlong = alongM;
  }
  return {
    points: path,
    cumM,
    totalM: cumM[cumM.length - 1]!,
    stops: placed,
    stopPoints: ordered.map((o) => ({ latitude: o.latitude, longitude: o.longitude })),
  };
}

/** Progress at run start: the beginning of the path, no stop reached yet. */
export function initialProgress(route: PreparedRoute, startedAtMs: number): ProgressState {
  return {
    alongM: 0,
    atMs: startedAtMs,
    lastStatus: "on_route",
    stops: route.stops.map((s) => ({ stopId: s.stopId, arrivedAtMs: null, departedAtMs: null })),
  };
}

/**
 * Matches one fix against the path inside the search window around `prev`.
 * Candidate segments within the lateral tolerance are grouped into
 * contiguous runs of path; more than one run is `ambiguous`.
 */
export function locate(route: PreparedRoute, prev: ProgressState, fix: Fix): Located {
  const dtS = Math.max(0, (fix.capturedAtMs - prev.atMs) / 1000);
  const lower = prev.alongM - BACKTRACK_M;
  const upper = prev.alongM + MAX_PLAUSIBLE_SPEED_MPS * dtS + FORWARD_SLACK_M;
  const tolerance = MATCH_LATERAL_M + Math.min(fix.horizontalAccuracyM ?? MAX_ACCURACY_ALLOWANCE_M, MAX_ACCURACY_ALLOWANCE_M);

  // Candidate projections, grouped by distance along the path: two groups
  // further apart than the tolerance are two separate places (two legs of a
  // hairpin or loop), even if path segments connect them.
  const candidates: { alongM: number; lateralM: number }[] = [];
  for (let i = 0; i < route.points.length - 1; i++) {
    if (route.cumM[i + 1]! < lower || route.cumM[i]! > upper) continue;
    const proj = projectOnSegment(route, i, fix);
    if (proj.lateralM > tolerance || proj.alongM < lower || proj.alongM > upper) continue;
    candidates.push(proj);
  }
  if (candidates.length === 0) return { status: "off_route" };
  candidates.sort((a, b) => a.alongM - b.alongM);
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.alongM - candidates[i - 1]!.alongM > 2 * tolerance) return { status: "ambiguous" };
    if (c.lateralM < best.lateralM) best = c;
  }
  return { status: "on_route", alongM: best.alongM, lateralM: best.lateralM };
}

/**
 * Applies one fix. An on-route match advances progress (never backward) and
 * records stop arrivals and departures from separate bands, so jitter near a
 * boundary cannot produce a second arrival. Off-route and ambiguous fixes
 * leave progress and stop outcomes unchanged.
 */
export function advance(route: PreparedRoute, prev: ProgressState, fix: Fix): ProgressState {
  // Not newer than accepted progress: history, not progress.
  if (fix.capturedAtMs <= prev.atMs) return prev;
  const located = locate(route, prev, fix);
  if (located.status !== "on_route") return { ...prev, lastStatus: located.status };
  const alongM = Math.max(prev.alongM, located.alongM);
  const accuracy = fix.horizontalAccuracyM ?? UNREPORTED_ACCURACY_M;
  // A loosely matched fix moves progress but never changes a stop outcome.
  const confident = located.lateralM + Math.min(accuracy, MAX_ACCURACY_ALLOWANCE_M) <= CONFIDENT_LATERAL_M;
  const stops = prev.stops.map((outcome, i) => {
    const stop = route.stops[i]!;
    let { arrivedAtMs, departedAtMs } = outcome;
    if (!confident || departedAtMs !== null) return outcome;
    if (alongM >= stop.alongM + DEPART_AFTER_M) {
      departedAtMs = fix.capturedAtMs;
    } else if (
      arrivedAtMs === null &&
      alongM >= stop.alongM - ARRIVE_BEFORE_M &&
      planarDistance(route.stopPoints[i]!, fix) <= ARRIVE_RADIUS_M + Math.min(accuracy, 20)
    ) {
      arrivedAtMs = fix.capturedAtMs;
    }
    return { stopId: outcome.stopId, arrivedAtMs, departedAtMs };
  });
  return { alongM, atMs: fix.capturedAtMs, lastStatus: "on_route", stops };
}

export function stopStatus(route: PreparedRoute, state: ProgressState, stopId: string): StopStatus {
  const i = route.stops.findIndex((s) => s.stopId === stopId);
  const outcome = state.stops[i];
  if (i < 0 || !outcome) return "unknown";
  if (outcome.departedAtMs !== null) return "passed";
  if (outcome.arrivedAtMs !== null) return "at_stop";
  return "upcoming";
}

/** First stop in travel order the bus has not departed, or null at the end. */
export function nextStopId(route: PreparedRoute, state: ProgressState): string | null {
  const i = state.stops.findIndex((s) => s.departedAtMs === null);
  return i < 0 ? null : route.stops[i]!.stopId;
}
