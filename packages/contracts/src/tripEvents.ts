import type { RunState } from "./index.js";

/**
 * Online run start and end from the Pi (docs/08 §6):
 * `POST /device/v1/trip-events`.
 *
 * The device is identified by its bearer credential. The body carries a
 * server-issued driver operating grant; a device credential alone never
 * starts or ends a run. `requestId` is persisted on the Pi before sending
 * and reused on every retry, so a retry returns the original result.
 */

/** Upper bound for one trip-event body. */
export const MAX_TRIP_EVENT_BODY_BYTES = 8 * 1024;

export interface StartRunRequest {
  schemaVersion: 1;
  requestId: string;
  type: "startRun";
  driverOperatingGrant: string;
  routeVersionId: string;
  /** Local service date in `serviceTimezone`, `YYYY-MM-DD`. */
  serviceDate: string;
  /** IANA time zone, e.g. `America/New_York`. */
  serviceTimezone: string;
  capturedAtMs: number;
}

export interface EndRunRequest {
  schemaVersion: 1;
  requestId: string;
  type: "endRun";
  driverOperatingGrant: string;
  runId: string;
  capturedAtMs: number;
  /** Highest `runSequence` the Pi recorded for this run; `null` if none. */
  lastRunSequence: number | null;
}

export type TripEventRequest = StartRunRequest | EndRunRequest;

/**
 * HTTP 200 for a start or end the server accepted, now or on an earlier
 * attempt with the same `requestId` (the stored result is returned as is).
 */
export interface TripEventAccepted {
  schemaVersion: 1;
  requestId: string;
  status: "accepted";
  runId: string;
  state: RunState;
  /** Server time the run started. */
  startedAtMs: number;
  /** Server time the run ended; `null` while active. */
  endedAtMs: number | null;
  serverNowMs: number;
}

/**
 * Request-level failure codes for trip events, sent in the shared
 * `RequestError` body (docs/08 §5) with this HTTP status:
 *
 * - 400 `INVALID_REQUEST`, `MALFORMED_JSON`, `UNSUPPORTED_SCHEMA_VERSION`,
 *   `CLOCK_OUT_OF_RANGE` (capture time implausible for the server clock or
 *   the run), `SERVICE_DATE_OUT_OF_RANGE` (not today in `serviceTimezone`)
 * - 401 `UNAUTHENTICATED` (device credential)
 * - 403 `GRANT_NOT_AUTHORIZED` (unknown, expired, revoked, another device's,
 *   or route outside the grant), `RUN_NOT_AUTHORIZED` (unknown or another
 *   device's run; deliberately indistinguishable)
 * - 409 `REQUEST_ID_CONFLICT` (same `requestId`, different content),
 *   `ACTIVE_RUN_CONFLICT` (device or route already has an active run),
 *   `RUN_NOT_ACTIVE` (end of a run already ended by another request)
 * - 413 `BODY_TOO_LARGE`
 */
export type TripEventErrorCode =
  | "INVALID_REQUEST"
  | "MALFORMED_JSON"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNAUTHENTICATED"
  | "GRANT_NOT_AUTHORIZED"
  | "RUN_NOT_AUTHORIZED"
  | "SERVICE_DATE_OUT_OF_RANGE"
  | "CLOCK_OUT_OF_RANGE"
  | "REQUEST_ID_CONFLICT"
  | "ACTIVE_RUN_CONFLICT"
  | "RUN_NOT_ACTIVE"
  | "BODY_TOO_LARGE";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT = /^[A-Za-z0-9._~+/=-]{32,512}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const isSafeNonNegativeInt = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The `YYYY-MM-DD` local date of `atMs` in `timeZone`. */
export function localDate(atMs: number, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(atMs));
}

/**
 * The UTC instant `date` (`YYYY-MM-DD`) ends in `timeZone`: the next local
 * day's midnight. Handles 23- and 25-hour days at daylight-saving changes.
 */
export function endOfLocalDayMs(date: string, timeZone: string): number {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  const nextMidnightAsUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  // Subtract the zone's offset; re-measure it at the result for a change near midnight.
  let atMs = nextMidnightAsUtc - zoneOffsetMs(nextMidnightAsUtc, timeZone);
  atMs = nextMidnightAsUtc - zoneOffsetMs(atMs, timeZone);
  return atMs;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `atMs`. */
function zoneOffsetMs(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wallAsUtc - Math.floor(atMs / 1000) * 1000;
}

export type TripEventValidation =
  | { ok: true; request: TripEventRequest }
  | { ok: false; code: "INVALID_REQUEST" | "UNSUPPORTED_SCHEMA_VERSION"; message: string };

const invalid = (message: string): TripEventValidation => ({ ok: false, code: "INVALID_REQUEST", message });

/** Validates a trip-event body against the v1 contract. Pure; no clock. */
export function validateTripEventRequest(input: unknown): TripEventValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("Body must be an object.");
  }
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    return { ok: false, code: "UNSUPPORTED_SCHEMA_VERSION", message: "Unsupported protocol version." };
  }
  if (typeof r.requestId !== "string" || !UUID.test(r.requestId)) return invalid("requestId must be a UUID.");
  if (typeof r.driverOperatingGrant !== "string" || !GRANT.test(r.driverOperatingGrant)) {
    return invalid("driverOperatingGrant is required.");
  }
  if (!isSafeNonNegativeInt(r.capturedAtMs)) return invalid("capturedAtMs must be epoch milliseconds.");

  if (r.type === "startRun") {
    if (!isId(r.routeVersionId)) return invalid("routeVersionId is required.");
    if (!isCalendarDate(r.serviceDate)) return invalid("serviceDate must be YYYY-MM-DD.");
    if (!isValidTimeZone(r.serviceTimezone)) return invalid("serviceTimezone must be an IANA time zone.");
    return {
      ok: true,
      request: {
        schemaVersion: 1,
        requestId: r.requestId,
        type: "startRun",
        driverOperatingGrant: r.driverOperatingGrant,
        routeVersionId: r.routeVersionId,
        serviceDate: r.serviceDate,
        serviceTimezone: r.serviceTimezone,
        capturedAtMs: r.capturedAtMs,
      },
    };
  }
  if (r.type === "endRun") {
    if (!isId(r.runId)) return invalid("runId is required.");
    if (r.lastRunSequence !== null && !isSafeNonNegativeInt(r.lastRunSequence)) {
      return invalid("lastRunSequence must be a non-negative safe integer or null.");
    }
    return {
      ok: true,
      request: {
        schemaVersion: 1,
        requestId: r.requestId,
        type: "endRun",
        driverOperatingGrant: r.driverOperatingGrant,
        runId: r.runId,
        capturedAtMs: r.capturedAtMs,
        lastRunSequence: r.lastRunSequence,
      },
    };
  }
  return invalid("type must be startRun or endRun.");
}
