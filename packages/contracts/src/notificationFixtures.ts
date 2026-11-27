import type {
  MyAlertsResult,
  MyPreferenceResult,
  RegisterDeviceResult,
  SetPreferencesResult,
} from "./notifications.js";

/**
 * Canonical fictional notification fixtures (docs/08 §9–10). Fake IDs and
 * places. `bun run fixtures` writes them to `fixtures/*.json` for the Swift
 * tests; a test fails if the JSON drifts from these values.
 */

const SERVER_NOW_MS = 1795609085500;

export const myPreferenceReady: MyPreferenceResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  preference: {
    assignmentId: "demo_assignment_001",
    approachingEnabled: true,
    approachingMinutes: 5,
    updatedAtMs: 1795600000000,
  },
};

export const myPreferenceDefault: MyPreferenceResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  preference: { assignmentId: "demo_assignment_001", approachingEnabled: false, approachingMinutes: 5, updatedAtMs: null },
};

export const setPreferencesSaved: SetPreferencesResult = {
  schemaVersion: 1,
  status: "saved",
  serverNowMs: SERVER_NOW_MS,
  preference: {
    assignmentId: "demo_assignment_001",
    approachingEnabled: true,
    approachingMinutes: 7,
    updatedAtMs: SERVER_NOW_MS,
  },
};

export const registerDeviceRegistered: RegisterDeviceResult = {
  schemaVersion: 1,
  status: "registered",
  serverNowMs: SERVER_NOW_MS,
  pushEnabled: true,
};

export const myAlertsReady: MyAlertsResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  alerts: [
    {
      alertId: "demo_alert_001",
      type: "approaching",
      assignmentId: "demo_assignment_001",
      runId: "demo_run_001",
      stopLabel: "Oak & Pine",
      createdAtMs: 1795609085450,
      predictedArrivalAtMs: 1795609325000,
      predictionGeneratedAtMs: 1795609085450,
    },
  ],
};

export const myAlertsEmpty: MyAlertsResult = {
  schemaVersion: 1,
  status: "ready",
  serverNowMs: SERVER_NOW_MS,
  alerts: [],
};

/** File name (without `.json`) → fixture. The Swift tests load these names. */
export const notificationFixtureFiles = {
  "myPreference.ready": myPreferenceReady,
  "myPreference.default": myPreferenceDefault,
  "setPreferences.saved": setPreferencesSaved,
  "registerDevice.registered": registerDeviceRegistered,
  "myAlerts.ready": myAlertsReady,
  "myAlerts.empty": myAlertsEmpty,
} as const;
