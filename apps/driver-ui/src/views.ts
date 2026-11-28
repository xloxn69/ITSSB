import { formatAge } from "./format.js";
import { allIndicators, environmentLabel, formatBytes, type Indicator } from "./indicators.js";
import { ACTIONS, type ActionId, actionAvailability, parked, type ScreenId } from "./screens.js";
import { ageNow, ageOfTimestamp, type Observed, serviceAnswering } from "./snapshot.js";

/** Tiny DOM helper: every string goes in as text, never as HTML. */
export function h(
  tag: string,
  props: { class?: string; onclick?: () => void; disabled?: boolean; label?: string } = {},
  ...children: (Node | string | null | false)[]
): HTMLElement {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.onclick) el.addEventListener("click", props.onclick);
  if (props.disabled !== undefined && el instanceof HTMLButtonElement) el.disabled = props.disabled;
  if (props.label) el.setAttribute("aria-label", props.label);
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

export interface Nav {
  go(screen: ScreenId | null): void;
  action(id: ActionId): void;
}

function dot(level: string): HTMLElement {
  return h("span", { class: `dot lv-${level}` });
}

function runLabel(o: Observed): string {
  const r = o.snapshot?.run;
  if (!serviceAnswering(o) || !o.snapshot) return "Run status unknown";
  if (!r) return "No active run";
  return r.state === "active" ? `Run active (${r.runId})` : `Run ${r.state} (${r.runId})`;
}

export function statusBar(o: Observed, nav: Nav): HTMLElement {
  const inds = allIndicators(o);
  // Storage joins the bar only when space or the queue needs attention (D12).
  const shown = inds.filter(
    (i) => i.key === "gps" || i.key === "network" || i.key === "cloud" || i.key === "queue" || (i.key === "storage" && storageAlert(i)),
  );
  const service = inds.find((i) => i.key === "service");
  const driver = !serviceAnswering(o)
    ? "Driver unknown"
    : o.snapshot?.session?.unlocked
      ? (o.snapshot.session.driverName ?? "Driver unlocked")
      : "Driver locked";
  const offline = o.snapshot?.network.status === "offline";
  return h(
    "header",
    { class: "bar" },
    h(
      "div",
      { class: "who" },
      h(
        "div",
        { class: "title" },
        "ITSSB Driver",
        environmentLabel(o) ? h("span", { class: "env" }, environmentLabel(o)) : null,
      ),
      h("div", { class: "sub" }, `${runLabel(o)} · ${driver}${parked(o) ? " · Parked" : ""}`),
    ),
    service && service.level !== "ok" ? chip(service, () => nav.go("D01")) : null,
    h(
      "div",
      { class: "chips" },
      ...shown.map((i) => chip(i, () => nav.go(i.key === "network" && offline ? "D22" : "D21"))),
    ),
  );
}

function storageAlert(i: Indicator): boolean {
  return i.key === "storage" && (i.level === "warn" || i.level === "problem");
}

function chip(i: Indicator, onclick: () => void): HTMLElement {
  return h(
    "button",
    { class: `chip lv-${i.level}`, onclick, label: `${i.label}: ${i.value}` },
    dot(i.level),
    h("span", {}, h("span", { class: "k" }, i.label), h("span", { class: "v" }, i.value)),
  );
}

function checkList(items: Indicator[]): HTMLElement {
  return h(
    "div",
    { class: "checks" },
    ...items.map((i) =>
      h(
        "div",
        { class: `check lv-${i.level}` },
        dot(i.level),
        h("span", { class: "k" }, `${i.label}: ${i.value}`),
        h("span", { class: "d" }, i.detail),
      ),
    ),
  );
}

/** D01: startup and self-check. Also shown whenever the service stops answering. */
export function startupView(o: Observed): HTMLElement {
  const first = o.snapshot === null;
  const heading = first && !o.pollFailed ? "Starting up" : "Device service not answering";
  const body =
    first && !o.pollFailed
      ? "Checking the device, GPS receiver, internet, school server, and local storage."
      : "This screen cannot get current information from the bus device. Positions may still be saving; " +
        "restart the device if this does not clear in a minute, and follow your school's procedure.";
  return h(
    "main",
    { class: "page" },
    h("h1", {}, heading),
    h("p", { class: "muted" }, body),
    h("div", { class: "card" }, checkList(allIndicators(o))),
  );
}

/** D05: driver dashboard with the four original actions. */
export function dashboardView(o: Observed, nav: Nav, extra: (HTMLElement | null)[] = []): HTMLElement {
  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "actions" },
      ...ACTIONS.map((a) => {
        const av = actionAvailability(o, a.id);
        return h(
          "button",
          {
            class: "action",
            disabled: !av.enabled,
            onclick: () => nav.action(a.id),
            label: av.enabled ? a.label : `${a.label}, unavailable: ${av.reason}`,
          },
          h("span", { class: "name" }, a.label),
          av.reason ? h("span", { class: "why" }, av.reason) : null,
        );
      }),
    ),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => nav.go("D21") }, "Diagnostics"), ...extra),
  );
}

