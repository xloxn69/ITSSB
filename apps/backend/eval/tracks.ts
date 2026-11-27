/**
 * Replayable fictional bus runs for ETA evaluation (docs/10 §6).
 *
 * Everything here is invented: a made-up street grid near fictional
 * coordinates, made-up stops, and a simple vehicle model with traffic, red
 * lights, stop dwell, GPS noise, and upload dropouts. A seed fully determines
 * each run, so a replay is identical every time.
 *
 * Ground-truth arrival times come from the simulation itself (when the
 * simulated bus reached each stop), never from the backend's own stop
 * detection, so the evaluation cannot grade the detector against itself.
 *
 * These are not field measurements. Numbers from them describe how the
 * baseline behaves on this simulation only.
 */
import type { RoutePoint } from "@itssb/contracts";
import { prepareRoute, type RouteStopInput } from "../convex/lib/routeProgress";

export interface ReplayFix {
  capturedAtMs: number;
  latitude: number;
  longitude: number;
  horizontalAccuracyM: number;
}

export interface ReplayRun {
  runIndex: number;
  startedAtMs: number;
  fixes: ReplayFix[];
  /** Simulated time the bus reached each stop, in travel order. */
  trueArrivalMs: number[];
}

export interface ReplaySet {
  path: RoutePoint[];
  stops: RouteStopInput[];
  runs: ReplayRun[];
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const BASE = { latitude: 34.1, longitude: -83.99 };
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.latitude * Math.PI) / 180);
const toPoint = (east: number, north: number): RoutePoint => ({
  latitude: BASE.latitude + north / M_PER_DEG_LAT,
  longitude: BASE.longitude + east / M_PER_DEG_LON,
});

/** Corners of a fictional route on a street grid, meters east/north. */
const CORNERS: [number, number][] = [
  [0, 0],
  [1800, 0],
  [1800, 1200],
  [600, 1200],
  [600, 2600],
  [2600, 2600],
  [2600, 1600],
  [3800, 1600],
];
/** Posted-speed proxy for each leg between corners, m/s. */
const LEG_SPEED_MPS = [13, 9, 11, 8, 12, 9, 13];
/** Fraction of the path at which each fictional stop sits. */
const STOP_FRACTIONS = [0.08, 0.17, 0.26, 0.36, 0.45, 0.55, 0.63, 0.74, 0.85, 0.97];

interface Geometry {
  pathMeters: { e: number; n: number; along: number; leg: number }[];
  totalM: number;
  cornerAlong: number[];
}

function geometry(): Geometry {
  const pathMeters: Geometry["pathMeters"] = [];
  const cornerAlong = [0];
  let along = 0;
  for (let leg = 0; leg < CORNERS.length - 1; leg++) {
    const [e0, n0] = CORNERS[leg]!;
    const [e1, n1] = CORNERS[leg + 1]!;
    const len = Math.hypot(e1 - e0, n1 - n0);
    const steps = Math.round(len / 10);
    for (let s = leg === 0 ? 0 : 1; s <= steps; s++) {
      const f = s / steps;
      pathMeters.push({ e: e0 + f * (e1 - e0), n: n0 + f * (n1 - n0), along: along + f * len, leg });
    }
    along += len;
    cornerAlong.push(along);
  }
  return { pathMeters, totalM: along, cornerAlong };
}

function positionAt(g: Geometry, along: number): { e: number; n: number; leg: number } {
  const pts = g.pathMeters;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.along <= along) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const f = b.along === a.along ? 0 : Math.min(1, Math.max(0, (along - a.along) / (b.along - a.along)));
  return { e: a.e + f * (b.e - a.e), n: a.n + f * (b.n - a.n), leg: b.leg };
}

const FIX_INTERVAL_MS = 5_000;
const RUN_START_MS = Date.UTC(2026, 8, 1, 11, 30); // fictional service day

/** Simulates one run second by second. */
function simulateRun(g: Geometry, stopAlong: number[], runIndex: number, seed: number): ReplayRun {
  const r = rng(seed * 7919 + runIndex);
  // Day-level traffic: some mornings are slower than others.
  const traffic = 0.7 + 0.45 * r();
  const legFactor = LEG_SPEED_MPS.map(() => 0.85 + 0.3 * r());
  const startedAtMs = RUN_START_MS + runIndex * 24 * 3600_000;
  const fixes: ReplayFix[] = [];
  const trueArrivalMs: number[] = [];
  let along = 0;
  let speed = 0;
  let t = 0; // seconds since start
  let holdS = 0;
  let nextStop = 0;
  let nextCorner = 1;
  let dropoutUntil = -1;
  const lightAtCorner = g.cornerAlong.map(() => r() < 0.55);

  while (along < g.totalM && t < 4 * 3600) {
    if (holdS > 0) {
      holdS -= 1;
      speed = 0;
    } else {
      const { leg } = positionAt(g, along);
      const target = LEG_SPEED_MPS[leg]! * legFactor[leg]! * traffic * (0.9 + 0.2 * r());
      // Slow for the next stop or corner.
      const nextHalt = Math.min(stopAlong[nextStop] ?? Infinity, g.cornerAlong[nextCorner] ?? Infinity);
      const brakeLimit = Math.sqrt(Math.max(0, 2 * 1.2 * (nextHalt - along))) + 2;
      const desired = Math.min(target, brakeLimit);
      speed = desired > speed ? Math.min(desired, speed + 1.3) : Math.max(desired, speed - 2.0);
      along = Math.min(g.totalM, along + speed);
    }
    t += 1;
    if (nextStop < stopAlong.length && along >= stopAlong[nextStop]!) {
      along = stopAlong[nextStop]!;
      trueArrivalMs.push(startedAtMs + t * 1000);
      // Dwell: lognormal around ~25 s, longer for some stops and days.
      holdS = Math.round(Math.min(150, Math.exp(Math.log(25) + 0.45 * gaussian(r))));
      nextStop += 1;
    } else if (nextCorner < g.cornerAlong.length - 1 && along >= g.cornerAlong[nextCorner]!) {
      if (lightAtCorner[nextCorner] && r() < 0.6) holdS = Math.round(10 + 50 * r());
      nextCorner += 1;
    }
    if ((t * 1000) % FIX_INTERVAL_MS === 0) {
      if (t > dropoutUntil && r() < 0.01) dropoutUntil = t + 30 + Math.round(90 * r());
      if (t <= dropoutUntil) continue;
      const p = positionAt(g, along);
      const point = toPoint(p.e + 4 * gaussian(r), p.n + 4 * gaussian(r));
      fixes.push({ capturedAtMs: startedAtMs + t * 1000, ...point, horizontalAccuracyM: 6 });
    }
  }
  return { runIndex, startedAtMs, fixes, trueArrivalMs };
}

/** Builds `count` deterministic fictional runs on one fictional route. */
export function buildReplaySet(count: number, seed = 17): ReplaySet {
  const g = geometry();
  const path = g.pathMeters.map((p) => toPoint(p.e, p.n));
  const stopAlong = STOP_FRACTIONS.map((f) => f * g.totalM);
  const stops: RouteStopInput[] = stopAlong.map((a, i) => {
    const p = positionAt(g, a);
    return { stopId: `fictional_stop_${i + 1}`, sequence: i, ...toPoint(p.e, p.n) };
  });
  const runs = Array.from({ length: count }, (_, i) => simulateRun(g, stopAlong, i, seed));
  return { path, stops, runs };
}

/** Sanity check used by the tests: the route prepares and stops are ordered. */
export function preparedReplayRoute(set: ReplaySet) {
  return prepareRoute(set.path, set.stops);
}
