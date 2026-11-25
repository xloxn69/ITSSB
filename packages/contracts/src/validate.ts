import type { EventErrorCode, TelemetryEvent } from "./index.js";

/** How far in the future a capture time may be before it is rejected. */
export const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

export type ValidationResult =
  | { ok: true; event: TelemetryEvent }
  | { ok: false; code: EventErrorCode; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isSafeNonNegativeInt = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const isNullableFinite = (v: unknown): v is number | null => v === null || isFiniteNumber(v);

function fail(code: EventErrorCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

/**
 * Validates one telemetry event against the v1 contract.
 *
 * Pure function so the backend, tests, and any TypeScript client share one
 * definition. `nowMs` is the receiver's clock, used to reject capture times
 * far in the future (which must never advance the live-state watermark).
 */
export function validateTelemetryEvent(input: unknown, nowMs: number): ValidationResult {
  if (typeof input !== "object" || input === null) {
    return fail("INVALID_FIELD", "Event must be an object.");
  }
  const e = input as Record<string, unknown>;

  for (const key of ["eventId", "bootId"] as const) {
    if (typeof e[key] !== "string" || !UUID.test(e[key] as string)) {
      return fail("INVALID_FIELD", `${key} must be a UUID.`);
    }
  }
  if (typeof e.runId !== "string" || e.runId.length === 0) {
    return fail("INVALID_FIELD", "runId is required.");
  }
  if (!isSafeNonNegativeInt(e.sequence) || !isSafeNonNegativeInt(e.runSequence)) {
    return fail("INVALID_FIELD", "sequence and runSequence must be non-negative safe integers.");
  }
  if (!isSafeNonNegativeInt(e.capturedAtMs)) {
    return fail("INVALID_FIELD", "capturedAtMs must be epoch milliseconds.");
  }
  if (e.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return fail("CLOCK_OUT_OF_RANGE", "capturedAtMs is too far in the future.");
  }
  if (
    !isFiniteNumber(e.latitude) ||
    !isFiniteNumber(e.longitude) ||
    e.latitude < -90 ||
    e.latitude > 90 ||
    e.longitude < -180 ||
    e.longitude > 180
  ) {
    return fail("INVALID_COORDINATES", "latitude/longitude out of range.");
  }
  if (e.fixMode !== 2 && e.fixMode !== 3) {
    return fail("INVALID_FIELD", "fixMode must be 2 or 3.");
  }
  if (!isNullableFinite(e.speedMps) || (e.speedMps !== null && e.speedMps < 0)) {
    return fail("INVALID_FIELD", "speedMps must be a non-negative number or null.");
  }
  if (
    !isNullableFinite(e.headingDegrees) ||
    (e.headingDegrees !== null && (e.headingDegrees < 0 || e.headingDegrees >= 360))
  ) {
    return fail("INVALID_FIELD", "headingDegrees must be in [0, 360) or null.");
  }
  if (
    !isNullableFinite(e.horizontalAccuracyM) ||
    (e.horizontalAccuracyM !== null && e.horizontalAccuracyM < 0)
  ) {
    return fail("INVALID_FIELD", "horizontalAccuracyM must be a non-negative number or null.");
  }

  return {
    ok: true,
    event: {
      eventId: e.eventId as string,
      bootId: e.bootId as string,
      sequence: e.sequence,
      runSequence: e.runSequence,
      runId: e.runId,
      capturedAtMs: e.capturedAtMs,
      latitude: e.latitude,
      longitude: e.longitude,
      speedMps: e.speedMps,
      headingDegrees: e.headingDegrees,
      horizontalAccuracyM: e.horizontalAccuracyM,
      fixMode: e.fixMode,
    },
  };
}
