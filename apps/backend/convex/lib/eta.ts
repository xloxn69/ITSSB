/**
 * Transparent baseline arrival estimate (docs/10 §3): remaining path distance
 * to the stop at a configured cruise speed, plus a configured dwell at each
 * intervening stop the bus has not left. Pure code, shared with the
 * evaluation script (apps/backend/eval).
 *
 * It never divides by the bus's instantaneous speed: at a red light that
 * would approach zero.
 */
import { ETA_VALID_FOR_MS } from "@itssb/contracts";
import type { PreparedRoute, ProgressState } from "./routeProgress";

export interface BaselineParams {
  algorithmVersion: string;
  /** Average speed over the route including traffic, not a speed limit. */
  cruiseSpeedMps: number;
  /** Expected time spent at each intervening stop. */
  dwellMs: number;
}

/**
 * Parameters tuned on the training split of the fictional replay runs by
 * `bun run eval` (apps/backend/eval). Retune from representative real runs
 * before a pilot; change `algorithmVersion` whenever a value changes.
 */
export const BASELINE_V1: BaselineParams = {
  algorithmVersion: "baseline-v1",
  cruiseSpeedMps: 8,
  dwellMs: 30_000,
};

/**
 * Remaining milliseconds until the bus reaches `stopId`, or null when no
 * honest estimate exists: the latest fix did not match the route, the stop is
 * unknown, or the bus is already at or past it.
 */
export function remainingMs(
  route: PreparedRoute,
  state: ProgressState,
  stopId: string,
  params: BaselineParams,
): number | null {
  if (state.lastStatus !== "on_route") return null;
  const target = route.stops.findIndex((s) => s.stopId === stopId);
  const outcome = state.stops[target];
  if (target < 0 || !outcome || outcome.arrivedAtMs !== null || outcome.departedAtMs !== null) return null;
  const travelMs = (Math.max(0, route.stops[target]!.alongM - state.alongM) / params.cruiseSpeedMps) * 1000;
  let dwellMs = 0;
  for (let i = 0; i < target; i++) if (state.stops[i]!.departedAtMs === null) dwellMs += params.dwellMs;
  return travelMs + dwellMs;
}

export interface Prediction {
  arrivalAtMs: number;
  validUntilMs: number;
}

/**
 * The estimate is anchored to the observation's capture time, so an old
 * position yields an arrival already in the past and a validity that has
 * already ended, rather than a fresh-looking countdown.
 */
export function predictArrival(
  route: PreparedRoute,
  state: ProgressState,
  stopId: string,
  params: BaselineParams,
  capturedAtMs: number,
): Prediction | null {
  const ms = remainingMs(route, state, stopId, params);
  if (ms === null) return null;
  return { arrivalAtMs: capturedAtMs + Math.round(ms), validUntilMs: capturedAtMs + ETA_VALID_FOR_MS };
}
