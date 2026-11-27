import { describe, expect, it } from "vitest";
import accepted from "../fixtures/health.accepted.json" with { type: "json" };
import noFix from "../fixtures/health.report.noFix.json" with { type: "json" };
import { validateDeviceHealthReport } from "./health.js";
import { healthFixtureFiles } from "./healthFixtures.js";

const NOW = noFix.capturedAtMs + 400;

describe("health fixtures", () => {
  it("fixtures/*.json match the typed fixtures (run `bun run fixtures` if not)", () => {
    expect(noFix).toEqual(healthFixtureFiles["health.report.noFix"]);
    expect(accepted).toEqual(healthFixtureFiles["health.accepted"]);
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
  ])("refuses %s", (_name, body) => {
    expect(validateDeviceHealthReport(body, NOW).ok).toBe(false);
  });

  it("refuses another schema version distinctly", () => {
    expect(validateDeviceHealthReport({ ...noFix, schemaVersion: 2 }, NOW)).toMatchObject({
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
  });
});
