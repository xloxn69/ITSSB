import {
  type DeviceMetrics,
  type DeviceSummary,
  NOTIFICATION_JOB_STATES,
  type NotificationJobAge,
  type NotificationJobState,
  type DraftDetail,
  POSITION_AGING_AFTER_MS,
  POSITION_STALE_AFTER_MS,
  RUN_REPORT_CATEGORY_LABELS,
  type RouteDirection,
  type StaffRunReport,
} from "@itssb/contracts";
import type { Tone } from "../tracking/presentation";

export const DIRECTION_LABEL: Record<RouteDirection, string> = {
  to_school: "To school",
  from_school: "From school",
};

export function dateTime(ms: number | null): string {
  if (ms === null) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

/**
 * A driver's delay or issue report for staff: the reason, the driver's
 * minutes, who, and both times (made on the bus, received), so a report
 * that waited offline reads as old.
 */
export function staffReportText(r: StaffRunReport): string {
  const what = RUN_REPORT_CATEGORY_LABELS[r.category];
  const reason = `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
  const minutes = r.expectedDelayMinutes === null ? "no delay estimate" : `about ${r.expectedDelayMinutes} min late`;
  const who = r.driverName ?? "Driver";
  return `${reason}, ${minutes} · ${who} · made ${dateTime(r.capturedAtMs)} on the bus, received ${dateTime(r.receivedAtMs)}`;
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/**
 * How long since the backend last heard from a device, for staff.
 *
 * Age uses the larger of browser-clock age and server-aligned age, so a
 * cached answer or a slow browser clock can only make contact look older.
 * A device that has not reported for the stale cutoff never looks normal
 * (docs/12 §3).
 */
export function contactStatus(
  lastContactAtMs: number | null,
  serverNowMs: number,
  receivedAtWallMs: number,
  wallNowMs: number,
  revoked: boolean,
): { text: string; tone: Tone } {
  if (revoked) return { text: "Revoked: reports are rejected", tone: "unknown" };
  if (lastContactAtMs === null) return { text: "No contact recorded", tone: "unknown" };
  const aligned = serverNowMs + (wallNowMs - receivedAtWallMs);
  const age = Math.max(0, wallNowMs - lastContactAtMs, aligned - lastContactAtMs);
  if (age >= POSITION_STALE_AFTER_MS) return { text: `Not reporting: last contact ${ago(age)}`, tone: "stale" };
  if (age >= POSITION_AGING_AFTER_MS) return { text: `Last contact ${ago(age)}`, tone: "aging" };
  return { text: `Reporting: last contact ${ago(age)}`, tone: "fresh" };
}

/** Server-aligned age (docs/12 §3): a slow browser clock can only make it older. */
function alignedAge(atMs: number, serverNowMs: number, receivedAtWallMs: number, wallNowMs: number): number {
  const aligned = serverNowMs + (wallNowMs - receivedAtWallMs);
  return Math.max(0, wallNowMs - atMs, aligned - atMs);
}

/** The heartbeat had no measurements: the device software predates them. */
export const METRICS_NOT_REPORTED = "Not reported by this device's software";
/** The device reported the field as null: it cannot measure it. */
export const METRIC_NOT_AVAILABLE = "Not available on this device";

const megabytes = (bytes: number | null) =>
  bytes === null
    ? METRIC_NOT_AVAILABLE
    : bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(2)} GB`
      : `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Device measurements for the Diagnostics page (docs/13 §10), each with the
 * age of the heartbeat it came from. Never fills a gap with zero. "Since
 * start" means since the device software last started; it resets on restart.
 */
export function deviceMetricFacts(
  // Undefined from a backend deployed before measurements existed.
  m: DeviceMetrics | null | undefined,
  serverNowMs: number,
  receivedAtWallMs: number,
  wallNowMs: number,
  heartbeatSeen = true,
): [string, string][] {
  if (m === undefined) return [["Measurements", "Not reported by this backend"]];
  if (m === null) return [["Measurements", heartbeatSeen ? METRICS_NOT_REPORTED : "No heartbeat received"]];
  const age = alignedAge(m.receivedAtMs, serverNowMs, receivedAtWallMs, wallNowMs);
  const failures =
    m.uploadConsecutiveFailures === null
      ? METRIC_NOT_AVAILABLE
      : m.uploadConsecutiveFailures === 0
        ? "None now"
        : plural(m.uploadConsecutiveFailures, "failure in a row", "failures in a row");
  return [
    ["Measured", `${ago(age)}, from the latest heartbeat`],
    ["Upload failures", failures],
    [
      "Upload retries since start",
      m.uploadRetriesSinceStart === null ? METRIC_NOT_AVAILABLE : String(m.uploadRetriesSinceStart),
    ],
    ["Last upload error", m.lastUploadErrorClass ?? "None since start"],
    ["Service memory", megabytes(m.processRssBytes)],
    ["Memory available", megabytes(m.memAvailableBytes)],
    ["CPU temperature", m.cpuTemperatureC === null ? METRIC_NOT_AVAILABLE : `${m.cpuTemperatureC.toFixed(1)} °C`],
    ["Database size", megabytes(m.databaseBytes)],
  ];
}

const JOB_STATE_LABEL: Record<NotificationJobState, string> = {
  pending: "waiting",
  in_progress: "sending",
  provider_accepted: "accepted by Apple",
  retryable_failure: "waiting to retry",
  permanent_failure: "failed",
  expired: "expired unsent",
  cancelled: "cancelled",
};

/** Push outbox age and recent outcomes, for staff (docs/10 §9). */
export function notificationJobFacts(
  // Undefined from a backend deployed before job age existed.
  n: NotificationJobAge | undefined,
  serverNowMs: number,
  receivedAtWallMs: number,
  wallNowMs: number,
): [string, string][] {
  if (n === undefined) return [["Push jobs", "Not reported by this backend"]];
  const atLeast = n.truncated ? "at least " : "";
  const oldest =
    n.oldestWaitingCreatedAtMs === null
      ? "Nothing waiting"
      : `${atLeast}${n.waitingCount} waiting; oldest created ${ago(alignedAge(n.oldestWaitingCreatedAtMs, serverNowMs, receivedAtWallMs, wallNowMs))}`;
  const counts = NOTIFICATION_JOB_STATES.filter((s) => n.countsByState[s] > 0).map(
    (s) => `${n.countsByState[s]} ${JOB_STATE_LABEL[s]}`,
  );
  const hours = Math.round(n.windowMs / 3_600_000);
  return [
    ["Waiting to send", oldest],
    [`Created in the last ${hours} h`, counts.length ? `${atLeast}${counts.join(", ")}` : "None"],
  ];
}

/** Approval is offered only for a waiting draft with no blocking check. */
export function approvalBlocker(draft: Pick<DraftDetail, "status" | "checks">): string | null {
  if (draft.status === "approved") return "This draft is approved.";
  if (draft.status === "rejected") return "This draft was rejected.";
  if (draft.checks.some((c) => c.severity === "blocking")) return "Fix the blocking problems before approving.";
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "telemetry:12,live:1" from a retention sweep, in words; null when unreadable. */
export function sweepSummary(deleted: string | null): string | null {
  const m = deleted ? /^telemetry:(\d+),live:(\d+)(?:,reports:(\d+))?$/.exec(deleted) : null;
  if (!m) return null;
  const [positions, live, reports] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const parts = [plural(positions, "position", "positions"), plural(live, "last-known position", "last-known positions")];
  if (reports > 0) parts.push(plural(reports, "driver delay report", "driver delay reports"));
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} deleted`;
}

/**
 * A maintenance window from a `datetime-local` value (the browser's time
 * zone) and a length in hours, or null when either is unusable.
 */
export function maintenanceWindow(startLocal: string, hours: number): { startsAtMs: number; endsAtMs: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startLocal)) return null;
  const startsAtMs = new Date(startLocal).getTime();
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(hours) || hours <= 0 || hours > 12) return null;
  return { startsAtMs, endsAtMs: startsAtMs + Math.round(hours * 60) * 60_000 };
}

