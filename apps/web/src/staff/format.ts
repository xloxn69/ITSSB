import {
  type DeviceSummary,
  type DraftDetail,
  POSITION_AGING_AFTER_MS,
  POSITION_STALE_AFTER_MS,
  type RouteDirection,
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
  const m = deleted ? /^telemetry:(\d+),live:(\d+)$/.exec(deleted) : null;
  if (!m) return null;
  const [positions, live] = [Number(m[1]), Number(m[2])];
  return `${plural(positions, "position", "positions")} and ${plural(live, "last-known position", "last-known positions")} deleted`;
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
