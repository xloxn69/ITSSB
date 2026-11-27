import { MAX_FUTURE_SKEW_MS } from "./validate.js";

/**
 * Device health heartbeat from the Pi (docs/08 §7): `POST /device/v1/health`.
 *
 * It lets the backend tell "online without a GPS fix" from "no device
 * contact". The device is identified by its bearer credential; nothing in
 * the body names a device or grants scope. It carries no coordinates,
 * secrets, or student data.
 */

/** Upper bound for one health body. */
export const MAX_HEALTH_BODY_BYTES = 2 * 1024;

/** How often the Pi sends health while it can reach the backend. */
export const HEALTH_INTERVAL_MS = 30_000;

/**
 * Receiver state as the Pi measured it. `unknown` means the Pi could not ask
 * GPSD (service down); families see it as no GPS status (`null`).
 */
export const DEVICE_GPS_STATUSES = ["valid", "no_fix", "receiver_missing", "unknown"] as const;
export type DeviceGpsStatus = (typeof DEVICE_GPS_STATUSES)[number];

export interface DeviceHealthReport {
  schemaVersion: 1;
  /** Fresh UUID per collector process start. */
  bootId: string;
  /** Device time the report was made, UTC epoch milliseconds. */
  capturedAtMs: number;
  /** Device software version, at most 32 characters. */
  appVersion: string;
  /** The run the Pi is recording, or `null`. Informational; never grants scope. */
  runId: string | null;
  gpsStatus: DeviceGpsStatus;
  /** Capture time of the last valid fix this process saw, or `null`. */
  lastValidFixAtMs: number | null;
  /** Outbox rows not yet acknowledged. */
  pendingCount: number;
  /** Capture time of the oldest unacknowledged row, or `null`. */
  oldestPendingCapturedAtMs: number | null;
}

/** HTTP 200 body. The backend assigns `receivedAtMs`. */
export interface DeviceHealthAccepted {
  schemaVersion: 1;
  status: "accepted";
  receivedAtMs: number;
  serverNowMs: number;
}

export type DeviceHealthValidation =
  | { ok: true; report: DeviceHealthReport }
  | { ok: false; code: "INVALID_REQUEST" | "UNSUPPORTED_SCHEMA_VERSION"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isMs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNullableMs = (v: unknown): v is number | null => v === null || isMs(v);
const invalid = (message: string): DeviceHealthValidation => ({ ok: false, code: "INVALID_REQUEST", message });

const KEYS = new Set([
  "schemaVersion",
  "bootId",
  "capturedAtMs",
  "appVersion",
  "runId",
  "gpsStatus",
  "lastValidFixAtMs",
  "pendingCount",
  "oldestPendingCapturedAtMs",
]);

/**
 * Validates a health report. `nowMs` is the receiver's clock; a report from
 * the future is refused so it can never mask later reports.
 */
export function validateDeviceHealthReport(input: unknown, nowMs: number): DeviceHealthValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("Body must be an object.");
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message: "Unsupported protocol version." };
  }
  for (const key of Object.keys(r)) if (!KEYS.has(key)) return invalid(`Unknown field ${key}.`);
  if (typeof r.bootId !== "string" || !UUID.test(r.bootId)) return invalid("bootId must be a UUID.");
  if (!isMs(r.capturedAtMs)) return invalid("capturedAtMs must be epoch milliseconds.");
  if (r.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS) return invalid("capturedAtMs is too far in the future.");
  if (typeof r.appVersion !== "string" || r.appVersion.length === 0 || r.appVersion.length > 32) {
    return invalid("appVersion must be 1-32 characters.");
  }
  if (r.runId !== null && (typeof r.runId !== "string" || r.runId.length === 0 || r.runId.length > 64)) {
    return invalid("runId must be null or an ID.");
  }
  if (!DEVICE_GPS_STATUSES.includes(r.gpsStatus as DeviceGpsStatus)) return invalid("Unknown gpsStatus.");
  if (!isNullableMs(r.lastValidFixAtMs) || !isNullableMs(r.oldestPendingCapturedAtMs)) {
    return invalid("Timestamps must be epoch milliseconds or null.");
  }
  if (!isMs(r.pendingCount)) return invalid("pendingCount must be a non-negative integer.");
  return { ok: true, report: r as unknown as DeviceHealthReport };
}
