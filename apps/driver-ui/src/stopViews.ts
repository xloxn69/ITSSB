import { formatAge } from "./format.js";
import type { ScreenId } from "./screens.js";
import type { Observed } from "./snapshot.js";
import { checkInText, type RosterResponse, type RosterRow, rosterRows, syncLabel } from "./students.js";
import { h } from "./views.js";

/**
 * D14 "Stopped at a bus stop" and D20 "Report a delay or issue" (docs/05 §4).
 * Views and wording only: the device service decides which stop the bus is
 * near (its own fresh fix, never an arrival), and only the school server's
 * answer makes a report "sent".
 */

// ── D14 ─────────────────────────────────────────────────────────────

export interface NearStop {
  stopId: string;
  label: string;
  sequence: number;
  distanceM: number;
}

/** `GET /api/stop`: the run's roster plus where this bus is parked. */
export interface StopResponse extends RosterResponse {
  stops: { stopId: string; label: string; sequence: number }[];
  /** "unknown" when the device has no current GPS fix. */
  position: "fresh" | "unknown";
  /** The approved stop within `nearRadiusM`, or null. */
  nearStop: NearStop | null;
  /** The closest approved stop at any distance, or null. */
  nearestStop: NearStop | null;
  nearRadiusM: number;
}

/** The heading, from the device's answer. Never "arrived" or "at": that is the server's call. */
export function stopHeading(s: StopResponse): string {
  if (s.position !== "fresh") return "Parked · position unknown";
  if (s.stops.length === 0) return "Parked · no stop locations for this run";
  if (s.nearStop) return `Stopped near ${s.nearStop.label}`;
  return "Parked · not near a stop on this route";
}

export function stopExplain(s: StopResponse): string {
  if (s.position !== "fresh") return "This device has no current GPS fix, so it cannot say which stop the bus is near.";
  if (s.stops.length === 0) return "The school server sent no stop locations for this run's route.";
  if (s.nearStop) {
    return `From this bus's own GPS: about ${s.nearStop.distanceM} m from the stop. This is not an arrival record.`;
  }
  return s.nearestStop
    ? `The nearest stop on this route is ${s.nearestStop.label}, about ${s.nearestStop.distanceM} m away.`
    : "No stop on this route is close by.";
}

/** Students assigned to the stop the bus is near, with this device's changes. Empty when not near one. */
export function expectedHere(s: StopResponse): RosterRow[] {
  const id = s.nearStop?.stopId;
  if (!id) return [];
  const here = new Set(s.students.filter((st) => st.stopId === id).map((st) => st.assignmentId));
  return rosterRows(s).filter((r) => r.onRoster && here.has(r.assignmentId));
}

export interface StopController {
  go(screen: ScreenId | null): void;
  openQr(): void;
  openStudents(): void;
}

export function stopView(
  stop: StopResponse | null,
  error: string | null,
  c: StopController,
  receivedAgoMs: number,
): HTMLElement {
  const back = h("button", { class: "btn", onclick: () => c.go("D05") }, "Dashboard");
  const links = h(
    "div",
    { class: "row" },
    h("button", { class: "btn primary", onclick: () => c.openQr() }, "Show QR code"),
    h("button", { class: "btn", onclick: () => c.openStudents() }, "Show students"),
    h("button", { class: "btn", onclick: () => c.go("D20") }, "Report a delay"),
  );
  if (!stop) {
    return h(
      "main",
      { class: "page" },
      h("div", { class: "row" }, back, h("h1", {}, "Parked")),
      error ? h("div", { class: "banner lv-problem" }, error) : h("p", { class: "muted" }, "Checking which stop the bus is near…"),
      links,
    );
  }
  const rows = expectedHere(stop);
  const age = stop.ageMs + receivedAgoMs;
  return h(
    "main",
    { class: "page" },
    h("div", { class: "row" }, back, h("h1", {}, stopHeading(stop))),
    error ? h("div", { class: "banner lv-problem" }, error) : null,
    h("p", { class: "muted" }, stopExplain(stop)),
    stop.stale
      ? h("div", { class: "banner lv-warn" }, `${stop.staleReason ?? "This roster may be out of date."} Received ${formatAge(age)}.`)
      : null,
    stop.nearStop
      ? h(
          "div",
          { class: "card list" },
          h("h2", {}, rows.length === 0 ? "No students are assigned to this stop" : `Expected at ${stop.nearStop.label}`),
          ...rows.map((r) =>
            h(
              "div",
              { class: "item" },
              h("span", { class: "name" }, r.name),
              h("span", {}, checkInText(r.checkIn)),
              r.actions[0] ? h("span", { class: `sync lv-${r.actions[0].sync === "rejected" ? "problem" : r.actions[0].sync === "synced" ? "ok" : "warn"}` }, syncLabel(r.actions[0])) : null,
            ),
          ),
        )
      : null,
    links,
  );
}

// ── D20 ─────────────────────────────────────────────────────────────

/** The fixed reasons (packages/contracts RUN_REPORT_CATEGORIES). No free text. */
export const REPORT_CATEGORIES = [
  { id: "traffic", label: "Traffic", words: "traffic" },
  { id: "mechanical", label: "Mechanical problem", words: "mechanical problem" },
  { id: "weather", label: "Weather", words: "weather" },
  { id: "student_incident", label: "Student incident", words: "student incident" },
  { id: "other", label: "Other", words: "other" },
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]["id"];

