import type { SessionInfo } from "./api.js";
import { formatAge, formatDuration } from "./format.js";
import { cloudIndicator, gpsIndicator, type Indicator, networkIndicator, storageIndicator } from "./indicators.js";
import { routeSvg } from "./routeMap.js";
import { editBlocked, parked, type ScreenId } from "./screens.js";
import type { DraftDetail, DraftSummary, Observed } from "./snapshot.js";
import { h } from "./views.js";

/**
 * Driver unlock (D04) and route recording (D06-D10). Views only: every
 * button calls the controller, and the device service decides.
 */

export interface UiState {
  draftId: string | null;
  detail: DraftDetail | null;
  drafts: DraftSummary[] | null;
  pinDriverId: string | null;
  pin: string;
  name: string;
  direction: "to_school" | "from_school";
  renameStopId: string | null;
  confirmRemoveStopId: string | null;
  message: { kind: "ok" | "problem" | "pending"; text: string } | null;
  busy: boolean;
  routeVersionId: string | null;
}

export interface Controller {
  go(screen: ScreenId | null): void;
  set(patch: Partial<UiState>): void;
  unlock(): void;
  lock(): void;
  confirmParked(): void;
  openDraft(d: DraftSummary): void;
  startRecording(): void;
  markStop(): void;
  finish(): void;
  renameStop(stopId: string): void;
  moveStop(stopId: string, position: number): void;
  removeStop(stopId: string): void;
  startRun(): void;
  endRun(): void;
}

const DIRECTION_WORDS = { to_school: "To school", from_school: "From school" } as const;

function message(ui: UiState): HTMLElement | null {
  if (!ui.message) return null;
  const level = ui.message.kind === "ok" ? "ok" : ui.message.kind === "pending" ? "warn" : "problem";
  return h("div", { class: `banner lv-${level}`, label: ui.message.text }, ui.message.text);
}

function header(title: string, back: () => void): HTMLElement {
  return h("div", { class: "row" }, h("button", { class: "btn", onclick: back }, "Back"), h("h1", {}, title));
}

function button(text: string, onclick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}): HTMLElement {
  return h("button", { class: opts.primary ? "btn primary" : "btn", onclick, disabled: opts.disabled ?? false }, text);
}

/** Confirm parked: offered only to an unlocked driver; the service still checks the fix. */
export function parkedControl(o: Observed, c: Controller, ui: UiState): HTMLElement | null {
  if (o.snapshot?.session?.unlocked !== true) return null;
  if (parked(o)) return h("span", { class: "pill lv-ok" }, "Parked");
  const motion = o.snapshot.motion?.state ?? "unknown";
  if (motion === "stopped") return button("Confirm parked", () => c.confirmParked(), { primary: true, disabled: ui.busy });
  return h("span", { class: "pill" }, motion === "moving" ? "Moving" : "Motion unknown: needs a GPS fix");
}

// ── D04 driver unlock ────────────────────────────────────────────────

export function unlockView(o: Observed, session: SessionInfo | null, ui: UiState, c: Controller): HTMLElement {
  const drivers = session?.drivers ?? [];
  const lockout = session?.lockoutRemainingS ?? 0;
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Clear", "0", "Delete"].map((k) =>
    h(
      "button",
      {
        class: "key",
        onclick: () =>
          c.set({ pin: k === "Clear" ? "" : k === "Delete" ? ui.pin.slice(0, -1) : (ui.pin + k).slice(0, 12) }),
      },
      k,
    ),
  );
  return h(
    "main",
    { class: "page" },
    header("Driver unlock", () => c.go(null)),
    message(ui),
    drivers.length === 0
      ? h(
          "div",
          { class: "card" },
          h("h2", {}, "No drivers are set up on this device"),
          h("p", { class: "muted" }, "Your transport office adds drivers to this bus device. There is no default PIN."),
        )
      : h(
          "div",
          { class: "split" },
          h(
            "div",
            { class: "card" },
            h("h2", {}, "Who is driving?"),
            ...drivers.map((d) =>
              h(
                "button",
                {
                  class: `choice${ui.pinDriverId === d.driverId ? " selected" : ""}`,
                  onclick: () => c.set({ pinDriverId: d.driverId, pin: "", message: null }),
                },
                d.displayName,
              ),
            ),
            h("p", { class: "muted" }, "Forgot your PIN? Ask your transport office to reset it."),
          ),
          h(
            "div",
            { class: "card" },
            h("div", { class: "pin", label: `${ui.pin.length} digits entered` }, ui.pin.length ? "•".repeat(ui.pin.length) : "Enter PIN"),
            h("div", { class: "keypad" }, ...keypad),
            button(lockout > 0 ? `Try again in ${lockout} s` : "Unlock", () => c.unlock(), {
              primary: true,
              disabled: ui.busy || lockout > 0 || ui.pinDriverId === null || ui.pin.length < 4,
            }),
          ),
        ),
  );
}

