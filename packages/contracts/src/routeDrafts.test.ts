import { describe, expect, it } from "vitest";
import statusRequest from "../fixtures/routeDraft.status.request.json" with { type: "json" };
import statusResponse from "../fixtures/routeDraft.status.response.json" with { type: "json" };
import submitAccepted from "../fixtures/routeDraft.submit.accepted.json" with { type: "json" };
import submitRejected from "../fixtures/routeDraft.submit.rejected.json" with { type: "json" };
import submitRequest from "../fixtures/routeDraft.submit.request.json" with { type: "json" };
import { routeDraftFixtureFiles, routeDraftSubmission } from "./routeDraftFixtures.js";
import {
  MAX_ROUTE_DRAFT_BODY_BYTES,
  MAX_ROUTE_DRAFT_LABEL_LENGTH,
  MAX_ROUTE_DRAFT_STATUS_IDS,
  MAX_ROUTE_DRAFT_STOPS,
  ROUTE_DRAFT_CLOCK_TOLERANCE_MS,
  routeDraftContent,
  validateRouteDraftStatusRequest,
  validateRouteDraftSubmission,
} from "./routeDrafts.js";
import { MAX_ROUTE_PATH_POINTS } from "./tracking.js";

const JSON_FILES = {
  "routeDraft.submit.request": submitRequest,
  "routeDraft.submit.accepted": submitAccepted,
  "routeDraft.submit.rejected": submitRejected,
  "routeDraft.status.request": statusRequest,
  "routeDraft.status.response": statusResponse,
};

const NOW = routeDraftSubmission.capturedAtMs + 1_000;
const base = routeDraftSubmission;
const check = (patch: Record<string, unknown>) => validateRouteDraftSubmission({ ...base, ...patch }, NOW);

/** A worst-case draft: every limit at its maximum, long escaped names. */
export function largestDraft() {
  const start = base.startedAtMs;
  const name = "É".repeat(MAX_ROUTE_DRAFT_LABEL_LENGTH);
  return {
    ...base,
    label: name,
    finishedAtMs: start + MAX_ROUTE_PATH_POINTS * 1000,
    capturedAtMs: start + MAX_ROUTE_PATH_POINTS * 1000,
    path: Array.from({ length: MAX_ROUTE_PATH_POINTS }, (_, i) => ({
      latitude: -33.868812345678 + i * 1e-7,
      longitude: -151.209295512345 + i * 1e-7,
      capturedAtMs: start + i * 1000,
      gapBefore: false,
    })),
    stops: Array.from({ length: MAX_ROUTE_DRAFT_STOPS }, (_, i) => ({
      label: name,
      latitude: -33.868812345678,
      longitude: -151.209295512345,
      capturedAtMs: start + i * 1000,
    })),
  };
}

describe("route-draft fixtures on disk match the typed values", () => {
  it.each(Object.entries(routeDraftFixtureFiles))("%s", (name, value) => {
    expect(JSON_FILES[name as keyof typeof JSON_FILES]).toEqual(value);
  });
});

