import type { TelemetryEvent } from "./index.js";

/**
 * Canonical fictional fixture (docs/08 §4). Fake IDs and coordinates; never
 * paste these into a real deployment.
 */
export const demoTelemetryEvent: TelemetryEvent = {
  eventId: "5fe2a60d-7c11-45b9-995d-f50192adea42",
  bootId: "3cd44c56-c96b-4b83-a970-5414990bc25a",
  sequence: 42,
  runSequence: 918,
  runId: "demo_run_001",
  capturedAtMs: 1795609085000,
  latitude: 34.1,
  longitude: -83.98,
  speedMps: 7.2,
  headingDegrees: 95.0,
  horizontalAccuracyM: null,
  fixMode: 3,
};

export * from "./trackingFixtures.js";
export * from "./tripEventFixtures.js";
export * from "./demoRoute.js";
export * from "./healthFixtures.js";
export * from "./enrollmentFixtures.js";
export * from "./checkInFixtures.js";
