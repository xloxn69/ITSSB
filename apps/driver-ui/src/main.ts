import { fetchSnapshot } from "./api.js";
import { type ActionId, type ScreenId, selectScreen } from "./screens.js";
import type { DeviceSnapshot, Observed } from "./snapshot.js";
import { css } from "./styles.js";
import { dashboardView, diagnosticsView, drivingView, type Nav, offlineView, startupView, statusBar } from "./views.js";

/**
 * Driver touchscreen shell (docs/05). The device service owns run state; this
 * page only shows its latest snapshot and asks for screens. A reload fetches
 * a fresh snapshot and lands on whatever screen that state allows.
 */

const POLL_MS = 1_000;

const style = document.createElement("style");
style.textContent = css;
document.head.append(style);

let snapshot: DeviceSnapshot | null = null;
let receivedAt: number | null = null; // performance.now() when `snapshot` arrived
let pollFailed = false;
let requested: ScreenId | null = null;

function observed(): Observed {
  return {
    snapshot,
    elapsedMs: receivedAt === null ? null : performance.now() - receivedAt,
    pollFailed,
  };
}

const nav: Nav = {
  go(screen) {
    requested = screen;
    render();
  },
  action(_id: ActionId) {
    // Action screens arrive with their device endpoints; until then every
    // action is disabled by the service's capability report.
  },
};

function render(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return;
  const o = observed();
  const screen = selectScreen(o, requested);
  const view =
    screen === "D01"
      ? startupView(o)
      : screen === "D13"
        ? drivingView(o, nav)
        : screen === "D21"
          ? diagnosticsView(o, nav)
          : screen === "D22"
            ? offlineView(o, nav)
            : dashboardView(o, nav);
  view.dataset["screen"] = screen;
  swap(app, 0, statusBar(o, nav));
  swap(app, 1, view);
}

/**
 * Replaces a region only when its content changed. Rebuilding the DOM under
 * a finger every second would drop taps that land mid-rebuild.
 */
function swap(app: HTMLElement, index: number, next: HTMLElement): void {
  const current = app.children[index];
  if (current === undefined) app.append(next);
  else if (current.outerHTML !== next.outerHTML) current.replaceWith(next);
}

async function poll(): Promise<void> {
  try {
    snapshot = await fetchSnapshot();
    receivedAt = performance.now();
    pollFailed = false;
  } catch {
    pollFailed = true;
  }
  render();
}

async function pollForever(): Promise<void> {
  // One request at a time: a slow answer never stacks up overlapping polls.
  for (;;) {
    await poll();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

render();
void pollForever();
// Ages advance between polls even if the service goes quiet.
setInterval(render, 1_000);
