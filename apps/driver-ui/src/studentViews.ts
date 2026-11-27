import { keyboard } from "./flows.js";
import { formatAge } from "./format.js";
import { qrSvg } from "./qr.js";
import type { ScreenId } from "./screens.js";
import type { Observed } from "./snapshot.js";
import {
  type AttendanceStatus,
  actionText,
  checkInText,
  countdownText,
  type DeviceQrCode,
  displayCode,
  QR_MODES,
  type QrPurpose,
  qrMode,
  qrRemainingMs,
  qrShowable,
  type RosterAction,
  type RosterResponse,
  type RosterRow,
  rosterRows,
  STATUS_WORDS,
  syncLabel,
} from "./students.js";
import { h } from "./views.js";

/**
 * D15/D16 QR codes and D17-D19 roster screens. Views only: buttons call the
 * controller, and the device service and school server decide.
 */

/** Limits from packages/contracts (validateRosterAction). */
export const SEAT_MAX = 12;
export const TEXT_MAX = 200;

export interface StudentUi {
  qrPurpose: QrPurpose;
  qr: DeviceQrCode | null;
  /** performance.now() when `qr` arrived. */
  qrAt: number | null;
  qrError: string | null;
  roster: RosterResponse | null;
  /** performance.now() when `roster` arrived. */
  rosterAt: number | null;
  rosterError: string | null;
  /** Queued changes the device listed even though it could not show the roster. */
  orphanActions: RosterAction[];
  assignmentId: string | null;
  field: "seat" | "note" | "reason";
  seat: string;
  note: string;
  reason: string;
  correctStatus: AttendanceStatus;
  confirmRemove: boolean;
  message: { kind: "ok" | "problem" | "pending"; text: string } | null;
  busy: boolean;
}

export function emptyStudentUi(): StudentUi {
  return {
    qrPurpose: "trip_check_in",
    qr: null,
    qrAt: null,
    qrError: null,
    roster: null,
    rosterAt: null,
    rosterError: null,
    orphanActions: [],
    assignmentId: null,
    field: "seat",
    seat: "",
    note: "",
    reason: "",
    correctStatus: "boarded",
    confirmRemove: false,
    message: null,
    busy: false,
  };
}

export interface StudentController {
  go(screen: ScreenId | null): void;
  setStudents(patch: Partial<StudentUi>): void;
  chooseQr(purpose: QrPurpose): void;
  openStudent(assignmentId: string): void;
  record(assignmentId: string, status: AttendanceStatus): void;
  saveSeatNote(): void;
  correct(): void;
  remove(): void;
}

function banner(level: "ok" | "warn" | "problem", text: string): HTMLElement {
  return h("div", { class: `banner lv-${level}`, label: text }, text);
}

function message(ui: StudentUi): HTMLElement | null {
  if (!ui.message) return null;
  const level = ui.message.kind === "ok" ? "ok" : ui.message.kind === "pending" ? "warn" : "problem";
  return banner(level, ui.message.text);
}

function header(title: string, back: () => void): HTMLElement {
  return h("div", { class: "row" }, h("button", { class: "btn", onclick: back }, "Back"), h("h1", {}, title));
}

function button(text: string, onclick: () => void, opts: { primary?: boolean; disabled?: boolean; danger?: boolean } = {}): HTMLElement {
  const cls = opts.danger ? "btn danger" : opts.primary ? "btn primary" : "btn";
  return h("button", { class: cls, onclick, disabled: opts.disabled ?? false }, text);
}

/** A change's sync state; `what` also names the change (in the roster list). */
function syncPill(a: RosterAction, what = false): HTMLElement {
  const level = a.sync === "synced" ? "ok" : a.sync === "rejected" ? "problem" : "warn";
  return h("span", { class: `sync lv-${level}` }, what ? `${actionText(a)} · ${syncLabel(a)}` : syncLabel(a));
}

// ── D15 / D16 QR codes ──────────────────────────────────────────────

