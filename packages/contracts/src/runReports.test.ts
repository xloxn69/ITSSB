import { describe, expect, it } from "vitest";
import myRunReportedDelayJson from "../fixtures/myRun.reportedDelay.json" with { type: "json" };
import acceptedJson from "../fixtures/runReport.accepted.json" with { type: "json" };
import rejectedJson from "../fixtures/runReport.rejected.json" with { type: "json" };
import requestJson from "../fixtures/runReport.request.json" with { type: "json" };
import { runReportFixtureFiles, runReportRequest } from "./runReportFixtures.js";
import { MAX_RUN_REPORT_DELAY_MINUTES, reportedDelayText, validateRunReport } from "./runReports.js";

const JSON_FILES = {
  "runReport.request": requestJson,
  "runReport.accepted": acceptedJson,
  "runReport.rejected": rejectedJson,
  "myRun.reportedDelay": myRunReportedDelayJson,
};

describe("run-report fixtures on disk match the typed values", () => {
  it.each(Object.entries(runReportFixtureFiles))("%s", (name, value) => {
    expect(JSON_FILES[name as keyof typeof JSON_FILES]).toEqual(value);
  });
});

const check = (patch: Record<string, unknown>) => validateRunReport({ ...runReportRequest, ...patch });

describe("validateRunReport", () => {
  it("accepts the fixture and a report without minutes", () => {
    expect(check({}).ok).toBe(true);
    expect(check({ expectedDelayMinutes: null }).ok).toBe(true);
  });

  it("keeps only the contract's fields, so free text never reaches storage", () => {
    const r = check({ explanation: "Sam Example fell on the steps", note: "x" });
    expect(r.ok && Object.keys(r.value).toSorted()).toEqual(Object.keys(runReportRequest).toSorted());
  });

  it.each([
    ["category outside the fixed list", { category: "late" }],
    ["fractional minutes", { expectedDelayMinutes: 2.5 }],
    ["zero minutes", { expectedDelayMinutes: 0 }],
    ["too many minutes", { expectedDelayMinutes: MAX_RUN_REPORT_DELAY_MINUTES + 1 }],
    ["minutes omitted instead of null", { expectedDelayMinutes: undefined }],
    ["a requestId that is not a UUID", { requestId: "abc" }],
    ["no runId", { runId: 7 }],
    ["no grant", { driverOperatingGrant: "" }],
  ])("refuses %s", (_name, patch) => {
    expect(check(patch).ok).toBe(false);
  });
});

describe("reportedDelayText", () => {
  it("names the category and the minutes, never an arrival time", () => {
    expect(reportedDelayText({ category: "traffic", minutes: 10 })).toBe("Driver reported a delay (traffic), about 10 min");
    expect(reportedDelayText({ category: "mechanical", minutes: null })).toBe("Driver reported a delay (mechanical problem)");
  });
});
