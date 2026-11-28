/**
 * Driver delay and issue reports (docs/08 §9.4, docs/05 D20, docs/10 §5).
 *
 * The driver picks one fixed category and, optionally, how many minutes late
 * they expect to be. There is no free text anywhere in this contract: a
 * typed explanation next to "student incident" is where a student's name
 * would end up, and families see the category. The Pi saves the report with
 * its `requestId` before sending and resends the same bytes until the
 * server answers; the driver screen says "Sent" only after `accepted` or
 * `already_recorded`.
 *
 * Families see the newest report on their active run as `reportedDelay` on
 * `tracking:myRun`: the category, the minutes and when it was reported,
 * never as an arrival estimate.
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
export const RUN_REPORT_CATEGORIES = ["traffic", "mechanical", "weather", "student_incident", "other"] as const;
export type RunReportCategory = (typeof RUN_REPORT_CATEGORIES)[number];

/** Words for each category, shared by every client. */
export const RUN_REPORT_CATEGORY_LABELS: Record<RunReportCategory, string> = {
  traffic: "traffic",
  mechanical: "mechanical problem",
  weather: "weather",
  student_incident: "student incident",
  other: "other",
};

/** The expected delay, when given, is a whole number of minutes in this range. */
export const MIN_RUN_REPORT_DELAY_MINUTES = 1;
export const MAX_RUN_REPORT_DELAY_MINUTES = 120;
/** Largest report body. A report is a few hundred bytes. */
export const MAX_RUN_REPORT_BODY_BYTES = 4 * 1024;
/**
 * A report reaching the server this long after it was made on the bus is
 * refused: it waited offline too long to be news.
 */
export const MAX_RUN_REPORT_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Families see a report for this long after it was made on the bus (the
 * report's `validUntilMs`). After that, clients hide it even with no new
 * update, so an old delay is never shown as current.
 */
export const REPORTED_DELAY_SHOWN_FOR_MS = 60 * 60 * 1000;

/** `POST /device/v1/run-reports`. */
export interface RunReportRequest {
  schemaVersion: 1;
  /** UUID saved on the Pi before the first send; reused on every retry. */
  requestId: string;
  driverOperatingGrant: string;
  /** The device's run the report is about. */
  runId: string;
  /** When the driver made the report, on the Pi clock. */
  capturedAtMs: number;
  category: RunReportCategory;
  /** Whole minutes, MIN to MAX_RUN_REPORT_DELAY_MINUTES, or null when not given. */
  expectedDelayMinutes: number | null;
}

/** A stored report, as the Pi sees it back. */
export interface RunReportRecord {
  reportId: string;
  runId: string;
  category: RunReportCategory;
  expectedDelayMinutes: number | null;
  capturedAtMs: number;
  receivedAtMs: number;
}

export const RUN_REPORT_REJECTIONS = [
  /** Grant unknown, revoked, another device's, expired, or not valid when the report was made. */
  "grant_not_authorized",
  /** Not this device's run, not on the grant's routes, or made outside the run. */
  "run_not_authorized",
  /** The report's time is in the future or older than MAX_RUN_REPORT_AGE_MS. */
  "capture_time_out_of_range",
  /** This requestId was already used for a different report. */
  "request_id_conflict",
] as const;
export type RunReportRejection = (typeof RUN_REPORT_REJECTIONS)[number];

/**
 * HTTP 200 for every valid request. `accepted`: this request stored the
 * report. `already_recorded`: a retry of a stored report; this is that
 * report. `rejected` is final for this requestId.
 */
export type RunReportResult =
  | {
      schemaVersion: 1;
      requestId: string;
      status: "accepted" | "already_recorded";
      report: RunReportRecord;
      serverNowMs: number;
    }
  | {
      schemaVersion: 1;
      requestId: string;
      status: "rejected";
      code: RunReportRejection;
      message: string;
      serverNowMs: number;
    };

/** `tracking:myRun` → `run.reportedDelay`: what a family may see. Category only, never text. */
export interface ReportedDelay {
  category: RunReportCategory;
  /** The driver's expected delay in whole minutes, or null when not given. Never an arrival time. */
  minutes: number | null;
  /** When the driver reported it on the bus (never later than the server received it). */
  reportedAtMs: number;
  /** Hide it once the server-aligned clock passes this: reportedAtMs + REPORTED_DELAY_SHOWN_FOR_MS. */
  validUntilMs: number;
  source: "driver";
}

/** A report as staff see it (run attendance and diagnostics pages). */
export interface StaffRunReport {
  reportId: string;
  runId: string;
  category: RunReportCategory;
  expectedDelayMinutes: number | null;
  capturedAtMs: number;
  receivedAtMs: number;
  /** The reporting driver's display name, or null when unknown. */
  driverName: string | null;
}

/** The family-facing sentence, without the age (clients add "reported N min ago"). */
export function reportedDelayText(d: Pick<ReportedDelay, "category" | "minutes">): string {
  const what = `Driver reported a delay (${RUN_REPORT_CATEGORY_LABELS[d.category]})`;
  if (d.minutes === null) return what;
  return `${what}, about ${d.minutes} min`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const GRANT = /^[A-Za-z0-9._~-]{32,512}$/;

export type CheckedRunReport = { ok: true; value: RunReportRequest } | { ok: false; message: string };
const bad = (message: string): CheckedRunReport => ({ ok: false, message });

/**
 * Validates a report body: shape and limits only; authority is checked by
 * the backend, and so is the capture time (a rejection with
 * `capture_time_out_of_range`, final for that requestId). Returns a copy holding only the contract's fields, so an
 * extra key (free text included) never reaches storage.
 */
export function validateRunReport(body: unknown): CheckedRunReport {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Body must be an object.");
  const b = body as Record<string, unknown>;
  if (typeof b.requestId !== "string" || !UUID.test(b.requestId)) return bad("requestId must be a UUID.");
  if (typeof b.driverOperatingGrant !== "string" || !GRANT.test(b.driverOperatingGrant)) return bad("Bad driverOperatingGrant.");
  if (typeof b.runId !== "string" || !ID.test(b.runId)) return bad("runId is required.");
  if (typeof b.capturedAtMs !== "number" || !Number.isSafeInteger(b.capturedAtMs) || b.capturedAtMs <= 0) {
    return bad("capturedAtMs must be epoch milliseconds.");
  }
  if (!(RUN_REPORT_CATEGORIES as readonly unknown[]).includes(b.category)) {
    return bad(`category must be one of ${RUN_REPORT_CATEGORIES.join(", ")}.`);
  }
  const m = b.expectedDelayMinutes;
  if (
    m !== null &&
    (typeof m !== "number" || !Number.isInteger(m) || m < MIN_RUN_REPORT_DELAY_MINUTES || m > MAX_RUN_REPORT_DELAY_MINUTES)
  ) {
    return bad(`expectedDelayMinutes must be null or a whole number from ${MIN_RUN_REPORT_DELAY_MINUTES} to ${MAX_RUN_REPORT_DELAY_MINUTES}.`);
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      requestId: b.requestId,
      driverOperatingGrant: b.driverOperatingGrant,
      runId: b.runId,
      capturedAtMs: b.capturedAtMs,
      category: b.category as RunReportCategory,
      expectedDelayMinutes: m as number | null,
    },
  };
}
