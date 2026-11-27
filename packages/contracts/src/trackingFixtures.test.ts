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
});