// ── D06 route library ───────────────────────────────────────────────

export function libraryView(o: Observed, ui: UiState, c: Controller): HTMLElement {
  const blocked = editBlocked(o);
  const recording = o.snapshot?.recording;
  return h(
    "main",
    { class: "page" },
    header("Routes on this device", () => c.go(null)),
    message(ui),
    h(
      "div",
      { class: "row" },
      recording
        ? button(`Continue recording: ${recording.name}`, () => c.openDraft(recording), { primary: true })
        : button("Record a new route", () => c.go("D07"), { primary: true, disabled: blocked !== null }),
      blocked && !recording ? h("span", { class: "muted" }, blocked) : null,
      parkedControl(o, c, ui),
    ),
    h(
      "div",
      { class: "card list" },
      h("p", { class: "muted" }, "Approved routes come from the school server, which does not send them to this device yet. These are drafts recorded here."),
      ...(ui.drafts === null
        ? [h("p", {}, "Loading…")]
        : ui.drafts.length === 0
          ? [h("p", {}, "No route drafts recorded on this device.")]
          : ui.drafts.slice(0, 6).map((d) =>
              h(
                "button",
                { class: "item", onclick: () => c.openDraft(d) },
                h("span", { class: "name" }, d.name),
                h(
                  "span",
                  { class: "muted" },
                  `${DIRECTION_WORDS[d.direction]} · ${d.stopCount} stops · ` +
                    (d.status === "recording" ? "Recording now" : "Draft, saved on this device, not submitted"),
                ),
              ),
            )),
    ),
  );
}

// ── D07 record a new route ──────────────────────────────────────────

export function keyboard(value: string, onChange: (v: string) => void, max = 60): HTMLElement {
  const rows = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
  const press = (k: string) => onChange((value + k).slice(0, max));
  return h(
    "div",
    { class: "keyboard" },
    ...rows.map((r) => h("div", { class: "keys" }, ...[...r].map((k) => h("button", { class: "key", onclick: () => press(k) }, k)))),
    h(
      "div",
      { class: "keys" },
      h("button", { class: "key wide", onclick: () => press(" ") }, "Space"),
      h("button", { class: "key", onclick: () => onChange(value.slice(0, -1)) }, "Delete"),
      h("button", { class: "key", onclick: () => onChange("") }, "Clear"),
    ),
  );
}

export function newRecordingView(o: Observed, ui: UiState, c: Controller): HTMLElement {
  const gps = gpsIndicator(o);
  const blocked = editBlocked(o) ?? (gps.level === "ok" ? null : "Recording needs a current GPS fix.");
  return h(
    "main",
    { class: "page" },
    header("Record a new route", () => c.go("D06")),
    message(ui),
    h(
      "div",
      { class: "split" },
      h(
        "div",
        { class: "card" },
        h("span", { class: "muted" }, "Route name"),
        h("div", { class: "field" }, ui.name || "Type a name"),
        h(
          "div",
          { class: "row" },
          ...(["to_school", "from_school"] as const).map((d) =>
            h("button", { class: `choice${ui.direction === d ? " selected" : ""}`, onclick: () => c.set({ direction: d }) }, DIRECTION_WORDS[d]),
          ),
        ),
        h("p", { class: `check-line lv-${gps.level}` }, `GPS: ${gps.value}. ${gps.detail}`),
        h(
          "p",
          { class: "muted" },
          "Points save on this device about once a second while you drive. Mark stops and edit names only when parked.",
        ),
        button("Start recording", () => c.startRecording(), { primary: true, disabled: ui.busy || blocked !== null || ui.name.trim() === "" }),
        blocked ? h("span", { class: "muted" }, blocked) : null,
      ),
      keyboard(ui.name, (v) => c.set({ name: v })),
    ),
  );
}

