import { describe, expect, it } from "vitest";
import { demoTelemetryEvent } from "./fixtures.js";
import { MAX_FUTURE_SKEW_MS, validateTelemetryEvent } from "./validate.js";

const now = demoTelemetryEvent.capturedAtMs + 400;

describe("validateTelemetryEvent", () => {
  it("accepts the canonical fixture", () => {
    expect(validateTelemetryEvent(demoTelemetryEvent, now)).toEqual({
      ok: true,
      event: demoTelemetryEvent,
    });
  });

  it("rejects NaN coordinates", () => {
    const r = validateTelemetryEvent({ ...demoTelemetryEvent, latitude: Number.NaN }, now);
    expect(r).toMatchObject({ ok: false, code: "INVALID_COORDINATES" });
  });

  it("rejects out-of-range longitude", () => {
    const r = validateTelemetryEvent({ ...demoTelemetryEvent, longitude: 181 }, now);
    expect(r).toMatchObject({ ok: false, code: "INVALID_COORDINATES" });
  });

  it("rejects capture times far in the future", () => {
    const r = validateTelemetryEvent(
      { ...demoTelemetryEvent, capturedAtMs: now + MAX_FUTURE_SKEW_MS + 1 },
      now,
    );
    expect(r).toMatchObject({ ok: false, code: "CLOCK_OUT_OF_RANGE" });
  });

  it("rejects negative or fractional sequences", () => {
    expect(validateTelemetryEvent({ ...demoTelemetryEvent, sequence: -1 }, now).ok).toBe(false);
    expect(validateTelemetryEvent({ ...demoTelemetryEvent, runSequence: 1.5 }, now).ok).toBe(false);
  });

  it("rejects a no-fix mode", () => {
    const r = validateTelemetryEvent({ ...demoTelemetryEvent, fixMode: 1 }, now);
    expect(r).toMatchObject({ ok: false, code: "INVALID_FIELD" });
  });

  it("requires nullable fields to be present as null, not omitted", () => {
    const { speedMps: _omit, ...withoutSpeed } = demoTelemetryEvent;
    expect(validateTelemetryEvent(withoutSpeed, now).ok).toBe(false);
  });

  it("rejects a non-UUID eventId", () => {
    const r = validateTelemetryEvent({ ...demoTelemetryEvent, eventId: "evt-1" }, now);
    expect(r).toMatchObject({ ok: false, code: "INVALID_FIELD" });
  });
});
