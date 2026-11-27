/**
 * Family notification contract (docs/08 §9, docs/10 §8–10). Signed-in
 * students and guardians call these Convex functions; the server derives the
 * account from the authenticated identity and rechecks the assignment
 * relationship. The Pi never sends or reads any of this.
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import type { AccessUnavailable, SCHEMA_VERSION } from "./index.js";

/** Alert types the server can create. One logical alert per recipient, run, stop, and type. */
export const ALERT_TYPES = ["approaching"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Allowed "notify me when the bus is about N minutes away" values. */
export const APPROACHING_MINUTES_MIN = 1;
export const APPROACHING_MINUTES_MAX = 30;
export const APPROACHING_MINUTES_DEFAULT = 5;

/**
 * An approaching alert is only created from a position younger than this
 * (provisional, docs/17 "Freshness and alert thresholds"). Equal to the age
 * at which the app says it is waiting for an update, so an outbox drain
 * after an outage never alerts from old positions.
 */
export const ALERT_MAX_INPUT_AGE_MS = 30_000;

/** Delivery attempts per job, including the first; then it fails permanently. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export const PUSH_ENVIRONMENTS = ["sandbox", "production"] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

/** The operating system's notification permission, reported by the app. Separate from preferences. */
export const PUSH_PERMISSIONS = ["authorized", "provisional", "denied", "not_determined"] as const;
export type PushPermission = (typeof PUSH_PERMISSIONS)[number];

export interface NotificationPreference {
  assignmentId: string;
  approachingEnabled: boolean;
  approachingMinutes: number;
  /** When the person last saved it, or null when these are the defaults. */
  updatedAtMs: number | null;
}

// MARK: notifications:myPreference  { assignmentId }

export type MyPreferenceResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "ready";
      serverNowMs: number;
      preference: NotificationPreference;
    }
  | AccessUnavailable;

// MARK: notifications:setPreferences

export interface SetPreferencesArgs {
  /** UUID created once per save attempt; a retry reuses it. */
  requestId: string;
  assignmentId: string;
  approachingEnabled: boolean;
  approachingMinutes: number;
}

export type SetPreferencesResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "saved";
      serverNowMs: number;
      preference: NotificationPreference;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "invalid";
      serverNowMs: number;
      message: string;
    }
  | AccessUnavailable;

// MARK: notifications:registerDevice

export interface RegisterDeviceArgs {
  /** UUID the app creates once per installation and keeps. */
  installationId: string;
  /** APNs device token as lowercase hex, or null when the app has none (permission denied). */
  apnsToken: string | null;
  environment: PushEnvironment;
  permission: PushPermission;
}

export type RegisterDeviceResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "registered";
      serverNowMs: number;
      /** True when the server can push to this installation now. */
      pushEnabled: boolean;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "invalid";
      serverNowMs: number;
      message: string;
    }
  | AccessUnavailable;

// MARK: notifications:myAlerts  {}

/** One entry in the in-app alerts inbox. Useful even when push is unavailable. */
export interface AlertSummary {
  alertId: string;
  type: AlertType;
  assignmentId: string;
  runId: string;
  stopLabel: string;
  /** When the server created the alert. */
  createdAtMs: number;
  /** The estimate that triggered it, and when that estimate was computed. */
  predictedArrivalAtMs: number;
  predictionGeneratedAtMs: number;
}

export type MyAlertsResult =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      status: "ready";
      serverNowMs: number;
      /** Newest first, at most 50, only for assignments the caller may still track. */
      alerts: AlertSummary[];
    }
  | AccessUnavailable;
