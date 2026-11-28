import { describe, expect, it } from "vitest";
import accepted from "../fixtures/health.accepted.json" with { type: "json" };
import acceptedRunCancelled from "../fixtures/health.accepted.runCancelled.json" with { type: "json" };
import noFix from "../fixtures/health.report.noFix.json" with { type: "json" };
import withMetrics from "../fixtures/health.report.withMetrics.json" with { type: "json" };
import telemetryRunCancelled from "../fixtures/telemetry.response.runCancelled.json" with { type: "json" };
import { validateDeviceHealthReport } from "./health.js";
import { healthFixtureFiles } from "./healthFixtures.js";

const NOW = noFix.capturedAtMs + 400;

describe("health fixtures", () => {
  it("fixtures/*.json match the typed fixtures (run `bun run fixtures` if not)", () => {
    expect(noFix).toEqual(healthFixtureFiles["health.report.noFix"]);
    expect(accepted).toEqual(healthFixtureFiles["health.accepted"]);
    expect(acceptedRunCancelled).toEqual(healthFixtureFiles["health.accepted.runCancelled"]);
    expect(telemetryRunCancelled).toEqual(healthFixtureFiles["telemetry.response.runCancelled"]);
    expect(withMetrics).toEqual(healthFixtureFiles["health.report.withMetrics"]);
  });

  it("accepts the measurement fields, and nulls for what the Pi cannot measure", () => {
    expect(validateDeviceHealthReport(withMetrics, NOW)).toEqual({ ok: true, report: withMetrics });
    const unmeasured = {
      ...withMetrics,
      lastUploadErrorClass: null,
      processRssBytes: null,
      memAvailableBytes: null,
      cpuTemperatureC: null,
      databaseBytes: null,
    };
    expect(validateDeviceHealthReport(unmeasured, NOW).ok).toBe(true);
  });

  it("the canonical report validates", () => {
    expect(validateDeviceHealthReport(noFix, NOW)).toEqual({ ok: true, report: noFix });
    expect(validateDeviceHealthReport({ ...noFix, runId: null, lastValidFixAtMs: null }, NOW).ok).toBe(true);
  });
});

describe("validateDeviceHealthReport", () => {
  it.each([
    ["not an object", []],
    ["bootId not a UUID", { ...noFix, bootId: "x" }],
    ["future capture", { ...noFix, capturedAtMs: NOW + 3 * 60_000 }],
    ["unknown gps status", { ...noFix, gpsStatus: "great" }],
    ["coordinates smuggled in", { ...noFix, latitude: 34.1 }],
    ["fractional queue", { ...noFix, pendingCount: 1.5 }],
    ["long version", { ...noFix, appVersion: "x".repeat(33) }],
    ["unconfirmed end not an ID", { ...noFix, unconfirmedEndRunId: 7 }],
    ["unconfirmed end too long", { ...noFix, unconfirmedEndRunId: "x".repeat(65) }],
    ["negative retries", { ...withMetrics, uploadRetriesSinceStart: -1 }],
    ["null retry count", { ...withMetrics, uploadConsecutiveFailures: null }],
    ["fractional bytes", { ...withMetrics, processRssBytes: 1.5 }],
    ["impossible temperature", { ...withMetrics, cpuTemperatureC: 999 }],
    ["temperature as text", { ...withMetrics, cpuTemperatureC: "48" }],
    ["an error message instead of a class", { ...withMetrics, lastUploadErrorClass: "connect to 10.0.0.2 failed" }],
    ["long error class", { ...withMetrics, lastUploadErrorClass: "E".repeat(41) }],
  ])("refuses %s", (_name, body) => {
    expect(validateDeviceHealthReport(body, NOW).ok).toBe(false);
  });

  it("refuses another schema version distinctly", () => {
    expect(validateDeviceHealthReport({ ...noFix, schemaVersion: 2 }, NOW)).toMatchObject({
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
  });
});
