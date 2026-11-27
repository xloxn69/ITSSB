import { ApiError, api, currentSession, fetchSession, fetchSnapshot, noAnswer, RequestIds } from "./api.js";
import {
  type Controller,
  editStopsView,
  endConfirmView,
  libraryView,
  newRecordingView,
  recordingView,
  reviewView,
  parkedControl,
  preflightView,
  summaryView,
  type UiState,
  unlockView,
} from "./flows.js";
import { type ActionId, parked as parkedNow, type ScreenId, selectScreen } from "./screens.js";
import type { DeviceSnapshot, DraftSummary, Observed } from "./snapshot.js";
import { css } from "./styles.js";
import { dashboardView, diagnosticsView, drivingView, type Nav, offlineView, startupView, statusBar } from "./views.js";

/**
 * Driver touchscreen shell (docs/05). The device service owns run state,
 * the driver session, motion, and drafts; this page shows its latest
 * snapshot and sends commands. A reload fetches a fresh snapshot and lands on
 * whatever screen that state allows.
 */

const POLL_MS = 1_000;
const DETAIL_SCREENS: ReadonlySet<ScreenId> = new Set(["D08", "D09", "D10"]);

const style = document.createElement("style");
style.textContent = css;
document.head.append(style);

let snapshot: DeviceSnapshot | null = null;
let receivedAt: number | null = null; // performance.now() when `snapshot` arrived
let pollFailed = false;
let requested: ScreenId | null = null;
let shown: ScreenId = "D01";
const ids = new RequestIds();

const ui: UiState = {
  draftId: null,
  detail: null,
  drafts: null,
  pinDriverId: null,
  pin: "",
  name: "",
  direction: "to_school",
  renameStopId: null,
  confirmRemoveStopId: null,
  message: null,
  busy: false,
  routeVersionId: null,
};

function observed(): Observed {
  return {
    snapshot,
    elapsedMs: receivedAt === null ? null : performance.now() - receivedAt,
    pollFailed,
  };
}

/** Device clock "now", advanced locally between snapshots. */
function deviceNowMs(o: Observed): number {
  return (o.snapshot?.generatedAtMs ?? Date.now()) + (o.elapsedMs ?? 0);
}

async function refreshDetail(): Promise<void> {
  const id = ui.draftId ?? snapshot?.recording?.draftId ?? null;
  if (!id) return;
  try {
    ui.detail = await api.draft(id);
    ui.draftId = id;
  } catch {
    // Keep the last detail; the status bar already says if the service is down.
  }
}

async function refreshDrafts(): Promise<void> {
  try {
    ui.drafts = (await api.drafts()).drafts;
  } catch (err) {
    ui.drafts = [];
    ui.message = { kind: "problem", text: err instanceof ApiError ? err.message : "Could not load drafts." };
  }
}

/**
 * Runs one command. `action` names the logical action for requestId reuse:
 * after a timeout, the next tap resends the same id; after any answer, the
 * next tap is new.
 */
async function run(action: string | null, fn: () => Promise<unknown>, done?: string): Promise<boolean> {
  if (ui.busy) return false;
  ui.busy = true;
  ui.message = action ? { kind: "pending", text: "Saving on this device…" } : null;
  render();
  try {
    await fn();
    if (action) ids.answered(action);
    const msg: UiState["message"] = done ? { kind: "ok", text: done } : null;
    ui.message = msg;
    // A confirmation is news, not state: clear it so it never reads as current later.
    if (msg) {
      setTimeout(() => {
        if (ui.message === msg) {
          ui.message = null;
          render();
        }
      }, 5_000);
    }
    return true;
  } catch (err) {
    if (action && !noAnswer(err)) ids.answered(action);
    ui.message = {
      kind: "problem",
      text: err instanceof ApiError ? err.message : "No answer from the device. Tap again to retry the same action.",
    };
    return false;
  } finally {
    ui.busy = false;
    void poll();
  }
}

