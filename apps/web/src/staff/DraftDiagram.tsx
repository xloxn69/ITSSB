import type { DraftStop, RoutePoint } from "@itssb/contracts";

/**
 * Splits a path into runs drawn as measured travel and the single segments
 * that cross a GPS loss (the point at index `i` in `gapBeforeIndexes` was
 * recorded after the receiver lost the fix, so segment i-1 → i is a guess).
 */
export function pathSegments<P>(path: P[], gapBeforeIndexes: readonly number[] = []): { points: P[]; gap: boolean }[] {
  const gaps = new Set(gapBeforeIndexes.filter((i) => Number.isInteger(i) && i > 0 && i < path.length));
  const out: { points: P[]; gap: boolean }[] = [];
  let run: P[] = path.length > 0 ? [path[0]!] : [];
  for (let i = 1; i < path.length; i++) {
    if (gaps.has(i)) {
      if (run.length > 1) out.push({ points: run, gap: false });
      out.push({ points: [path[i - 1]!, path[i]!], gap: true });
      run = [path[i]!];
    } else {
      run.push(path[i]!);
    }
  }
  if (run.length > 1) out.push({ points: run, gap: false });
  return out;
}

/**
 * A recorded draft's path and numbered stops, without a map provider. The
 * ordered stop list beside it carries the same information as text. A
 * stretch where GPS was lost is dashed and labelled: not measured travel.
 */
export function DraftDiagram({
  path,
  stops,
  label,
  gapBeforeIndexes = [],
}: {
  path: RoutePoint[];
  stops: DraftStop[];
  label: string;
  gapBeforeIndexes?: number[];
}) {
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
  const line = (pts: RoutePoint[]) =>
    pts
      .map(project)
      .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
  const segments = pathSegments(path, gapBeforeIndexes);
  const gapCount = segments.filter((s) => s.gap).length;
  const gapWords = gapCount === 0 ? "" : ` Dashed: ${gapCount} place${gapCount === 1 ? "" : "s"} where GPS was lost, not measured travel.`;
  return (
    <svg
      className="route-map"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label}: recorded path with ${stops.length} numbered stop${stops.length === 1 ? "" : "s"}, listed in order beside this drawing.${gapWords}`}
    >
      {segments.map((s, i) => (
        <polyline key={i} className={s.gap ? "route-line gap" : "route-line"} points={line(s.points)}>
          {s.gap && <title>GPS lost here: not measured travel</title>}
        </polyline>
      ))}
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
