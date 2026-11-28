/**
 * Driver route-draft submission (docs/08 §7.1, docs/05 D10-D11).
 *
 * The Pi uploads one finished recording in one bounded request, with the
 * driver operating grant in the body. The server stores it as `submitted`
 * for staff review; nothing here approves or publishes a route. The Pi then
 * reads the review status back for the drafts it submitted.
 *
 * Pi ↔ backend only. No iOS client decodes these, so there is no Swift DTO.
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import { type DraftStatus, ROUTE_DIRECTIONS, type RouteDirection } from "./staff.js";
import { MAX_ROUTE_PATH_POINTS } from "./tracking.js";
import { MAX_FUTURE_SKEW_MS } from "./validate.js";

/** At most this many stops in one draft. */
export const MAX_ROUTE_DRAFT_STOPS = 100;
/** Longest route or stop name, in characters (the Pi's own limit). */
export const MAX_ROUTE_DRAFT_LABEL_LENGTH = 60;
/**
 * Largest submission body. A full draft (2000 points, 100 stops with
 * escaped non-ASCII names) is about 280 KB, so one bounded request carries
 * any draft the Pi can record; no chunked upload is needed (docs/17).
 */
export const MAX_ROUTE_DRAFT_BODY_BYTES = 384 * 1024;
/** Largest status-read body, and the most drafts one read may ask about. */
export const MAX_ROUTE_DRAFT_STATUS_BODY_BYTES = 8 * 1024;
export const MAX_ROUTE_DRAFT_STATUS_IDS = 20;
/**
 * Tolerance between the Pi's wall clock (start/finish times) and GPS capture
 * times on points and stops, which come from the receiver.
 */
export const ROUTE_DRAFT_CLOCK_TOLERANCE_MS = MAX_FUTURE_SKEW_MS;

/** One recorded point, in travel order. */
export interface RouteDraftPoint {
  latitude: number;
  longitude: number;
  /** GPS capture time; strictly increasing along the path. */
  capturedAtMs: number;
  /** True when the receiver lost the fix before this point: not measured travel. */
  gapBefore: boolean;
}

/** One stop, in travel order. Its position came from the Pi's own fix. */
export interface RouteDraftStop {
  label: string;
  latitude: number;
  longitude: number;
  capturedAtMs: number;
}

/** `POST /device/v1/route-drafts`. */
export interface RouteDraftSubmission {
  schemaVersion: 1;
  /** UUID saved on the Pi before the first send; reused on every retry. */
  requestId: string;
  driverOperatingGrant: string;
  /** The Pi's own draft id (UUID). One server draft per device draft. */
  deviceDraftId: string;
  /** When the driver pressed Submit, on the Pi clock. */
  capturedAtMs: number;
  label: string;
  direction: RouteDirection;
  startedAtMs: number;
  finishedAtMs: number;
  /** 2 to MAX_ROUTE_PATH_POINTS points. */
  path: RouteDraftPoint[];
  /** 1 to MAX_ROUTE_DRAFT_STOPS stops. */
  stops: RouteDraftStop[];
}

/** A submitted draft's review state, as the Pi shows it. */
export interface RouteDraftReview {
  draftId: string;
  deviceDraftId: string;
  /** `submitted` means awaiting staff review; never approved automatically. */
  status: DraftStatus;
  submittedAtMs: number;
  reviewedAtMs: number | null;
  /** Staff's reason when rejected; otherwise null. */
  decisionReason: string | null;
  /** The route version created by approval; otherwise null. */
  routeVersionId: string | null;
}

export const ROUTE_DRAFT_REJECTIONS = [
  /** Grant unknown, revoked, another device's, or expired. */
  "grant_not_authorized",
  /** This requestId was used for another draft or other content. */
  "request_id_conflict",
  /** This device draft was already submitted with different content. */
  "draft_conflict",
] as const;
export type RouteDraftRejection = (typeof ROUTE_DRAFT_REJECTIONS)[number];

/**
 * HTTP 200 for every valid submission. `accepted`: this request stored the
 * draft. `already_submitted`: the same content was stored before (a retry);
 * this is that draft. `rejected` is final for this requestId.
 */