const ctl: Controller & Nav = {
  go(screen) {
    requested = screen;
    ui.message = null;
    ui.renameStopId = null;
    ui.confirmRemoveStopId = null;
    if (screen === "D04") {
      ui.pin = "";
      void fetchSession().then(render, render);
    }
    if (screen === "D06") {
      ui.drafts = null;
      void refreshDrafts().then(render);
    }
    if (screen === "D07") ui.name = "";
    if (screen !== null && DETAIL_SCREENS.has(screen)) void refreshDetail().then(render);
    render();
  },
  action(id: ActionId) {
    if (id === "startRoute") {
      const routes = currentSession()?.routes ?? [];
      ui.routeVersionId = snapshot?.runStart?.routeVersionId ?? (routes.length === 1 ? (routes[0]?.routeVersionId ?? null) : ui.routeVersionId);
      void fetchSession().then(render, render);
      this.go("D12");
      return;
    }
    if (id === "recordRoute") {
      const rec = snapshot?.recording;
      if (rec) this.openDraft(rec);
      else this.go("D06");
    }
  },
  set(patch) {
    Object.assign(ui, patch);
    render();
  },
  unlock() {
    const driverId = ui.pinDriverId;
    const pin = ui.pin;
    ui.pin = ""; // never keep the PIN around after one attempt
    if (!driverId) return;
    void run(null, () => api.unlock(driverId, pin)).then(async (ok) => {
      await fetchSession().catch(() => null);
      if (ok) ctl.go(null);
      else render();
    });
  },
  lock() {
    void run(null, () => api.lock()).then(() => ctl.go(null));
  },
  confirmParked() {
    void run(null, () => api.confirmParked(), "Parked confirmed.");
  },
  openDraft(d: DraftSummary) {
    ui.draftId = d.draftId;
    ui.detail = null;
    this.go(d.status === "recording" ? "D08" : "D10");
  },
  startRecording() {
    const name = ui.name.trim();
    void run("startRecording", async () => {
      const d = await api.startRecording(ids.for("startRecording"), name, ui.direction);
      ui.draftId = d.draftId;
    }, "Recording started. Points save on this device.").then((ok) => {
      if (ok) ctl.go("D08");
    });
  },
  markStop() {
    const id = ui.draftId;
    if (!id) return;
    void run("markStop", () => api.markStop(id, ids.for("markStop")), "Stop saved on this device.").then(refreshDetail).then(render);
  },
  finish() {
    const id = ui.draftId;
    if (!id) return;
    void run(null, () => api.finish(id), "Draft saved on this device. Not submitted.").then(async (ok) => {
      if (ok) {
        await refreshDetail();
        requested = "D10";
      }
      render();
    });
  },
  renameStop(stopId) {
    const id = ui.draftId;
    if (!id) return;
    void run(null, () => api.renameStop(id, stopId, ui.name.trim()), "Name saved on this device.").then(async () => {
      ui.renameStopId = null;
      await refreshDetail();
      render();
    });
  },
  moveStop(stopId, position) {
    const id = ui.draftId;
    if (!id) return;
    void run(null, () => api.moveStop(id, stopId, position)).then(refreshDetail).then(render);
  },
  startRun() {
    const route = ui.routeVersionId;
    if (!route) return;
    void run("startRun", async () => {
      const r = await api.startRun(ids.for("startRun"), route);
      if (r.status !== "accepted") {
        // No answer: keep this requestId; the device keeps the pending request too.
        throw new ApiError(503, "SERVER_NO_ANSWER", r.message ?? "No answer from the school server.");
      }
    }, "Run started. The school server accepted it.").then((ok) => {
      if (ok) ctl.go(null);
    });
  },
  endRun() {
    const runId = snapshot?.run?.runId;
    if (!runId) return;
    void run("endRun", async () => {
      const r = await api.endRun(runId, ids.for("endRun"));
      if (r.message) ui.message = { kind: "problem", text: r.message };
    }).then((ok) => {
      if (ok) ctl.go("D24");
    });
  },
  removeStop(stopId) {
    const id = ui.draftId;
    if (!id) return;
    void run(null, () => api.removeStop(id, stopId), "Stop removed.").then(async () => {
      ui.confirmRemoveStopId = null;
      await refreshDetail();
      render();
    });
  },
};

function dashboardControls(o: Observed): (HTMLElement | null)[] {
  const s = o.snapshot?.session;
  if (!s) return [];
  const lockBtn = document.createElement("button");
  lockBtn.className = s.unlocked ? "btn" : "btn primary";
  lockBtn.textContent = s.unlocked ? "Lock" : "Unlock driver";
  lockBtn.addEventListener("click", () => (s.unlocked ? ctl.lock() : ctl.go("D04")));
  const extra: (HTMLElement | null)[] = [lockBtn, parkedControl(o, ctl, ui)];
  if (s.unlocked && o.snapshot?.run?.state === "active") {
    const end = document.createElement("button");
    end.className = "btn";
    end.textContent = "End run";
    end.disabled = !parkedNow(o);
    end.addEventListener("click", () => ctl.go("D23"));
    extra.push(end);
  }
  if (s.unlocked && o.snapshot?.lastEndedRun && !o.snapshot.run) {
    const last = document.createElement("button");
    last.className = "btn";
    last.textContent = "Last trip";
    last.addEventListener("click", () => ctl.go("D24"));
    extra.push(last);
  }
  return extra;
}

function render(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return;
  const o = observed();
  const screen = selectScreen(o, requested);
  if (screen !== shown) {
    // A forced change (the bus moved, the service restarted) drops half-typed input.
    if (DETAIL_SCREENS.has(screen) && !DETAIL_SCREENS.has(shown)) void refreshDetail().then(render);
    if (screen === "D04") void fetchSession().then(render, () => undefined);
    shown = screen;
  }
  const view = (() => {
    switch (screen) {
      case "D01":
        return startupView(o);
      case "D04":
        return unlockView(o, currentSession(), ui, ctl);
      case "D06":
        return libraryView(o, ui, ctl);
      case "D07":
        return newRecordingView(o, ui, ctl);
      case "D08":
        return recordingView(o, ui, ctl, deviceNowMs(o));
      case "D09":
        return editStopsView(o, ui, ctl);
      case "D10":
        return reviewView(o, ui, ctl);
      case "D12":
        return preflightView(o, currentSession(), ui, ctl);
      case "D13":
        return drivingView(o, ctl, [parkedControl(o, ctl, ui)]);
      case "D23":
        return endConfirmView(o, ui, ctl);
      case "D24":
        return summaryView(o, ui, ctl);
      case "D21":
        return diagnosticsView(o, ctl);
      case "D22":
        return offlineView(o, ctl);
      default:
        return dashboardView(o, ctl, dashboardControls(o));
    }
  })();
  view.dataset["screen"] = screen;
  swap(app, 0, statusBar(o, ctl));
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

let polling = false;
let polls = 0;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    snapshot = await fetchSnapshot();
    receivedAt = performance.now();
    pollFailed = false;
    // Keep the open draft current while recording (every few seconds).
    if (DETAIL_SCREENS.has(shown) && ++polls % 3 === 0) await refreshDetail();
  } catch {
    pollFailed = true;
  } finally {
    polling = false;
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
void fetchSession().catch(() => null);
void pollForever();
// Ages advance between polls even if the service goes quiet.
setInterval(render, 1_000);