/** Expected delay choices in minutes; null is "Not sure". Within the contract's 1-120. */
export const REPORT_MINUTES = [null, 5, 10, 15, 20, 30, 45, 60] as const;

/** One report saved on this device, with what the school server said (`runReports` in /api/status). */
export interface RunReport {
  requestId: string;
  runId: string;
  category: ReportCategory;
  minutes: number | null;
  sync: "pending" | "sent" | "refused";
  capturedAtMs: number;
  resolvedAtMs: number | null;
  attempts: number;
  waitingReason: string | null;
  problem: string | null;
}

function words(category: ReportCategory): string {
  return REPORT_CATEGORIES.find((c) => c.id === category)?.words ?? category;
}

/** What families and staff will read: the same sentence the family apps show. */
export function reportSentence(category: ReportCategory, minutes: number | null): string {
  const what = `Driver reported a delay (${words(category)})`;
  return minutes === null ? what : `${what}, about ${minutes} min`;
}

/** The report's state. "Sent" only once the school server accepted it. */
export function reportSyncText(r: RunReport): { level: "ok" | "warn" | "problem"; text: string } {
  if (r.sync === "sent") return { level: "ok", text: "Sent to the school server" };
  if (r.sync === "refused") return { level: "problem", text: `Not accepted: ${r.problem ?? "no reason given"}` };
  return {
    level: "warn",
    text: r.waitingReason
      ? `Saved on this device · waiting to send: ${r.waitingReason}`
      : "Saved on this device · waiting to send to the school server",
  };
}

export interface ReportUi {
  category: ReportCategory | null;
  minutes: number | null;
  busy: boolean;
  message: { kind: "ok" | "problem" | "pending"; text: string } | null;
}

export function emptyReportUi(): ReportUi {
  return { category: null, minutes: null, busy: false, message: null };
}

export interface ReportController {
  go(screen: ScreenId | null): void;
  setReport(patch: Partial<ReportUi>): void;
  sendReport(): void;
}

export function reportView(o: Observed, ui: ReportUi, c: ReportController, deviceNowMs: number): HTMLElement {
  const runId = o.snapshot?.run?.state === "active" ? o.snapshot.run.runId : null;
  const reports = (o.snapshot?.runReports ?? []).filter((r) => r.runId === runId);
  const level = ui.message?.kind === "ok" ? "ok" : ui.message?.kind === "pending" ? "warn" : "problem";
  return h(
    "main",
    { class: "page" },
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => c.go("D14") }, "Back"), h("h1", {}, "Report a delay or issue")),
    ui.message ? h("div", { class: `banner lv-${level}` }, ui.message.text) : null,
    h("h2", {}, "Reason"),
    h(
      "div",
      { class: "row" },
      ...REPORT_CATEGORIES.map((cat) =>
        h("button", { class: `choice${ui.category === cat.id ? " selected" : ""}`, onclick: () => c.setReport({ category: cat.id }) }, cat.label),
      ),
    ),
    h("h2", {}, "Expected delay"),
    h(
      "div",
      { class: "row" },
      ...REPORT_MINUTES.map((m) =>
        h(
          "button",
          { class: `choice${ui.minutes === m ? " selected" : ""}`, onclick: () => c.setReport({ minutes: m }) },
          m === null ? "Not sure" : `${m} min`,
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      ui.category
        ? h("p", {}, `Staff and families on this trip will see: “${reportSentence(ui.category, ui.minutes)}”, with when you reported it.`)
        : h("p", { class: "muted" }, "Choose a reason. Families see the reason and minutes only, never an arrival time."),
      h(
        "button",
        { class: "btn primary", onclick: () => c.sendReport(), disabled: ui.busy || ui.category === null },
        "Send report",
      ),
    ),
    reports.length > 0
      ? h(
          "div",
          { class: "card list" },
          h("h2", {}, "Reports from this trip"),
          ...reports.map((r) => {
            const s = reportSyncText(r);
            return h(
              "div",
              { class: "item" },
              h("span", {}, `${reportSentence(r.category, r.minutes)} · ${formatAge(Math.max(0, deviceNowMs - r.capturedAtMs))}`),
              h("span", { class: `sync lv-${s.level}` }, s.text),
            );
          }),
        )
      : null,
  );
}

/** Dashboard lines: reports still waiting and any refusal, even after the run ended. */
export function reportLines(reports: RunReport[] | null | undefined): { level: "warn" | "problem"; text: string }[] {
  if (!reports) return [];
  const lines: { level: "warn" | "problem"; text: string }[] = [];
  const waiting = reports.filter((r) => r.sync === "pending").length;
  if (waiting > 0) {
    lines.push({ level: "warn", text: `${waiting} delay ${waiting === 1 ? "report is" : "reports are"} waiting to send to the school server.` });
  }
  for (const r of reports.filter((x) => x.sync === "refused").slice(0, 3)) {
    lines.push({ level: "problem", text: `${reportSentence(r.category, r.minutes)} · ${reportSyncText(r).text}` });
  }
  return lines;
}
