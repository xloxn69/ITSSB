import { ETA_VALID_FOR_MS, POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { describe, expect, it } from "vitest";
import { BASELINE_V1, predictArrival, remainingMs } from "./lib/eta";
import { advance, initialProgress, prepareRoute, type RouteStopInput } from "./lib/routeProgress";

/** Fictional coordinates only. */
const BASE = { latitude: 34.1, longitude: -83.99 };
const M_PER_DEG_LON = ((6_371_000 * Math.PI) / 180) * Math.cos((BASE.latitude * Math.PI) / 180);
const at = (east: number) => ({ latitude: BASE.latitude, longitude: BASE.longitude + east / M_PER_DEG_LON });
const stop = (stopId: string, sequence: number, east: number): RouteStopInput => ({ stopId, sequence, ...at(east) });

const path = Array.from({ length: 401 }, (_, i) => at(i * 10));
const route = prepareRoute(path, [stop("s1", 0, 1100), stop("s2", 1, 2300), stop("s3", 2, 2900)])!;
const T0 = 1_795_600_000_000;

describe("baseline ETA (docs/10 §3)", () => {
  // The docs' fictional example: 270 s of remaining travel plus 25 s and
  // 35 s of dwell at the two intervening stops is 330 s.
  it("adds remaining travel and intervening-stop dwell", () => {
    const state = advance(route, initialProgress(route, T0), {
      ...at(200),
      horizontalAccuracyM: 5,
      capturedAtMs: T0 + 30_000,
    });
    const params = { algorithmVersion: "test", cruiseSpeedMps: 10, dwellMs: 30_000 };
    // 2700 m at 10 m/s = 270 s; two intervening stops at 30 s each = 60 s.
    expect(remainingMs(route, state, "s3", params)).toBeCloseTo(330_000, -3);
  });

  it("anchors the arrival to the observation and expires before the position goes stale", () => {
    const capturedAtMs = T0 + 30_000;
    const state = advance(route, initialProgress(route, T0), { ...at(200), horizontalAccuracyM: 5, capturedAtMs });
    const p = predictArrival(route, state, "s3", BASELINE_V1, capturedAtMs)!;
    expect(p.arrivalAtMs).toBe(capturedAtMs + Math.round(remainingMs(route, state, "s3", BASELINE_V1)!));
    expect(p.validUntilMs).toBe(capturedAtMs + ETA_VALID_FOR_MS);
    expect(ETA_VALID_FOR_MS).toBeLessThan(POSITION_STALE_AFTER_MS);
  });

  it("gives no estimate for a stop the bus is at or has passed", () => {
    let state = initialProgress(route, T0);
    let t = T0;
    for (let d = 50; d <= 1200; d += 50) {
      state = advance(route, state, { ...at(d), horizontalAccuracyM: 5, capturedAtMs: (t += 5000) });
    }
    expect(remainingMs(route, state, "s1", BASELINE_V1)).toBeNull();
    expect(predictArrival(route, state, "s1", BASELINE_V1, t)).toBeNull();
    expect(remainingMs(route, state, "s2", BASELINE_V1)).not.toBeNull();
  });

  it("gives no estimate when the latest position is off route or ambiguous", () => {
    let state = advance(route, initialProgress(route, T0), {
      ...at(200),
      horizontalAccuracyM: 5,
      capturedAtMs: T0 + 30_000,
    });
    state = advance(route, state, {
      latitude: BASE.latitude + 0.002,
      longitude: at(250).longitude,
      horizontalAccuracyM: 5,
      capturedAtMs: T0 + 35_000,
    });
    expect(state.lastStatus).toBe("off_route");
    expect(predictArrival(route, state, "s3", BASELINE_V1, T0 + 35_000)).toBeNull();
  });
});
