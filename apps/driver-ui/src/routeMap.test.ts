import { describe, expect, it } from "vitest";
import { routeGeometry } from "./routeMap.js";
import type { PathPoint } from "./snapshot.js";

const p = (i: number, gapBefore = false): PathPoint => ({
  capturedAtMs: 1_795_608_000_000 + i * 1000,
  latitude: 34.1 + i * 1e-4,
  longitude: -83.98,
  gapBefore,
});

describe("route drawing", () => {
  it("draws a GPS gap as a separate connector, not as measured travel", () => {
    const g = routeGeometry([p(0), p(1), p(2), p(5, true), p(6)], [], 400, 300);
    expect(g.measured).toHaveLength(2);
    expect(g.measured[0]?.split(" ")).toHaveLength(3);
    expect(g.measured[1]?.split(" ")).toHaveLength(2);
    expect(g.gaps).toHaveLength(1);
  });

  it("keeps everything inside the box and north up", () => {
    const g = routeGeometry([p(0), p(10)], [], 400, 300, 24);
    const [a, b] = (g.measured[0] ?? "").split(" ").map((s) => s.split(",").map(Number));
    expect(a?.[1]).toBeGreaterThan(b?.[1] ?? 0); // later point is further north: higher on screen
    for (const v of [a, b]) {
      expect(v?.[1]).toBeGreaterThanOrEqual(24);
      expect(v?.[1]).toBeLessThanOrEqual(276);
    }
  });

  it("places numbered stops and handles a draft with no points", () => {
    const stop = { stopId: "s", position: 1, name: "Oak St", latitude: 34.1, longitude: -83.98, capturedAtMs: 0 };
    expect(routeGeometry([], [], 400, 300)).toEqual({ measured: [], gaps: [], stops: [] });
    expect(routeGeometry([], [stop], 400, 300).stops[0]?.n).toBe(1);
  });
});
