/**
 * Shared ITSSB wire contracts (schema version 1).
 *
 * The authority is docs/08_DATA_CONTRACTS_AND_API.md. If you change a field
 * here, update that document, the backend validators, the device models, and
 * the Swift DTOs in the same change (see AGENTS.md).
 */

export const SCHEMA_VERSION = 1 as const;

/** Proposed per-request bounds (docs/08 §3). Tunable, not platform limits. */
export const MAX_EVENTS_PER_TELEMETRY_REQUEST = 50;
export const MAX_TELEMETRY_BODY_BYTES = 128 * 1024;

export const RUN_STATES = ["scheduled", "active", "completed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const GPS_STATUSES = ["valid", "no_fix", "receiver_missing"] as const;
export type GpsStatus = (typeof GPS_STATUSES)[number];

/** One selected GPS observation sent from the Pi (docs/08 §4). */
export interface TelemetryEvent {
  /** UUID created once on the device and persisted before upload. */
  eventId: string;
  /** Fresh UUID per collector process start. */
  bootId: string;
  /** Ordered within `bootId`; resets only with a new `bootId`. */
  sequence: number;
  /** Ordered within the run; survives restarts. */
  runSequence: number;
  /** Opaque server-issued run identifier. */
  runId: string;
  /** Device capture time, UTC epoch milliseconds. */
  capturedAtMs: number;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  headingDegrees: number | null;
  horizontalAccuracyM: number | null;
  fixMode: 2 | 3;
}

export interface TelemetryRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  events: TelemetryEvent[];
}

export const EVENT_RESULT_STATUSES = ["accepted", "duplicate", "rejected", "retryable"] as const;
export type EventResultStatus = (typeof EVENT_RESULT_STATUSES)[number];

export type EventErrorCode =
  | "INVALID_COORDINATES"
  | "INVALID_FIELD"
  | "CLOCK_OUT_OF_RANGE"
  | "RUN_NOT_AUTHORIZED"
  | "EVENT_CONTENT_CONFLICT"
  | "TEMPORARILY_UNAVAILABLE";

export type EventResult =
  | {
      eventId: string;
      status: "accepted" | "duplicate";
      receivedAtMs: number;
      liveStateApplied: boolean;
    }
  | {
      eventId: string;
      status: "rejected" | "retryable";
      code: EventErrorCode;
      message: string;
      retryAfterMs?: number;
    };

export interface TelemetryResponse {
  schemaVersion: typeof SCHEMA_VERSION;
  serverNowMs: number;
  results: EventResult[];
}

export interface RequestError {
  schemaVersion: typeof SCHEMA_VERSION;
  error: { code: string; message: string; retryable: boolean };
}

export * from "./validate.js";
export * from "./tracking.js";
export * from "./staff.js";
export * from "./tripEvents.js";
