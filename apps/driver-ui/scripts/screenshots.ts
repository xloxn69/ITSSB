/**
 * Captures every driver-screen student and route-review state from the development gallery
 * (`gallery.html`), light and dark, at the Pi touchscreen size, with
 * fictional data only. Usage: `bun run screenshots [outDir]`. Images are
 * never committed. SCREENSHOT_PORT picks the dev server port; CHROMIUM_PATH
 * an installed headless Chromium.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const STATES = [
  "qr-check-in",
  "qr-join",
  "qr-refresh-failed",
  "qr-expired",
  "qr-unavailable",
  "roster",
  "roster-pending",
  "roster-stale",
  "roster-rejected",
  "detail",
  "detail-confirm-remove",
  "correction",
  "dashboard-changes",
  "storage-warning",
  "storage-critical",
  "review-library",
  "review-draft",
  "review-pending",
  "review-refused",
  "review-awaiting",
  "review-approved",
  "review-rejected",
  "diagnostics-measured",
  "diagnostics-unavailable",
];

const outDir = process.argv[2] ?? "build/screenshots";
mkdirSync(outDir, { recursive: true });
const port = Number(process.env.SCREENSHOT_PORT ?? 5182);
const server = await createServer({ configFile: join(import.meta.dirname, "../vite.config.ts"), server: { port, strictPort: true } });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  for (const colorScheme of ["light", "dark"] as const) {
    // The seven-inch Touch Display 2 in landscape.
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, colorScheme });
    for (const state of STATES) {
      await page.goto(`http://localhost:${port}/gallery.html?state=${state}`);
      await page.waitForSelector("body[data-ready=true]");
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(outDir, `driver-${state}-${colorScheme}.png`), fullPage: true });
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`Wrote ${STATES.length * 2} screenshots to ${outDir}`);
