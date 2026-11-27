import createQr from "qrcode-generator";

/**
 * QR rendering for D15/D16. The payload is whatever the device service got
 * from the school server; nothing here creates or changes a code.
 */

const QUIET_ZONE = 4; // modules of light margin the QR standard asks for
const SVG_NS = "http://www.w3.org/2000/svg";

/** Dark (true) and light modules, row by row. */
export function qrMatrix(text: string): boolean[][] {
  const qr = createQr(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_row, r) => Array.from({ length: n }, (_col, c) => qr.isDark(r, c)));
}

/** One SVG built with DOM calls (no HTML strings). Colors come from styles.ts. */
export function qrSvg(text: string, label: string): SVGSVGElement {
  const m = qrMatrix(text);
  const size = m.length + QUIET_ZONE * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("class", "qr-light");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  svg.append(bg);
  let d = "";
  m.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }),
  );
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "qr-dark");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
