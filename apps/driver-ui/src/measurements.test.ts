import { describe, expect, it } from "vitest";
import { observed, snapshot } from "./testing.js";
import { measurementRows, NOT_AVAILABLE, NOT_REPORTED } from "./views.js";

const upload = { consecutiveFailures: 2, retriesSinceStart: 9, lastErrorClass: "http_503", lastErrorAtMs: 1_795_608_000_000 - 90_000 };
const system = { processRssBytes: 41_236_000, memAvailableBytes: 1_203_572_000, cpuTemperatureC: 48.3, databaseBytes: 3_158_016 };

describe("D21 measurements", () => {
  it("an older device service reads as not reported, never as zero or healthy", () => {
    const rows = Object.fromEntries(measurementRows(observed(snapshot())));
    expect(rows).toEqual({ "Upload retries": NOT_REPORTED, "Memory, temperature, database": NOT_REPORTED });
  });

  it("a value this Pi cannot measure says not available on this device", () => {
    const s = snapshot({
      upload,
      system: { processRssBytes: null, memAvailableBytes: null, cpuTemperatureC: null, databaseBytes: null },
    });
    const rows = Object.fromEntries(measurementRows(observed(s)));
    for (const k of ["Service memory", "Memory available", "CPU temperature", "Database size"]) {
      expect(rows[k]).toBe(NOT_AVAILABLE);
    }
  });

  it("shows measured values, and the last error with its age", () => {
    const rows = Object.fromEntries(measurementRows(observed(snapshot({ upload, system }), 10_000)));
    expect(rows).toMatchObject({
      "Upload failures in a row": "2",
      "Upload retries since start": "9",
      "Last upload error": "http_503, 100 s ago",
      "Service memory": "41.2 MB",
      "CPU temperature": "48.3 °C",
      "Database size": "3.2 MB",
    });
  });

  it("a recovered uplink keeps its history but says nothing is failing now", () => {
    const s = snapshot({ upload: { ...upload, consecutiveFailures: 0 }, system });
    expect(Object.fromEntries(measurementRows(observed(s)))["Upload failures in a row"]).toBe("0");
    const fresh = snapshot({ upload: { consecutiveFailures: 0, retriesSinceStart: 0, lastErrorClass: null, lastErrorAtMs: null }, system });
    expect(Object.fromEntries(measurementRows(observed(fresh)))["Last upload error"]).toBe("none since start");
  });
});