export type RouteDraftSubmitResult =
  | {
      schemaVersion: 1;
      requestId: string;
      status: "accepted" | "already_submitted";
      draft: RouteDraftReview;
      serverNowMs: number;
    }
  | {
      schemaVersion: 1;
      requestId: string;
      status: "rejected";
      code: RouteDraftRejection;
      message: string;
      serverNowMs: number;
    };

/** `POST /device/v1/route-drafts/status`: review state of drafts this device submitted. */
export interface RouteDraftStatusRequest {
  schemaVersion: 1;
  driverOperatingGrant: string;
  /** Server draft ids, 1 to MAX_ROUTE_DRAFT_STATUS_IDS. */
  draftIds: string[];
}

export interface RouteDraftStatusResponse {
  schemaVersion: 1;
  /** One entry per distinct asked id, in order. Another device's draft reads as not_found. */
  drafts: (RouteDraftReview | { draftId: string; status: "not_found" })[];
  serverNowMs: number;
}

/** Request-level errors (docs/08 §5) for these endpoints. */
export const ROUTE_DRAFT_ERROR_CODES = [
  "INVALID_REQUEST",
  "MALFORMED_JSON",
  "UNSUPPORTED_SCHEMA_VERSION",
  "UNAUTHENTICATED",
  "GRANT_NOT_AUTHORIZED",
  "BODY_TOO_LARGE",
  "TOO_MANY_POINTS",
  "TOO_MANY_STOPS",
] as const;
export type RouteDraftErrorCode = (typeof ROUTE_DRAFT_ERROR_CODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const GRANT = /^[A-Za-z0-9._~-]{32,512}$/;

type Invalid = { ok: false; code: "INVALID_REQUEST" | "TOO_MANY_POINTS" | "TOO_MANY_STOPS"; message: string };
export type CheckedSubmission = { ok: true; value: RouteDraftSubmission } | Invalid;

const bad = (message: string): Invalid => ({ ok: false, code: "INVALID_REQUEST", message });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const isLat = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 90;
const isLon = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 180;

function label(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  return t.length > 0 && t.length <= MAX_ROUTE_DRAFT_LABEL_LENGTH ? t : null;
}

/**
 * Validates a submission body. Shape, limits, coordinates and times only:
 * authority is checked by the backend. Returns a copy holding only the
 * contract's fields, so unknown extras never reach storage. `nowMs` is the
 * receiver's clock: a recording cannot finish in the future.
 */
export function validateRouteDraftSubmission(body: unknown, nowMs: number): CheckedSubmission {
  if (!isObj(body)) return bad("Body must be an object.");
  const b = body;
  if (typeof b.requestId !== "string" || !UUID.test(b.requestId)) return bad("requestId must be a UUID.");
  if (typeof b.deviceDraftId !== "string" || !UUID.test(b.deviceDraftId)) return bad("deviceDraftId must be a UUID.");
  if (typeof b.driverOperatingGrant !== "string" || !GRANT.test(b.driverOperatingGrant)) {
    return bad("Bad driverOperatingGrant.");
  }
  const name = label(b.label);
  if (name === null) return bad(`label must be 1-${MAX_ROUTE_DRAFT_LABEL_LENGTH} characters.`);
  if (!(ROUTE_DIRECTIONS as readonly unknown[]).includes(b.direction)) return bad("direction must be to_school or from_school.");
  if (!isTime(b.capturedAtMs) || !isTime(b.startedAtMs) || !isTime(b.finishedAtMs)) {
    return bad("capturedAtMs, startedAtMs and finishedAtMs must be epoch milliseconds.");
  }
  const tol = ROUTE_DRAFT_CLOCK_TOLERANCE_MS;
  const { startedAtMs, finishedAtMs, capturedAtMs } = b;
  if (finishedAtMs < startedAtMs) return bad("finishedAtMs is before startedAtMs.");
  if (finishedAtMs > nowMs + tol || capturedAtMs > nowMs + tol) return bad("A time is in the future.");
  if (capturedAtMs + tol < finishedAtMs) return bad("Submitted before the recording finished.");
  const within = (t: number) => t >= startedAtMs - tol && t <= finishedAtMs + tol;

  if (!Array.isArray(b.path)) return bad("path must be an array.");
  if (b.path.length > MAX_ROUTE_PATH_POINTS) {
    return { ok: false, code: "TOO_MANY_POINTS", message: `At most ${MAX_ROUTE_PATH_POINTS} points.` };
  }
  if (b.path.length < 2) return bad("path needs at least two points.");
  if (!Array.isArray(b.stops)) return bad("stops must be an array.");
  if (b.stops.length > MAX_ROUTE_DRAFT_STOPS) {
    return { ok: false, code: "TOO_MANY_STOPS", message: `At most ${MAX_ROUTE_DRAFT_STOPS} stops.` };
  }
  if (b.stops.length < 1) return bad("A draft needs at least one stop.");

  const path: RouteDraftPoint[] = [];
  let last = -Infinity;
  for (const p of b.path as unknown[]) {
    if (!isObj(p) || !isLat(p.latitude) || !isLon(p.longitude)) return bad("A point has an impossible coordinate.");
    if (!isTime(p.capturedAtMs) || !within(p.capturedAtMs)) return bad("A point's time is outside the recording.");
    // Points are in travel order; stops are not time-ordered (they can be reordered).
    if (p.capturedAtMs <= last) return bad("Point times must increase along the path.");
    if (typeof p.gapBefore !== "boolean") return bad("gapBefore must be true or false.");
    last = p.capturedAtMs;
    path.push({ latitude: p.latitude, longitude: p.longitude, capturedAtMs: p.capturedAtMs, gapBefore: p.gapBefore });
  }
  const stops: RouteDraftStop[] = [];
  for (const s of b.stops as unknown[]) {
    if (!isObj(s) || !isLat(s.latitude) || !isLon(s.longitude)) return bad("A stop has an impossible coordinate.");
    const stopLabel = label(s.label);
    if (stopLabel === null) return bad(`Stop names must be 1-${MAX_ROUTE_DRAFT_LABEL_LENGTH} characters.`);
    if (!isTime(s.capturedAtMs) || !within(s.capturedAtMs)) return bad("A stop's time is outside the recording.");
    stops.push({ label: stopLabel, latitude: s.latitude, longitude: s.longitude, capturedAtMs: s.capturedAtMs });
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      requestId: b.requestId.toLowerCase(),
      driverOperatingGrant: b.driverOperatingGrant,
      deviceDraftId: b.deviceDraftId.toLowerCase(),
      capturedAtMs,
      label: name,
      direction: b.direction as RouteDirection,
      startedAtMs,
      finishedAtMs,
      path,
      stops,
    },
  };
}