// ── D08 recording ───────────────────────────────────────────────────

export function recordingView(o: Observed, ui: UiState, c: Controller, nowMs: number): HTMLElement {
  const rec = o.snapshot?.recording ?? null;
  const d = ui.detail;
  const blocked = editBlocked(o);
  const gps = gpsIndicator(o);
  const lastPoint = rec?.lastPointCapturedAtMs ?? null;
  return h(
    "main",
    { class: "page" },
    message(ui),
    h(
      "div",
      { class: "drive" },
      h("div", { class: "card map" }, d && d.path.length + d.stops.length > 0 ? routeSvg(d.path, d.stops, 720, 400) : h("p", { class: "muted" }, "No points yet. Points appear once the GPS has a fix.")),
      h(
        "div",
        { class: "card" },
        h("h2", { class: "one-line" }, rec ? `Recording: ${rec.name}` : "Recording"),
        h(
          "dl",
          { class: "kv" },
          ...(rec
            ? [
                ["Direction", DIRECTION_WORDS[rec.direction]],
                ["Elapsed", formatDuration(nowMs - rec.startedAtMs)],
                ["Points saved", String(rec.pointCount)],
                ["GPS gaps", String(rec.gapCount)],
                ["Last point", lastPoint === null ? "none yet" : formatAge(Math.max(0, nowMs - lastPoint))],
                ["Stops", String(rec.stopCount)],
              ]
            : []
          ).flatMap(([k, v]) => [h("dt", {}, k ?? ""), h("dd", {}, v ?? "")]),
        ),
        blocked
          ? h(
              "p",
              { class: "muted" },
              parked(o) ? blocked : `GPS: ${gps.value}. Recording continues while driving; park to mark a stop or finish.`,
            )
          : null,
        h(
          "div",
          { class: "row" },
          parkedControl(o, c, ui),
          button("Mark Stop", () => c.markStop(), { primary: true, disabled: ui.busy || blocked !== null }),
          button("Edit stops", () => c.go("D09"), { disabled: blocked !== null }),
          button("Finish", () => c.finish(), { disabled: ui.busy || blocked !== null }),
        ),
      ),
    ),
  );
}

// ── D09 edit stops ──────────────────────────────────────────────────

export function editStopsView(o: Observed, ui: UiState, c: Controller): HTMLElement {
  const stops = ui.detail?.stops ?? [];
  const blocked = editBlocked(o);
  const renaming = stops.find((s) => s.stopId === ui.renameStopId);
  const back = () => c.go(ui.detail?.status === "recording" ? "D08" : "D10");
  if (renaming) {
    return h(
      "main",
      { class: "page" },
      header(`Rename stop ${renaming.position}`, () => c.set({ renameStopId: null })),
      message(ui),
      h(
        "div",
        { class: "split" },
        h(
          "div",
          { class: "card" },
          h("span", { class: "muted" }, `Now: ${renaming.name}`),
          h("div", { class: "field" }, ui.name || "Type a name"),
          button("Save name", () => c.renameStop(renaming.stopId), { primary: true, disabled: ui.busy || blocked !== null || ui.name.trim() === "" }),
        ),
        keyboard(ui.name, (v) => c.set({ name: v })),
      ),
    );
  }
  return h(
    "main",
    { class: "page" },
    header("Stops in order", back),
    message(ui),
    blocked ? h("p", { class: "muted" }, blocked) : null,
    h(
      "div",
      { class: "card list" },
      ...(stops.length === 0
        ? [h("p", {}, "No stops marked yet.")]
        : stops.map((s) =>
            ui.confirmRemoveStopId === s.stopId
              ? h(
                  "div",
                  { class: "item confirm" },
                  h("span", { class: "name" }, `Remove stop ${s.position}, ${s.name}? Later stops move up. This cannot be undone.`),
                  h(
                    "div",
                    { class: "row" },
                    button("Remove", () => c.removeStop(s.stopId), { primary: true, disabled: ui.busy || blocked !== null }),
                    button("Cancel", () => c.set({ confirmRemoveStopId: null })),
                  ),
                )
              : h(
                  "div",
                  { class: "item" },
                  h("span", { class: "name" }, `${s.position}. ${s.name}`),
                  h(
                    "div",
                    { class: "row" },
                    button("Up", () => c.moveStop(s.stopId, s.position - 1), { disabled: ui.busy || blocked !== null || s.position === 1 }),
                    button("Down", () => c.moveStop(s.stopId, s.position + 1), { disabled: ui.busy || blocked !== null || s.position === stops.length }),
                    button("Rename", () => c.set({ renameStopId: s.stopId, name: s.name }), { disabled: blocked !== null }),
                    button("Remove", () => c.set({ confirmRemoveStopId: s.stopId }), { disabled: blocked !== null }),
                  ),
                ),
          )),
    ),
  );
}

