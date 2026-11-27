import { describe, expect, it } from "vitest";
import {
  advance,
  initialProgress,
  locate,
  nextStopId,
  prepareRoute,
  type RouteStopInput,
  stopStatus,
} from "./lib/routeProgress";

/** Fictional coordinates only. */
const BASE = { latitude: 34.1, longitude: -83.99 };
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((BASE.latitude * Math.PI) / 180);

/** A point `east` and `north` meters from BASE. */
function at(east: number, north = 0) {
  return { latitude: BASE.latitude + north / M_PER_DEG_LAT, longitude: BASE.longitude + east / M_PER_DEG_LON };
}

/** A dense straight path: one point every `stepM` meters for `lengthM`. */
function densePath(lengthM: number, stepM = 10) {
  const path = [];
  for (let d = 0; d <= lengthM; d += stepM) path.push(at(d));
  return path;
}

function stop(stopId: string, sequence: number, east: number, north = 0): RouteStopInput {
  return { stopId, sequence, ...at(east, north) };
}

function fix(east: number, north: number, capturedAtMs: number) {
  return { ...at(east, north), horizontalAccuracyM: 5, capturedAtMs };
}

const T0 = 1_795_600_000_000;

describe("prepareRoute", () => {
  it("places stops along a dense path in travel order", () => {
    const route = prepareRoute(densePath(5000), [stop("a", 0, 1000), stop("b", 1, 3000, 8), stop("c", 2, 4500)]);
    expect(route).not.toBeNull();
    expect(route!.points).toHaveLength(501);
    expect(route!.totalM).toBeCloseTo(5000, -1);
    expect(route!.stops.map((s) => Math.round(s.alongM))).toEqual([1000, 3000, 4500]);
  });

  it("projects a stop on a loop onto the leg its sequence implies, not the nearest leg", () => {
    // Out 2 km east and back on the same street. Stop "back" is at the same
    // place as stop "out" but comes later in the run.
    const out = densePath(2000);
    const back = out.toReversed().slice(1);
    const route = prepareRoute([...out, ...back], [stop("out", 0, 500), stop("back", 1, 500)]);
    expect(route!.stops.map((s) => Math.round(s.alongM))).toEqual([500, 3500]);
  });

  it("refuses to guess an order for stops without a sequence", () => {
    const route = prepareRoute(densePath(1000), [{ stopId: "a", sequence: undefined, ...at(500) }]);
    expect(route).toBeNull();
  });

  it("refuses a path with fewer than two points", () => {
    expect(prepareRoute([at(0)], [stop("a", 0, 0)])).toBeNull();
  });
});

describe("route progress", () => {
  const route = prepareRoute(densePath(5000), [stop("a", 0, 1000), stop("b", 1, 3000), stop("c", 2, 4500)])!;

  it("tracks distance along a dense path from sparse fixes", () => {
    let state = initialProgress(route, T0);
    for (let i = 1; i <= 20; i++) state = advance(route, state, fix(i * 50, 3, T0 + i * 5000));
    expect(state.lastStatus).toBe("on_route");
    expect(state.alongM).toBeCloseTo(1000, -1);
    expect(nextStopId(route, state)).toBe("a");
  });

  it("marks a stop arrived then passed once, despite GPS jitter at its boundary", () => {
    let state = initialProgress(route, T0);
    let t = T0;
    for (let d = 50; d <= 950; d += 50) state = advance(route, state, fix(d, 0, (t += 5000)));
    // Jitter around the arrival boundary.
    for (const d of [975, 965, 980, 968, 990, 1000, 995]) state = advance(route, state, fix(d, 2, (t += 3000)));
    expect(stopStatus(route, state, "a")).toBe("at_stop");
    const arrived = state.stops.find((s) => s.stopId === "a")!.arrivedAtMs;
    expect(arrived).not.toBeNull();
    for (const d of [1020, 1040, 1080, 1120]) state = advance(route, state, fix(d, 0, (t += 5000)));
    expect(stopStatus(route, state, "a")).toBe("passed");
    expect(state.stops.find((s) => s.stopId === "a")!.arrivedAtMs).toBe(arrived);
    // Noise behind the stop after departure never re-arrives it.
    state = advance(route, state, fix(1000, 0, (t += 5000)));
    expect(stopStatus(route, state, "a")).toBe("passed");
    expect(nextStopId(route, state)).toBe("b");
  });

  it("a bus on a parallel street is off route and never serves the stop", () => {
    let state = initialProgress(route, T0);
    let t = T0;
    for (let d = 50; d <= 900; d += 50) state = advance(route, state, fix(d, 0, (t += 5000)));
    for (const d of [950, 1000, 1050, 1100]) state = advance(route, state, fix(d, 150, (t += 5000)));
    expect(state.lastStatus).toBe("off_route");
    expect(stopStatus(route, state, "a")).toBe("upcoming");
    expect(state.alongM).toBeCloseTo(900, -1);
  });

  it("an implausible jump far ahead is not accepted", () => {
    let state = initialProgress(route, T0);
    state = advance(route, state, fix(100, 0, T0 + 10_000));
    state = advance(route, state, fix(4400, 0, T0 + 15_000));
    expect(state.lastStatus).toBe("off_route");
    expect(stopStatus(route, state, "b")).toBe("upcoming");
    expect(state.alongM).toBeCloseTo(100, -1);
  });

  it("follows the outbound leg of a loop, then the return leg, from previous progress", () => {
    const out = densePath(2000);
    const loop = prepareRoute([...out, ...out.toReversed().slice(1)], [stop("out", 0, 500), stop("back", 1, 500)])!;
    let state = initialProgress(loop, T0);
    let t = T0;
    for (let d = 50; d <= 2000; d += 50) state = advance(loop, state, fix(d, 0, (t += 5000)));
    expect(stopStatus(loop, state, "out")).toBe("passed");
    expect(stopStatus(loop, state, "back")).toBe("upcoming");
    for (let d = 1950; d >= 400; d -= 50) state = advance(loop, state, fix(d, 0, (t += 5000)));
    expect(state.alongM).toBeCloseTo(3600, -1);
    expect(stopStatus(loop, state, "back")).toBe("passed");
  });

  it("with no usable prior, a position on two legs is ambiguous", () => {
    const out = densePath(2000);
    const loop = prepareRoute([...out, ...out.toReversed().slice(1)], [stop("out", 0, 500), stop("back", 1, 500)])!;
    // The run began long ago (offline gap), so the search window spans both legs.
    const state = initialProgress(loop, T0);
    const result = locate(loop, state, fix(700, 0, T0 + 60 * 60_000));
    expect(result.status).toBe("ambiguous");
    const next = advance(loop, state, fix(700, 0, T0 + 60 * 60_000));
    expect(next.lastStatus).toBe("ambiguous");
    expect(next.alongM).toBe(0);
  });
});
