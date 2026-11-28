import type { RunState } from "./index.js";
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

  // Measurements for staff diagnostics (docs/13 §10). Optional: a Pi from
  // before them omits every one. `null` means the Pi cannot measure it.
  /** Telemetry requests that failed in a row; 0 after a success. */
  uploadConsecutiveFailures?: number;
  /** Failed telemetry requests since the device software started. */
  uploadRetriesSinceStart?: number;
  /** Class of the last failure (an exception name or `http_NNN`), kept after recovery. */
  lastUploadErrorClass?: string | null;
  /** Resident memory of the device service. */
  processRssBytes?: number | null;
  /** Memory the Pi's kernel reports as available. */
  memAvailableBytes?: number | null;
  /** SoC temperature, °C, one decimal. */
  cpuTemperatureC?: number | null;
  /** SQLite database plus write-ahead log. */
  databaseBytes?: number | null;
}

/** The measurement keys, all optional (an older Pi sends none). */
export const DEVICE_HEALTH_METRIC_KEYS = [
  "uploadConsecutiveFailures",
  "uploadRetriesSinceStart",
  "lastUploadErrorClass",
  "processRssBytes",
  "memAvailableBytes",
  "cpuTemperatureC",
  "databaseBytes",
] as const;

/** Bounds a temperature must fall in; anything else is a broken sensor. */
export const MIN_CPU_TEMPERATURE_C = -40;
export const MAX_CPU_TEMPERATURE_C = 150;
/** An exception class name or `http_NNN`: never a message, host or path. */
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * The server's state of the run the report named, sent only when that run
 * belongs to the reporting device (another device's run, or an unknown one,
 * gets no `run`). This is how a Pi with no GPS fix, which uploads no
 * telemetry, still learns that staff cancelled its run (docs/13 D14).
 */
export interface DeviceRunStatus {
  runId: string;
  state: RunState;
  /** When staff cancelled the run; `null` unless `state` is `cancelled`. */
  cancelledAtMs: number | null;
}

/** HTTP 200 body. The backend assigns `receivedAtMs`. */
export interface DeviceHealthAccepted {
  schemaVersion: 1;
  status: "accepted";
  receivedAtMs: number;
  serverNowMs: number;
  /** Absent when the report named no run of this device, and from older backends. */
  run?: DeviceRunStatus;
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
  ...DEVICE_HEALTH_METRIC_KEYS,
]);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTemperature = (v: unknown) =>
  v === null ||
  (typeof v === "number" && Number.isFinite(v) && v >= MIN_CPU_TEMPERATURE_C && v <= MAX_CPU_TEMPERATURE_C);
const absentOr = (r: Record<string, unknown>, key: string, ok: (v: unknown) => boolean) =>
  !(key in r) || ok(r[key]);

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
  for (const key of ["uploadConsecutiveFailures", "uploadRetriesSinceStart"]) {
    if (!absentOr(r, key, isCount)) return invalid(`${key} must be a non-negative integer.`);
  }
  for (const key of ["processRssBytes", "memAvailableBytes", "databaseBytes"]) {
    if (!absentOr(r, key, (v) => v === null || isCount(v))) return invalid(`${key} must be bytes or null.`);
  }
  if (!absentOr(r, "lastUploadErrorClass", (v) => v === null || (typeof v === "string" && ERROR_CLASS.test(v)))) {
    return invalid("lastUploadErrorClass must be an error class name or null.");
  }
  if (!absentOr(r, "cpuTemperatureC", isTemperature)) return invalid("cpuTemperatureC must be a plausible temperature or null.");
  return { ok: true, report: r as unknown as DeviceHealthReport };
}
