/**
 * Captures every fixture screen at phone and desktop width, light and dark,
 * with fictional data only. Usage: `bun run screenshots [outDir]`.
 * CI uploads the result as the "web-screenshots" artifact; images are never
 * committed. Set CHROMIUM_PATH to use an already installed headless Chromium,
 * SCREENSHOT_PORT to avoid a port another run holds, and SCREENSHOT_FILTER
 * (a substring of the screen name) to capture only some screens.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { FIXTURE_SCREENS } from "../src/dev/screens";

const outDir = process.argv[2] ?? "build/screenshots";
mkdirSync(outDir, { recursive: true });

const port = Number(process.env.SCREENSHOT_PORT ?? 5181);
const filter = process.env.SCREENSHOT_FILTER ?? "";
const screens = FIXTURE_SCREENS.filter((s) => s.name.includes(filter));
const server = await createServer({ configFile: join(import.meta.dirname, "../vite.config.ts"), server: { port, strictPort: true } });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const widths = { phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 800 } } as const;
try {
  for (const [size, viewport] of Object.entries(widths)) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
      // Screens with `click` steps accept every confirmation dialog.
      page.on("dialog", (dialog) => void dialog.accept());
      for (const screen of screens) {
        // A fresh load per screen, so one screen's clicks never leak into the next.
        await page.goto("about:blank");
        await page.goto(`http://localhost:${port}/${screen.path}`);
        await page.waitForSelector(screen.ready ?? "main h1, main h2");
        for (const selector of screen.steps?.open ?? []) await page.locator(selector).first().click();
        for (const [selector, value] of screen.steps?.fill ?? []) await page.fill(selector, value);
        for (const [selector, value] of screen.steps?.select ?? []) await page.selectOption(selector, value);
        for (const selector of screen.steps?.check ?? []) await page.check(selector);
        if (screen.steps?.click) await page.click(screen.steps.click);
        for (const selector of screen.click ?? []) {
          await page.locator(selector).first().click();
        }
        if (screen.after) await page.waitForSelector(screen.after);
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
console.log(`Wrote ${screens.length * 4} screenshots to ${outDir}`);
