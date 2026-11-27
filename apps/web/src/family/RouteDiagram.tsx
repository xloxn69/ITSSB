import type { Coordinate, LivePosition, RouteGeometry } from "../tracking/model";

/**
 * The school's approved path, the assigned stop, and the bus's last
 * position, drawn as a simple diagram without a map provider (docs/12 §9:
 * keys and spend for a tile provider are the owner's decision). Text beside
 * it carries the same information for people who cannot see it.
 */
export function RouteDiagram({
  route,
  position,
  dimBus,
  busLabel,
}: {
  route: RouteGeometry;
  /** Null hides the marker: no believable position, never an invented one. */
  position: LivePosition | null;
  dimBus: boolean;
  busLabel: string;
}) {
  const points: Coordinate[] = [...route.path, route.assignedStop, ...(position ? [position] : [])];
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  // Equirectangular projection, corrected for latitude so the shape isn't stretched.
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLon - minLon) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const W = 1000;
  const H = Math.round(Math.min(Math.max((W * spanY) / spanX, 400), 800));
  const pad = 60;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * scale) / 2;
  const oy = (H - spanY * scale) / 2;
  const project = (p: Coordinate) => ({
    x: ox + (p.longitude - minLon) * kx * scale,
    y: H - (oy + (p.latitude - minLat) * scale),
  });
  const line = route.path.map(project).map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const stop = project(route.assignedStop);
  const bus = position ? project(position) : null;
  const description = `${route.routeLabel}. Your stop, ${route.assignedStop.label}, is marked.${
    position ? ` ${busLabel}'s ${dimBus ? "last known" : "latest"} position is shown.` : " No bus position is shown."
  }`;

  return (
    <figure className="stack" style={{ margin: 0, gap: "var(--space-sm)" }}>
      <svg className="route-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={description}>
        {route.path.length > 1 && <polyline className="route-line" points={line} />}
        <circle className="stop-pin" cx={stop.x} cy={stop.y} r={14} />
        {bus && <circle className={`bus-pin${dimBus ? " dim" : ""}`} cx={bus.x} cy={bus.y} r={18} />}
      </svg>
      <figcaption className="legend">
        <span>
          <i className="swatch swatch-line" aria-hidden /> Approved route
        </span>
        <span>
          <i className="swatch swatch-stop" aria-hidden /> Your stop
        </span>
        {position && (
          <span>
            <i className={`swatch swatch-bus${dimBus ? " dim" : ""}`} aria-hidden />{" "}
            {dimBus ? "Last known bus position" : busLabel}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