// ── D10 review ──────────────────────────────────────────────────────

export function reviewView(_o: Observed, ui: UiState, c: Controller): HTMLElement {
  const d = ui.detail;
  if (!d) return h("main", { class: "page" }, header("Review route", () => c.go("D06")), h("p", {}, "Loading…"));
  const minutes = d.finishedAtMs ? formatDuration(d.finishedAtMs - d.startedAtMs) : "still recording";
  return h(
    "main",
    { class: "page" },
    header(`Review: ${d.name}`, () => c.go("D06")),
    h(
      "div",
      { class: "drive" },
      h("div", { class: "card map" }, d.path.length + d.stops.length > 0 ? routeSvg(d.path, d.stops, 720, 400) : h("p", { class: "muted" }, "No points were recorded.")),
      h(
        "div",
        { class: "card" },
        h("div", { class: "banner lv-warn" }, "Saved on this device. Not submitted: the school server's route review cannot receive drafts from this device yet."),
        h(
          "dl",
          { class: "kv" },
          ...[
            ["Direction", DIRECTION_WORDS[d.direction]],
            ["Duration", minutes],
            ["Points", String(d.pointCount)],
            ["GPS gaps", d.gapCount === 0 ? "none" : `${d.gapCount} (dashed: not measured travel)`],
            ["Stops", String(d.stops.length)],
          ].flatMap(([k, v]) => [h("dt", {}, k ?? ""), h("dd", {}, v ?? "")]),
        ),
        h("ul", { class: "stops" }, ...d.stops.slice(0, 4).map((s) => h("li", { class: "one-line" }, `${s.position}. ${s.name}`))),
        d.stops.length > 4 ? h("p", { class: "muted" }, `and ${d.stops.length - 4} more (Edit stops shows all)`) : null,
        h("div", { class: "row" }, button("Edit stops", () => c.go("D09"))),
      ),
    ),
  );
}

// ── D12 start-trip preflight ────────────────────────────────────────

function checkRow(label: string, level: string, text: string): HTMLElement {
  return h(
    "div",
    { class: `check lv-${level}` },
    h("span", { class: `dot lv-${level}` }),
    h("span", { class: "k" }, label),
    h("span", { class: "d" }, text),
  );
}

function ind(i: Indicator, ok: string): [string, string] {
  return [i.level === "ok" ? "ok" : i.level === "problem" ? "problem" : "warn", i.level === "ok" ? ok : i.detail];
}