describe("validateRouteDraftSubmission", () => {
  it("accepts the fixture and returns only contract fields", () => {
    const r = validateRouteDraftSubmission({ ...base, extra: "ignored" }, NOW);
    expect(r).toEqual({ ok: true, value: base });
  });

  it("fits the largest draft in the body limit, escaped as the Pi sends it", () => {
    const big = largestDraft();
    // Python json.dumps escapes non-ASCII as \\uXXXX: 6 bytes per character.
    // After escaping, every character is one byte.
    const bytes = JSON.stringify(big).replaceAll("É", "\\u00c9").length;
    expect(bytes).toBeLessThan(MAX_ROUTE_DRAFT_BODY_BYTES);
    expect(validateRouteDraftSubmission(big, big.capturedAtMs).ok).toBe(true);
  });

  it("refuses more points or stops than the limits, with their own codes", () => {
    const big = largestDraft();
    const point = { ...big.path.at(-1)!, capturedAtMs: big.finishedAtMs };
    const morePoints = validateRouteDraftSubmission({ ...big, path: [...big.path, point] }, big.capturedAtMs);
    expect(morePoints).toMatchObject({ ok: false, code: "TOO_MANY_POINTS" });
    const moreStops = validateRouteDraftSubmission({ ...big, stops: [...big.stops, big.stops[0]] }, big.capturedAtMs);
    expect(moreStops).toMatchObject({ ok: false, code: "TOO_MANY_STOPS" });
  });

  it.each([
    ["one point", { path: base.path.slice(0, 1) }],
    ["no stops", { stops: [] }],
    ["bad latitude", { path: [{ ...base.path[0], latitude: 91 }, base.path[1]] }],
    ["NaN longitude", { path: [base.path[0], { ...base.path[1], longitude: Number.NaN }] }],
    ["stop off the globe", { stops: [{ ...base.stops[0], longitude: 181 }] }],
    ["point times out of order", { path: [base.path[1], base.path[0]] }],
    ["point long before the start", { path: [{ ...base.path[0], capturedAtMs: base.startedAtMs - ROUTE_DRAFT_CLOCK_TOLERANCE_MS - 1 }, base.path[1]] }],
    ["stop after the finish", { stops: [{ ...base.stops[0], capturedAtMs: base.finishedAtMs + ROUTE_DRAFT_CLOCK_TOLERANCE_MS + 1 }] }],
    ["finish before start", { finishedAtMs: base.startedAtMs - 1 }],
    ["finished in the future", { finishedAtMs: NOW + ROUTE_DRAFT_CLOCK_TOLERANCE_MS + 1, capturedAtMs: NOW }],
    ["blank label", { label: "   " }],
    ["long stop name", { stops: [{ ...base.stops[0], label: "x".repeat(MAX_ROUTE_DRAFT_LABEL_LENGTH + 1) }] }],
    ["bad direction", { direction: "sideways" }],
    ["bad requestId", { requestId: "nope" }],
    ["bad grant", { driverOperatingGrant: "short" }],
    ["gapBefore missing", { path: [{ ...base.path[0], gapBefore: undefined }, base.path[1]] }],
  ])("refuses %s", (_, patch) => {
    expect(check(patch)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("allows stops in any time order (stops can be reordered on the Pi)", () => {
    expect(check({ stops: base.stops.toReversed() }).ok).toBe(true);
  });
});

describe("routeDraftContent", () => {
  it("ignores the grant, requestId and submit time, but not the recording", () => {
    const retry = { ...base, requestId: "00000000-0000-4000-8000-000000000000", driverOperatingGrant: "Z".repeat(40), capturedAtMs: base.capturedAtMs + 5 };
    expect(routeDraftContent(retry)).toBe(routeDraftContent(base));
    expect(routeDraftContent({ ...base, stops: base.stops.toReversed() })).not.toBe(routeDraftContent(base));
    expect(routeDraftContent({ ...base, label: "Other" })).not.toBe(routeDraftContent(base));
  });
});

describe("validateRouteDraftStatusRequest", () => {
  it("accepts the fixture", () => {
    expect(validateRouteDraftStatusRequest(statusRequest).ok).toBe(true);
  });
  it("bounds the id list", () => {
    const ids = Array.from({ length: MAX_ROUTE_DRAFT_STATUS_IDS + 1 }, (_, i) => `d${i}`);
    expect(validateRouteDraftStatusRequest({ ...statusRequest, draftIds: ids }).ok).toBe(false);
    expect(validateRouteDraftStatusRequest({ ...statusRequest, draftIds: [] }).ok).toBe(false);
    expect(validateRouteDraftStatusRequest({ ...statusRequest, draftIds: ["a b"] }).ok).toBe(false);
  });
});