/**
 * The recording's content, canonically ordered: what a retry must repeat.
 * Excludes the grant, requestId and submit time, which change between
 * attempts without changing the draft.
 */
export function routeDraftContent(s: RouteDraftSubmission): string {
  return JSON.stringify([
    s.deviceDraftId,
    s.label,
    s.direction,
    s.startedAtMs,
    s.finishedAtMs,
    s.path.map((p) => [p.latitude, p.longitude, p.capturedAtMs, p.gapBefore]),
    s.stops.map((p) => [p.label, p.latitude, p.longitude, p.capturedAtMs]),
  ]);
}

export type CheckedStatusRequest =
  | { ok: true; value: { driverOperatingGrant: string; draftIds: string[] } }
  | { ok: false; message: string };

export function validateRouteDraftStatusRequest(body: unknown): CheckedStatusRequest {
  if (!isObj(body)) return { ok: false, message: "Body must be an object." };
  if (typeof body.driverOperatingGrant !== "string" || !GRANT.test(body.driverOperatingGrant)) {
    return { ok: false, message: "Bad driverOperatingGrant." };
  }
  const ids = body.draftIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ROUTE_DRAFT_STATUS_IDS) {
    return { ok: false, message: `draftIds must hold 1-${MAX_ROUTE_DRAFT_STATUS_IDS} ids.` };
  }
  if (!ids.every((id): id is string => typeof id === "string" && ID.test(id))) return { ok: false, message: "Bad draft id." };
  return { ok: true, value: { driverOperatingGrant: body.driverOperatingGrant, draftIds: [...new Set(ids)] } };
}
