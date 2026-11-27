/**
 * Baseline ETA evaluation on held-out whole runs (docs/10 §6).
 *
 * Replays each run's fixes through the same route-progress and estimate code
 * the backend runs, predicts every upcoming stop at every fix (as the backend
 * stores them), and compares each prediction with the simulated true arrival.
 *
 * Whole runs are split chronologically: parameters are tuned on the earlier
 * runs only and reported on later runs never used for tuning.
 */
import { type BaselineParams, predictArrival } from "../convex/lib/eta";
import { advance, initialProgress, type PreparedRoute, prepareRoute } from "../convex/lib/routeProgress";
import type { ReplayRun, ReplaySet } from "./tracks";

export interface Sample {
  runIndex: number;
  /** Actual remaining time when the prediction was made, ms. */
  horizonMs: number;
  /** predicted − actual arrival, ms (positive = predicted too late). */
  errorMs: number;
}

export interface ReplayResult {
  samples: Sample[];
  /** Fix × upcoming-stop opportunities where the bus had not yet arrived. */
  opportunities: number;
}

export function replayRun(route: PreparedRoute, run: ReplayRun, params: BaselineParams): ReplayResult {
  const samples: Sample[] = [];
  let opportunities = 0;
  let state = initialProgress(route, run.startedAtMs);
  for (const fix of run.fixes) {
    state = advance(route, state, fix);
    route.stops.forEach((stop, i) => {
      const actual = run.trueArrivalMs[i];
      if (actual === undefined || actual <= fix.capturedAtMs) return;
      opportunities += 1;
      const p = predictArrival(route, state, stop.stopId, params, fix.capturedAtMs);
      if (!p) return;
      samples.push({ runIndex: run.runIndex, horizonMs: actual - fix.capturedAtMs, errorMs: p.arrivalAtMs - actual });
    });
  }
  return { samples, opportunities };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface Metrics {
  n: number;
  medianAbsS: number;
  meanAbsS: number;
  p90AbsS: number;
  biasS: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function metrics(samples: Sample[]): Metrics {
  const abs = samples.map((s) => Math.abs(s.errorMs) / 1000).toSorted((a, b) => a - b);
  return {
    n: samples.length,
    medianAbsS: quantile(abs, 0.5),
    meanAbsS: abs.length ? sum(abs) / abs.length : Number.NaN,
    p90AbsS: quantile(abs, 0.9),
    biasS: samples.length ? sum(samples.map((s) => s.errorMs / 1000)) / samples.length : Number.NaN,
  };
}

/** Horizon buckets around the 2/5/10/15-minute marks docs/10 §6 asks for. */
export const HORIZONS = [
  { label: "0–2 min", minMs: 0, maxMs: 2 * 60_000 },
  { label: "2–5 min", minMs: 2 * 60_000, maxMs: 5 * 60_000 },
  { label: "5–10 min", minMs: 5 * 60_000, maxMs: 10 * 60_000 },
  { label: "10–15 min", minMs: 10 * 60_000, maxMs: 15 * 60_000 },
  { label: "15+ min", minMs: 15 * 60_000, maxMs: Infinity },
] as const;

export function evaluate(route: PreparedRoute, runs: ReplayRun[], params: BaselineParams) {
  const results = runs.map((run) => replayRun(route, run, params));
  const samples = results.flatMap((r) => r.samples);
  const opportunities = results.reduce((a, r) => a + r.opportunities, 0);
  return {
    overall: metrics(samples),
    coverage: opportunities ? samples.length / opportunities : Number.NaN,
    byHorizon: HORIZONS.map((h) => ({
      horizon: h.label,
      ...metrics(samples.filter((s) => s.horizonMs >= h.minMs && s.horizonMs < h.maxMs)),
    })),
  };
}

/** Grid search on the training runs only, minimizing mean absolute error. */
export function tune(route: PreparedRoute, train: ReplayRun[], algorithmVersion: string): BaselineParams {
  let best: { params: BaselineParams; mae: number } | null = null;
  for (let speed = 4; speed <= 14; speed += 0.25) {
    for (let dwellS = 0; dwellS <= 90; dwellS += 5) {
      const params = { algorithmVersion, cruiseSpeedMps: speed, dwellMs: dwellS * 1000 };
      const mae = metrics(train.flatMap((run) => replayRun(route, run, params).samples)).meanAbsS;
      if (!best || mae < best.mae) best = { params, mae };
    }
  }
  return best!.params;
}

export function splitRuns(set: ReplaySet, trainCount: number) {
  const ordered = set.runs.toSorted((a, b) => a.startedAtMs - b.startedAtMs);
  return { train: ordered.slice(0, trainCount), test: ordered.slice(trainCount) };
}

export function preparedRoute(set: ReplaySet): PreparedRoute {
  const route = prepareRoute(set.path, set.stops);
  if (!route) throw new Error("The replay route has no usable path or stop order.");
  return route;
}