/** The QR screen. Nothing private is on it: no roster, names or notes (docs/05 §9). */
export function qrView(o: Observed, ui: StudentUi, c: StudentController, now: number, routeLabel: string | null): HTMLElement {
  const mode = qrMode(ui.qrPurpose);
  const runId = o.snapshot?.run?.state === "active" ? o.snapshot.run.runId : null;
  const code = ui.qr && ui.qr.purpose === mode.purpose ? ui.qr : null;
  const ago = ui.qrAt === null ? 0 : now - ui.qrAt;
  const showable = qrShowable(code, ago, runId);
  const scope =
    mode.purpose === "trip_check_in"
      ? `This trip: ${runId ?? "no active run"}`
      : `Route: ${routeLabel ?? code?.routeVersionId ?? "the active run's route"}`;
  const panel = (() => {
    if (code && showable) {
      const remaining = qrRemainingMs(code, ago);
      const typed = displayCode(code.token);
      return h(
        "div",
        { class: "qr-wrap" },
        h("div", { class: "qr-box" }, qrSvg(typed, `${mode.label} QR code`)),
        h(
          "div",
          { class: "card" },
          h("span", { class: "muted" }, "Or type this code"),
          h("span", { class: "typed" }, typed),
          h("span", { class: "big countdown" }, countdownText(remaining)),
          h("p", { class: "muted" }, mode.explain),
          code.refreshFailed
            ? banner("warn", "No answer from the school server, so this code cannot be renewed. It stops working when it expires.")
            : null,
        ),
      );
    }
    const why =
      code && !showable
        ? "This code expired, so it is not shown."
        : (ui.qrError ?? "Getting a code from the school server…");
    return h(
      "div",
      { class: "card qr-blank" },
      h("h2", {}, why),
      // The device's refusal already names the fallback; otherwise say it here.
      ui.qrError !== null && !(code && !showable)
        ? null
        : mode.purpose === "trip_check_in"
        ? h("p", { class: "muted" }, "Students without a phone or a working code: record them in Show Students.")
        : h("p", { class: "muted" }, "Families can also ask school staff to add them to this route."),
    );
  })();
  return h(
    "main",
    { class: "page" },
    header("Show QR code", () => c.go(null)),
    message(ui),
    h(
      "div",
      { class: "row" },
      ...QR_MODES.map((m) =>
        h(
          "button",
          { class: `choice${m.purpose === mode.purpose ? " selected" : ""}`, onclick: () => c.chooseQr(m.purpose), label: m.label },
          m.label,
        ),
      ),
    ),
    h("div", { class: "row" }, h("h2", {}, mode.label), h("span", { class: "muted" }, scope)),
    panel,
  );
}

// ── D17 roster ──────────────────────────────────────────────────────

function freshness(ui: StudentUi, now: number): HTMLElement | null {
  const r = ui.roster;
  if (!r) return null;
  const age = r.ageMs + (ui.rosterAt === null ? 0 : now - ui.rosterAt);
  if (r.stale) {
    return banner("warn", `${r.staleReason ?? "This roster may be out of date."} Received ${formatAge(age)}.`);
  }
  return h("p", { class: "muted" }, `Roster from the school server, received ${formatAge(age)}.`);
}

function studentLine(row: RosterRow): string {
  const parts = [row.stopLabel ? `Stop ${(row.stopSequence ?? 0) + 1}: ${row.stopLabel}` : "Not on the current roster"];
  if (row.seatLabel) parts.push(`Seat ${row.seatLabel}`);
  return parts.join(" · ");
}

export function rosterView(ui: StudentUi, c: StudentController, now: number): HTMLElement {
  const r = ui.roster;
  const rows = r ? rosterRows(r) : [];
  const orphan = r === null && ui.orphanActions.length > 0;
  return h(
    "main",
    { class: "page" },
    header("Students", () => c.go(null)),
    message(ui),
    ui.rosterError ? banner("problem", ui.rosterError) : null,
    freshness(ui, now),
    r === null && !ui.rosterError ? h("p", { class: "muted" }, "Loading the roster…") : null,
    r !== null && rows.length === 0 ? h("div", { class: "card" }, h("p", {}, "No students are assigned to this run.")) : null,
    h(
      "div",
      { class: "list roster" },
      ...rows.map((row) => {
        const latest = row.actions[0];
        const canRecord = row.onRoster && row.checkIn === null && !row.attendancePending && !row.removal?.startsWith("Removal pending");
        return h(
          "div",
          { class: `item student${row.onRoster ? "" : " gone"}` },
          h(
            "div",
            { class: "who" },
            h("span", { class: "name" }, row.name),
            h("span", { class: "muted" }, studentLine(row)),
            h("span", {}, row.onRoster ? checkInText(row.checkIn) : (row.removal ?? "")),
            latest ? syncPill(latest, true) : null,
          ),
          h(
            "div",
            { class: "row" },
            canRecord ? button("Boarded", () => c.record(row.assignmentId, "boarded"), { disabled: ui.busy }) : null,
            canRecord ? button("Not boarded", () => c.record(row.assignmentId, "not_boarded"), { disabled: ui.busy }) : null,
            row.onRoster ? button("Details", () => c.openStudent(row.assignmentId)) : null,
          ),
        );
      }),
    ),
    orphan
      ? h(
          "div",
          { class: "card list" },
          h("h2", {}, "Changes saved on this device"),
          ...ui.orphanActions.map((a) => h("div", { class: "item" }, h("span", {}, `${a.studentDisplayName}: ${actionText(a)}`), syncPill(a))),
        )
      : null,
  );
}

// ── D18 student detail ──────────────────────────────────────────────

function selectedRow(ui: StudentUi): RosterRow | null {
  if (!ui.roster || !ui.assignmentId) return null;
  return rosterRows(ui.roster).find((r) => r.assignmentId === ui.assignmentId) ?? null;
}

function history(row: RosterRow): HTMLElement {
  return h(
    "div",
    { class: "card list" },
    h("h2", {}, "Changes from this device"),
    ...(row.actions.length === 0
      ? [h("p", { class: "muted" }, "None.")]
      : row.actions.map((a) => h("div", { class: "item" }, h("span", {}, actionText(a)), syncPill(a)))),
  );
}

