import type { DraftStop, PathPoint } from "./snapshot.js";

/**
 * A plain recorded-path drawing (docs/05 §6, §9): no basemap, no tiles, so it
 * works offline and claims nothing about roads. Measured travel is a solid
 * line; a GPS gap is a separate dashed connector, never part of the line.
 */

export interface Geometry {
  /** Measured runs, each an SVG polyline "x,y x,y". */
  measured: string[];
  /** Straight connectors across GPS gaps: [x1, y1, x2, y2]. */
  gaps: [number, number, number, number][];
  stops: { n: number; x: number; y: number }[];
}

export function routeGeometry(path: PathPoint[], stops: DraftStop[], width: number, height: number, pad = 24): Geometry {
  const pts = [...path.map((p) => [p.latitude, p.longitude]), ...stops.map((s) => [s.latitude, s.longitude])] as [number, number][];
  if (pts.length === 0) return { measured: [], gaps: [], stops: [] };
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  // Equirectangular: shrink longitude by cos(latitude) so shapes are not stretched.
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLon - minLon) * k, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const xy = (lat: number, lon: number): [number, number] => [
    Math.round((offX + (lon - minLon) * k * scale) * 10) / 10,
    Math.round((height - offY - (lat - minLat) * scale) * 10) / 10,
  ];

  const measured: string[] = [];
  const gaps: Geometry["gaps"] = [];
  let run: string[] = [];
  let prev: [number, number] | null = null;
  for (const p of path) {
    const cur = xy(p.latitude, p.longitude);
    if (p.gapBefore && prev) {
      if (run.length > 1) measured.push(run.join(" "));
      gaps.push([prev[0], prev[1], cur[0], cur[1]]);
      run = [];
    }
    run.push(`${cur[0]},${cur[1]}`);
    prev = cur;
  }
  if (run.length > 1) measured.push(run.join(" "));
  return {
    measured,
    gaps,
    stops: stops.map((s) => {
      const [x, y] = xy(s.latitude, s.longitude);
      return { n: s.position, x, y };
    }),
  };
}

const SVG = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function routeSvg(path: PathPoint[], stops: DraftStop[], width: number, height: number): SVGElement {
  const g = routeGeometry(path, stops, width, height);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, class: "route", role: "img" });
  svg.setAttribute("aria-label", `Recorded path with ${stops.length} stops and ${g.gaps.length} GPS gaps`);
  for (const line of g.measured) svg.append(el("polyline", { points: line, class: "measured" }));
  for (const [x1, y1, x2, y2] of g.gaps) svg.append(el("line", { x1, y1, x2, y2, class: "gap" }));
  for (const s of g.stops) {
    svg.append(el("circle", { cx: s.x, cy: s.y, r: 14, class: "stop" }));
    const t = el("text", { x: s.x, y: s.y, class: "stop-n", "text-anchor": "middle", "dominant-baseline": "central" });
    t.textContent = String(s.n);
    svg.append(t);
  }
  return svg;
}