/** D13: driving view. Read-only; no complex control is rendered at all. */
export function drivingView(o: Observed, nav: Nav, extra: (HTMLElement | null)[] = []): HTMLElement {
  const inds = allIndicators(o);
  const pick = (k: Indicator["key"]) => inds.find((i) => i.key === k);
  const motion = o.snapshot?.motion?.state ?? "unknown";
  const offline = o.snapshot?.network.status === "offline";
  return h(
    "main",
    { class: "page" },
    h(
      "div",
      { class: "drive" },
      h(
        "div",
        { class: "card" },
        h("span", { class: "muted" }, "Next stop"),
        h("span", { class: "big" }, "Not available"),
        h("p", { class: "muted" }, "This device has no approved route stops for this run yet."),
      ),
      h(
        "div",
        { class: "card" },
        h("h2", {}, motion === "moving" ? "Driving" : motion === "stopped" ? "Stopped" : "Motion unknown"),
        h(
          "p",
          { class: "muted" },
          motion === "moving"
            ? "Controls are locked while the bus moves."
            : motion === "stopped"
              ? "Controls stay locked until the driver confirms the bus is parked."
              : "Controls stay locked until the bus is known to be stopped.",
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      checkList(
        [pick("gps"), pick("network"), pick("cloud"), pick("queue"), pick("storage")].filter(
          (i): i is Indicator => i !== undefined && (i.key !== "storage" || storageAlert(i)),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      ...extra,
      offline ? h("button", { class: "btn", onclick: () => nav.go("D22") }, "Offline: what still works") : null,
    ),
  );
}

/** D21: GPS and device diagnostics. Read-only; no coordinates are shown. */
export function diagnosticsView(o: Observed, nav: Nav): HTMLElement {
  const s = o.snapshot;
  const kv: [string, string][] = s
    ? [
        ["Device software", `v${s.process.version}, up ${Math.floor(s.process.uptimeS / 60)} min`],
        ["Process session", s.process.bootId.slice(0, 8)],
        ["GPS service", s.gps.gpsd + (s.gps.gpsdError ? ` (${s.gps.gpsdError})` : "")],
        ["Receivers", s.gps.receivers === null || s.gps.receivers === undefined ? "not reported yet" : String(s.gps.receivers)],
        ["Last GPS report", formatAge(ageNow(s.gps.lastReportAgeMs, o))],
        ["Last valid fix", formatAge(ageNow(s.gps.lastValidFixAgeMs, o))],
        ["Last rejected report", s.gps.lastRejectReason ?? "none"],
        ["Last internet check", formatAge(ageOfTimestamp(s.network.lastCheckedAtMs, o))],
        ["Last server success", formatAge(ageOfTimestamp(s.backend.lastOkAtMs, o))],
        [
          "Saved records",
          `${s.outbox.pending ?? "?"} waiting, ${s.outbox.acknowledged ?? "?"} accepted, ${s.outbox.rejected ?? "?"} rejected`,
        ],
        [
          "Free space",
          s.storage?.disk.freeBytes == null
            ? "not measured yet"
            : `${formatBytes(s.storage.disk.freeBytes)} (warning below ${formatBytes(s.storage.disk.warnFreeBytes)}, reduced recording below ${formatBytes(s.storage.disk.criticalFreeBytes)})`,
        ],
        ["Run", runLabel(o)],
      ]
    : [];
  return h(
    "main",
    { class: "page" },
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => nav.go(null) }, "Back"), h("h1", {}, "GPS and device diagnostics")),
    h(
      "div",
      { class: "drive" },
      h("div", { class: "card" }, checkList(allIndicators(o))),
      h("dl", { class: "card kv" }, ...kv.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    ),
  );
}

function records(n: number | null): string {
  if (n === null) return "An unknown number of records are";
  return n === 1 ? "1 record is" : `${n} records are`;
}

/** D22: offline bus operation. Says what is saved and what cannot be confirmed. */
export function offlineView(o: Observed, nav: Nav): HTMLElement {
  const s = o.snapshot;
  const pending = s?.outbox.pending ?? null;
  const lastOk = s ? ageOfTimestamp(s.backend.lastOkAtMs, o) : null;
  const active = s?.run?.state === "active";
  return h(
    "main",
    { class: "page" },
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => nav.go(null) }, "Back"), h("h1", {}, "Offline bus operation")),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Saved on this device"),
      h(
        "p",
        {},
        active
          ? `The active run keeps recording here. ${records(pending)} waiting to sync and will send when the internet returns.`
          : `${records(pending)} waiting to sync.`,
      ),
    ),
    h(
      "div",
      { class: "card" },
      h("h2", {}, "Not confirmed right now"),
      h(
        "p",
        {},
        (lastOk === null
          ? "The school server has not accepted data from this bus since the device started. "
          : `The school server last accepted data from this bus ${formatAge(lastOk)}. `) +
          "Families see the bus's last known position and its age, not where it is now. " +
          "A new run cannot start until the internet returns.",
      ),
    ),
  );
}