/** "Sat, Nov 28" for a `YYYY-MM-DD` service date, read as that calendar day. */
export function serviceDateLabel(serviceDate: string): string {
  const [y, m, d] = serviceDate.split("-").map(Number);
  if (!y || !m || !d) return serviceDate;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
    Date.UTC(y, m - 1, d),
  );
}

/**
 * Cancel and replace are offered for every active run, including one on a
 * revoked bus: revoking mid-run leaves the run active and its route occupied,
 * and only staff can clear it.
 */
export function runActionsAvailable(device: Pick<DeviceSummary, "activeRun" | "revoked">): boolean {
  return device.activeRun !== null;
}

/** Stands in for the PIN hash, which is made on the Pi. The Pi refuses the file until it is replaced. */
export const PIN_HASH_PLACEHOLDER = "<paste the hash-pin output here>";

/**
 * The Pi's drivers-file entry for an issued grant (apps/device
 * `load_drivers`): it goes inside `{"drivers": [ ... ]}` in
 * `/etc/itssb/drivers.json`, replacing any older entry for the same driver.
 * The PIN hash is never made in the browser: it comes from `hash-pin` on the
 * Pi, so the entry carries a placeholder the Pi refuses until it is replaced.
 */
export function driversFileEntry(issued: {
  driverUserId: string;
  driverName: string;
  grant: string;
  routeVersions: { routeVersionId: string; label: string }[];
}): string {
  return JSON.stringify(
    {
      driverId: issued.driverUserId,
      displayName: issued.driverName,
      pinHash: PIN_HASH_PLACEHOLDER,
      operatingGrant: issued.grant,
      routeVersions: issued.routeVersions.map(({ routeVersionId, label }) => ({ routeVersionId, label })),
    },
    null,
    2,
  );
}

/** A staff invitation's state for the list. Only a pending one can be revoked. */
export function invitationState(
  i: { revoked: boolean; usedAtMs: number | null; expiresAtMs: number },
  serverNowMs: number,
): { text: string; pending: boolean } {
  if (i.usedAtMs !== null) return { text: `Joined ${dateTime(i.usedAtMs)}`, pending: false };
  if (i.revoked) return { text: "Revoked", pending: false };
  if (i.expiresAtMs <= serverNowMs) return { text: "Expired", pending: false };
  return { text: `Waiting, valid until ${dateTime(i.expiresAtMs)}`, pending: true };
}
