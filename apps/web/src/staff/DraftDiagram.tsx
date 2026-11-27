import type { DraftStop, RoutePoint } from "@itssb/contracts";

/**
 * A recorded draft's path and numbered stops, without a map provider. The
 * ordered stop list beside it carries the same information as text.
 */
export function DraftDiagram({ path, stops, label }: { path: RoutePoint[]; stops: DraftStop[]; label: string }) {
  const points = [...path, ...stops];
  if (points.length === 0) return <p className="muted">Nothing was recorded.</p>;
  const lats = points.map((p) => p.latitude);
  const lons = points.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const minLon = Math.min(...lons);
  const kx = Math.cos((((minLat + Math.max(...lats)) / 2) * Math.PI) / 180);
  const spanX = Math.max((Math.max(...lons) - minLon) * kx, 1e-6);
  const spanY = Math.max(Math.max(...lats) - minLat, 1e-6);
  const W = 1000;
  const H = Math.round(Math.min(Math.max((W * spanY) / spanX, 400), 800));
  const pad = 70;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * scale) / 2;
  const oy = (H - spanY * scale) / 2;
  const project = (p: RoutePoint) => ({
    x: ox + (p.longitude - minLon) * kx * scale,
    y: H - (oy + (p.latitude - minLat) * scale),
  });
  const line = path
    .map(project)
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return (
    <svg
      className="route-map"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label}: recorded path with ${stops.length} numbered stop${stops.length === 1 ? "" : "s"}, listed in order beside this drawing.`}
    >
      {path.length > 1 && <polyline className="route-line" points={line} />}
      {stops.map((s) => {
        const { x, y } = project(s);
        return (
          <g key={s.sequence}>
            <circle className="stop-pin" cx={x} cy={y} r={22} />
            <text x={x} y={y} className="stop-number" textAnchor="middle" dominantBaseline="central">
              {s.sequence + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
