import {
  MAX_ROUTE_PATH_POINTS,
  ROUTE_GAP_WARNING_M,
  type RouteCheck,
  type RoutePoint,
  STOP_OFF_PATH_WARNING_M,
} from "@itssb/contracts";

const EARTH_RADIUS_M = 6_371_000;

const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: RoutePoint, b: RoutePoint): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function validPoint(p: RoutePoint): boolean {
  return (
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}

/**
 * Review checks for a recorded draft (docs/12 §4). `blocking` checks prevent
 * approval; warnings are shown to the reviewer, who decides.
 */
export function routeChecks(
  path: RoutePoint[],
  stops: (RoutePoint & { label: string })[],
  gapBeforeIndexes: readonly number[] = [],
): RouteCheck[] {
  const checks: RouteCheck[] = [];
  if (path.length < 2) {
    checks.push({ code: "too_few_points", severity: "blocking", message: "The path needs at least two points." });
  }
  if (path.length > MAX_ROUTE_PATH_POINTS) {
    checks.push({
      code: "too_many_points",
      severity: "blocking",
      message: `The path has ${path.length} points; at most ${MAX_ROUTE_PATH_POINTS} are allowed.`,
    });
  }
  if (![...path, ...stops].every(validPoint)) {
    checks.push({ code: "invalid_coordinate", severity: "blocking", message: "A point has an impossible coordinate." });
    return checks;
  }
  if (stops.length === 0) {
    checks.push({ code: "no_stops", severity: "blocking", message: "The route has no stops." });
  }
  let gaps = 0;
  for (let i = 1; i < path.length; i++) {
    if (distanceM(path[i - 1]!, path[i]!) > ROUTE_GAP_WARNING_M) gaps++;
  }
  if (gaps > 0) {
    checks.push({
      code: "path_gap",
      severity: "warning",
      message: `${gaps} gap${gaps === 1 ? "" : "s"} longer than ${ROUTE_GAP_WARNING_M} m in the recording.`,
    });
  }
  // GPS lost while recording (flagged on the Pi), however short: the line
  // across it is drawn, not measured, and must not pass as driven road.
  const lost = new Set(gapBeforeIndexes.filter((i) => Number.isInteger(i) && i > 0 && i < path.length)).size;
  if (lost > 0) {
    checks.push({
      code: "gap_in_recording",
      severity: "warning",
      message: `GPS was lost ${lost} time${lost === 1 ? "" : "s"} while recording. The dashed line${lost === 1 ? " is" : "s are"} not measured travel; check the road there.`,
    });
  }
  for (const stop of stops) {
    const nearest = path.length ? Math.min(...path.map((p) => distanceM(p, stop))) : Infinity;
    if (nearest > STOP_OFF_PATH_WARNING_M) {
      checks.push({
        code: "stop_off_path",
        severity: "warning",
        message: `${stop.label} is more than ${STOP_OFF_PATH_WARNING_M} m from the recorded path.`,
      });
    }
  }
  return checks;
}
