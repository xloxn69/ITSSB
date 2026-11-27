/**
 * Captures every fixture screen at phone and desktop width, light and dark,
 * with fictional data only. Usage: `bun run screenshots [outDir]`.
 * CI uploads the result as the "web-screenshots" artifact; images are never
 * committed. Set CHROMIUM_PATH to use an already installed headless Chromium.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { FIXTURE_SCREENS } from "../src/dev/screens";

const outDir = process.argv[2] ?? "build/screenshots";
mkdirSync(outDir, { recursive: true });

const server = await createServer({ configFile: join(import.meta.dirname, "../vite.config.ts"), server: { port: 5181, strictPort: true } });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const widths = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
try {
  for (const [size, viewport] of Object.entries(widths)) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
      for (const screen of FIXTURE_SCREENS) {
        await page.goto(`http://localhost:5181/${screen.path}`);
        await page.waitForSelector(screen.ready ?? "main h1, main h2");
        await page.waitForTimeout(150);
        await page.screenshot({ path: join(outDir, `${screen.name}-${size}-${colorScheme}.png`), fullPage: true });
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`Wrote ${FIXTURE_SCREENS.length * 4} screenshots to ${outDir}`);