export function preflightView(o: Observed, session: SessionInfo | null, ui: UiState, c: Controller): HTMLElement {
  const routes = session?.routes ?? [];
  const cap = o.snapshot?.capabilities?.startRoute;
  const pending = o.snapshot?.runStart?.pending === true;
  const gps = gpsIndicator(o);
  const net = networkIndicator(o);
  const cloud = cloudIndicator(o);
  const storage = storageIndicator(o);
  const blockers: string[] = [];
  if (cap?.available !== true) blockers.push(cap?.reason ?? "This device cannot start runs.");
  if (ui.routeVersionId === null) blockers.push("Choose a route.");
  if (storage.level === "problem") blockers.push("This device is not saving positions.");
  const [gl, gt] = ind(gps, "Current fix.");
  const [nl, nt] = ind(net, "Online.");
  const [cl, ct] = ind(cloud, "Reached recently.");
  return h(
    "main",
    { class: "page" },
    header("Start a run", () => c.go(null)),
    message(ui),
    pending
      ? h("div", { class: "banner lv-warn" }, "An earlier start is still waiting for the school server's answer. Start resends that same request; it cannot create a second run.")
      : null,
    h(
      "div",
      { class: "split" },
      h(
        "div",
        { class: "card" },
        h("h2", {}, "Route"),
        ...(routes.length === 0
          ? [h("p", { class: "muted" }, "No approved routes are assigned to you on this device.")]
          : routes.map((r) =>
              h(
                "button",
                { class: `choice${ui.routeVersionId === r.routeVersionId ? " selected" : ""}`, onclick: () => c.set({ routeVersionId: r.routeVersionId }) },
                r.label,
              ),
            )),
        button(pending ? "Resend start" : "Start run", () => c.startRun(), { primary: true, disabled: ui.busy || blockers.length > 0 }),
        blockers[0] ? h("span", { class: "muted" }, blockers[0]) : null,
      ),
      h(
        "div",
        { class: "card checks" },
        checkRow("Driver", "ok", session?.driver?.displayName ?? "Unlocked"),
        checkRow("Roster", "warn", "No roster on this device: the school server does not send one yet."),
        checkRow("GPS", gl, gt),
        checkRow("Internet", nl, nt),
        checkRow("School server", cl, ct),
        checkRow("Storage", storage.level === "problem" ? "problem" : "ok", storage.level === "problem" ? storage.detail : "Positions will save on this device."),
      ),
    ),
    h("p", { class: "muted" }, "Starting needs the school server to answer. A new run never starts from this device alone."),
  );
}

// ── D23 end-trip confirmation ───────────────────────────────────────

export function endConfirmView(o: Observed, ui: UiState, c: Controller): HTMLElement {
  const run = o.snapshot?.run;
  const pending = o.snapshot?.outbox.pending ?? null;
  return h(
    "main",
    { class: "page" },
    header("End this run?", () => c.go(null)),
    message(ui),
    h(
      "div",
      { class: "card" },
      h("h2", {}, run ? `Run ${run.runId}` : "No active run"),
      h(
        "p",
        {},
        pending === null
          ? "The number of positions waiting to sync is unknown."
          : pending === 0
            ? "Every saved position has been accepted by the school server."
            : `${pending} saved ${pending === 1 ? "position is" : "positions are"} still waiting to sync. They stay on this device and send after the end.`,
      ),
      h("p", { class: "muted" }, "Ending saves the completion on this device first, then sends it to the school server. Ending the digital run does not confirm that every student has left the bus."),
      h(
        "div",
        { class: "row" },
        button("End run", () => c.endRun(), { primary: true, disabled: ui.busy || !run }),
        button("Cancel", () => c.go(null)),
      ),
    ),
  );
}

// ── D24 trip summary ────────────────────────────────────────────────

export function summaryView(o: Observed, ui: UiState, c: Controller): HTMLElement {
  const e = o.snapshot?.lastEndedRun ?? null;
  if (!e) return h("main", { class: "page" }, header("Trip summary", () => c.go(null)), h("p", {}, "No ended run on this device."));
  const sync =
    e.endSync === "accepted"
      ? ["ok", "Accepted by the school server."]
      : e.endSync === "rejected"
        ? ["problem", `Rejected by the school server (${e.endError ?? "no reason given"}). Kept on this device for review.`]
        : ["warn", `Waiting to sync. The device resends the same end until the server answers${e.endAttempts ? ` (${e.endAttempts} ${e.endAttempts === 1 ? "try" : "tries"} so far)` : ""}.`];
  return h(
    "main",
    { class: "page" },
    header("Trip summary", () => c.go(null)),
    message(ui),
    h(
      "div",
      { class: "card checks-1" },
      h("h2", {}, `Run ${e.runId}`),
      checkRow("Completed on this device", "ok", `Ended ${new Date(e.endedAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`),
      checkRow("End synced", sync[0] ?? "warn", sync[1] ?? ""),
      checkRow(
        "Positions",
        e.positionsWaiting > 0 ? "warn" : "ok",
        `${e.positionsRecorded} recorded; ${e.positionsWaiting === 0 ? "all accepted by the school server" : `${e.positionsWaiting} waiting to sync`}.`,
      ),
    ),
  );
}