function fieldBox(label: string, value: string, active: boolean, onclick: () => void, placeholder: string): HTMLElement {
  return h(
    "button",
    { class: `field${active ? " active" : ""}`, onclick, label },
    h("span", { class: "muted" }, label),
    h("span", {}, value || placeholder),
  );
}

export function detailView(ui: StudentUi, c: StudentController, routeLabel: string | null): HTMLElement {
  const row = selectedRow(ui);
  if (!row) {
    return h("main", { class: "page" }, header("Student", () => c.go("D17")), h("p", { class: "muted" }, "This student is not on the current roster."));
  }
  const removalPending = row.removal === "Removal pending sync";
  const route = routeLabel ?? ui.roster?.routeVersionId ?? "this route";
  if (ui.confirmRemove) {
    return h(
      "main",
      { class: "page" },
      header(`Remove ${row.name}?`, () => c.setStudents({ confirmRemove: false, reason: "" })),
      message(ui),
      h(
        "div",
        { class: "split" },
        h(
          "div",
          { class: "card confirm" },
          h("h2", {}, `Remove ${row.name} from ${route}`),
          h(
            "p",
            {},
            `This asks the school server to end ${row.name}'s assignment to ${route}. Their account, guardians and past attendance stay. ` +
              "Until the server accepts it, it shows as Removal pending sync and their family can still see this bus.",
          ),
          fieldBox("Reason (required)", ui.reason, true, () => undefined, "Type the reason"),
          h(
            "div",
            { class: "row" },
            button("Cancel", () => c.setStudents({ confirmRemove: false, reason: "" })),
            button(`Remove ${row.name}`, () => c.remove(), { danger: true, disabled: ui.busy || ui.reason.trim() === "" }),
          ),
        ),
        keyboard(ui.reason, (v) => c.setStudents({ reason: v }), TEXT_MAX),
      ),
    );
  }
  const editing = ui.field === "note" ? ui.note : ui.seat;
  const limit = ui.field === "note" ? TEXT_MAX : SEAT_MAX;
  return h(
    "main",
    { class: "page" },
    header(row.name, () => c.go("D17")),
    message(ui),
    h(
      "div",
      { class: "split" },
      h(
        "div",
        { class: "card" },
        h("span", { class: "muted" }, studentLine(row)),
        h("span", {}, `Now: ${checkInText(row.checkIn)}`),
        row.removal ? h("span", { class: "sync lv-warn" }, row.removal) : null,
        fieldBox("Seat", ui.seat, ui.field === "seat", () => c.setStudents({ field: "seat" }), "No seat"),
        fieldBox("Note for drivers", ui.note, ui.field === "note", () => c.setStudents({ field: "note" }), "No note"),
        h(
          "div",
          { class: "row" },
          button("Save seat and note", () => c.saveSeatNote(), { primary: true, disabled: ui.busy || removalPending }),
          row.checkIn ? button("Correct attendance", () => c.go("D19"), { disabled: removalPending }) : null,
          button("Remove from route", () => c.setStudents({ confirmRemove: true, reason: "" }), { danger: true, disabled: removalPending }),
        ),
        history(row),
      ),
      keyboard(editing, (v) => c.setStudents(ui.field === "note" ? { note: v } : { seat: v }), limit),
    ),
  );
}

// ── D19 attendance correction ───────────────────────────────────────

export function correctionView(o: Observed, ui: StudentUi, c: StudentController): HTMLElement {
  const row = selectedRow(ui);
  const runId = o.snapshot?.run?.runId ?? "no active run";
  if (!row || !row.checkIn) {
    return h(
      "main",
      { class: "page" },
      header("Correct attendance", () => c.go("D18")),
      h("p", { class: "muted" }, "There is no record to correct for this student yet."),
    );
  }
  return h(
    "main",
    { class: "page" },
    header(`Correct attendance: ${row.name}`, () => c.go("D18")),
    message(ui),
    h(
      "div",
      { class: "split" },
      h(
        "div",
        { class: "card" },
        h("span", { class: "muted" }, `Trip ${runId}`),
        h("span", {}, `Now: ${checkInText(row.checkIn)}`),
        h(
          "div",
          { class: "row" },
          ...(["boarded", "not_boarded"] as const).map((s) =>
            h("button", { class: `choice${ui.correctStatus === s ? " selected" : ""}`, onclick: () => c.setStudents({ correctStatus: s }) }, STATUS_WORDS[s]),
          ),
        ),
        fieldBox("Reason (required)", ui.reason, true, () => undefined, "Type the reason"),
        h("p", { class: "muted" }, "The original record stays in the history. This adds a staff correction."),
        button("Save correction", () => c.correct(), { primary: true, disabled: ui.busy || ui.reason.trim() === "" }),
        history(row),
      ),
      keyboard(ui.reason, (v) => c.setStudents({ reason: v }), TEXT_MAX),
    ),
  );
}
