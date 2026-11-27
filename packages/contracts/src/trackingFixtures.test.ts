import { describe, expect, it } from "vitest";
import freshnessPolicy from "../fixtures/freshnessPolicy.json" with { type: "json" };
import myAssignmentsReady from "../fixtures/myAssignments.ready.json" with { type: "json" };
import myRouteAccessUnavailable from "../fixtures/myRoute.accessUnavailable.json" with { type: "json" };
import myRouteReady from "../fixtures/myRoute.ready.json" with { type: "json" };
import myRunAccessUnavailable from "../fixtures/myRun.accessUnavailable.json" with { type: "json" };
import myRunNoActiveRun from "../fixtures/myRun.noActiveRun.json" with { type: "json" };
import myRunReady from "../fixtures/myRun.ready.json" with { type: "json" };
import myRunReadyNoPosition from "../fixtures/myRun.readyNoPosition.json" with { type: "json" };
import myRunStale from "../fixtures/myRun.stale.json" with { type: "json" };
import serverTime from "../fixtures/serverTime.json" with { type: "json" };
import { ROUTE_GAP_WARNING_M } from "./staff.js";
import { MAX_ROUTE_PATH_POINTS, POSITION_STALE_AFTER_MS } from "./tracking.js";
import { trackingFixtureFiles } from "./trackingFixtures.js";

const json: Record<keyof typeof trackingFixtureFiles, unknown> = {
  "myAssignments.ready": myAssignmentsReady,
  "myRun.ready": myRunReady,
  "myRun.readyNoPosition": myRunReadyNoPosition,
  "myRun.stale": myRunStale,
  "myRun.noActiveRun": myRunNoActiveRun,
  "myRun.accessUnavailable": myRunAccessUnavailable,
  "myRoute.ready": myRouteReady,
  "myRoute.accessUnavailable": myRouteAccessUnavailable,
  freshnessPolicy,
  serverTime,
};

describe("tracking fixtures", () => {
  it.each(Object.keys(trackingFixtureFiles) as (keyof typeof trackingFixtureFiles)[])(
    "fixtures/%s.json matches the typed fixture (run `bun run fixtures` if not)",
    (name) => {
      expect(json[name]).toEqual(trackingFixtureFiles[name]);
    },
  );

  it("keeps nullable fields present as explicit null", () => {
    const run = trackingFixtureFiles["myRun.readyNoPosition"];
    expect(run.status).toBe("ready");
    if (run.status !== "ready") return;
    for (const key of ["lastPosition", "gpsStatus", "lastDeviceContactAtMs", "nextStopId", "eta"] as const) {
      expect(run.run).toHaveProperty(key, null);
    }
  });

  it("access_unavailable carries no protected route fields", () => {
    for (const r of [myRunAccessUnavailable, myRouteAccessUnavailable]) {
      expect(Object.keys(r).toSorted()).toEqual(["reason", "schemaVersion", "serverNowMs", "status"]);
    }
  });

  it("the stale fixture is actually past the stale cutoff", () => {
    const r = trackingFixtureFiles["myRun.stale"];
    if (r.status !== "ready" || !r.run.lastPosition) throw new Error("expected a position");
    expect(r.serverNowMs - r.run.lastPosition.capturedAtMs).toBeGreaterThan(POSITION_STALE_AFTER_MS);
  });

  it("route geometry respects the point bound", () => {
    const r = trackingFixtureFiles["myRoute.ready"];
    if (r.status !== "ready") throw new Error("expected ready");
    expect(r.path.length).toBeLessThanOrEqual(MAX_ROUTE_PATH_POINTS);
  });

  // Maps draw straight segments between points, so a sparse path cuts
  // across blocks instead of following the road.
  it("route geometry is dense enough to follow the road (at most 25 m between points)", () => {
    const r = trackingFixtureFiles["myRoute.ready"];
    if (r.status !== "ready") throw new Error("expected ready");
    const gaps = r.path.slice(1).map((p, i) => distanceM(r.path[i]!, p));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(25);
    expect(Math.max(...gaps)).toBeLessThan(ROUTE_GAP_WARNING_M);
  });

  it("the assigned stop and the bus positions lie on the route", () => {
    const route = trackingFixtureFiles["myRoute.ready"];
    const runs = [trackingFixtureFiles["myRun.ready"], trackingFixtureFiles["myRun.stale"]];
    if (route.status !== "ready") throw new Error("expected ready");
    const onPath = (p: { latitude: number; longitude: number }) =>
      Math.min(...route.path.map((q) => distanceM(p, q)));
    expect(onPath(route.assignedStop)).toBeLessThan(1);
    for (const r of runs) {
      if (r.status !== "ready" || !r.run.lastPosition) throw new Error("expected a position");
      expect(onPath(r.run.lastPosition)).toBeLessThan(1);
      expect(onPath(r.run.assignedStop)).toBeLessThan(1);
    }
  });
});

/** Great-circle distance in metres. */
function distanceM(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}
