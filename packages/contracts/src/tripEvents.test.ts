import { describe, expect, it } from "vitest";
import activeRunConflict from "../fixtures/tripEvent.activeRunConflict.json" with { type: "json" };
import endAccepted from "../fixtures/tripEvent.endRun.accepted.json" with { type: "json" };
import endRequest from "../fixtures/tripEvent.endRun.request.json" with { type: "json" };
import startAccepted from "../fixtures/tripEvent.startRun.accepted.json" with { type: "json" };
import startRequest from "../fixtures/tripEvent.startRun.request.json" with { type: "json" };
import { tripEventFixtureFiles } from "./tripEventFixtures.js";
import { localDate, validateTripEventRequest } from "./tripEvents.js";

const json: Record<keyof typeof tripEventFixtureFiles, unknown> = {
  "tripEvent.startRun.request": startRequest,
  "tripEvent.startRun.accepted": startAccepted,
  "tripEvent.endRun.request": endRequest,
  "tripEvent.endRun.accepted": endAccepted,
  "tripEvent.activeRunConflict": activeRunConflict,
};

describe("trip-event fixtures", () => {
  it.each(Object.keys(tripEventFixtureFiles) as (keyof typeof tripEventFixtureFiles)[])(
    "fixtures/%s.json matches the typed fixture (run `bun run fixtures` if not)",
    (name) => {
      expect(json[name]).toEqual(tripEventFixtureFiles[name]);
    },
  );

  it("the canonical requests validate", () => {
    expect(validateTripEventRequest(startRequest)).toEqual({ ok: true, request: startRequest });
    expect(validateTripEventRequest(endRequest)).toEqual({ ok: true, request: endRequest });
    expect(validateTripEventRequest({ ...endRequest, lastRunSequence: null }).ok).toBe(true);
  });
});

describe("validateTripEventRequest", () => {
  it.each([
    ["unknown type", { ...startRequest, type: "patchRow" }],
    ["requestId not a UUID", { ...startRequest, requestId: "1" }],
    ["missing grant", { ...startRequest, driverOperatingGrant: undefined }],
    ["short grant (a PIN is not a grant)", { ...startRequest, driverOperatingGrant: "1234" }],
    ["impossible date", { ...startRequest, serviceDate: "2026-02-30" }],
    ["ISO time as date", { ...startRequest, serviceDate: "2026-11-25T08:00:00Z" }],
    ["unknown time zone", { ...startRequest, serviceTimezone: "Mars/Olympus" }],
    ["fractional time", { ...startRequest, capturedAtMs: 1795608000.5 }],
    ["negative lastRunSequence", { ...endRequest, lastRunSequence: -1 }],
    ["missing lastRunSequence", { ...endRequest, lastRunSequence: undefined }],
    ["missing runId", { ...endRequest, runId: "" }],
  ])("rejects %s", (_label, body) => {
    expect(validateTripEventRequest(body)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("rejects another schema version distinctly", () => {
    expect(validateTripEventRequest({ ...startRequest, schemaVersion: 2 })).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
  });

  it("drops fields outside the contract, such as a caller-asserted deviceId or driverId", () => {
    const checked = validateTripEventRequest({ ...startRequest, deviceId: "x", driverId: "y" });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(Object.keys(checked.request)).not.toContain("deviceId");
    expect(Object.keys(checked.request)).not.toContain("driverId");
  });
});

describe("localDate", () => {
  it("uses the service time zone, not UTC", () => {
    // 2026-11-26 03:00 UTC is still 25 November in New York.
    const atMs = Date.UTC(2026, 10, 26, 3, 0, 0);
    expect(localDate(atMs, "America/New_York")).toBe("2026-11-25");
    expect(localDate(atMs, "UTC")).toBe("2026-11-26");
  });
});
