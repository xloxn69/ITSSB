import { describe, expect, it } from "vitest";
import { validateRosterAction } from "./checkIns.js";
import { checkInFixtureFiles, rosterActionRecordAttendance, rosterActionRemoveAssignment } from "./checkInFixtures.js";
import checkIns_record_accepted from "../fixtures/checkIns.record.accepted.json" with { type: "json" };
import checkIns_record_alreadyRecorded from "../fixtures/checkIns.record.alreadyRecorded.json" with { type: "json" };
import checkIns_record_rejected from "../fixtures/checkIns.record.rejected.json" with { type: "json" };
import checkIns_record_expired from "../fixtures/checkIns.record.expired.json" with { type: "json" };
import checkIns_forAssignment_ready from "../fixtures/checkIns.forAssignment.ready.json" with { type: "json" };
import qrCode_request from "../fixtures/qrCode.request.json" with { type: "json" };
import qrCode_response from "../fixtures/qrCode.response.json" with { type: "json" };
import roster_request from "../fixtures/roster.request.json" with { type: "json" };
import roster_response from "../fixtures/roster.response.json" with { type: "json" };
import rosterAction_recordAttendance_request from "../fixtures/rosterAction.recordAttendance.request.json" with { type: "json" };
import rosterAction_removeAssignment_request from "../fixtures/rosterAction.removeAssignment.request.json" with { type: "json" };
import rosterAction_accepted from "../fixtures/rosterAction.accepted.json" with { type: "json" };
import rosterAction_rejected from "../fixtures/rosterAction.rejected.json" with { type: "json" };

const JSON_FILES = {
  "checkIns.record.accepted": checkIns_record_accepted,
  "checkIns.record.alreadyRecorded": checkIns_record_alreadyRecorded,
  "checkIns.record.rejected": checkIns_record_rejected,
  "checkIns.record.expired": checkIns_record_expired,
  "checkIns.forAssignment.ready": checkIns_forAssignment_ready,
  "qrCode.request": qrCode_request,
  "qrCode.response": qrCode_response,
  "roster.request": roster_request,
  "roster.response": roster_response,
  "rosterAction.recordAttendance.request": rosterAction_recordAttendance_request,
  "rosterAction.removeAssignment.request": rosterAction_removeAssignment_request,
  "rosterAction.accepted": rosterAction_accepted,
  "rosterAction.rejected": rosterAction_rejected,
};

describe("check-in fixtures on disk match the typed values", () => {
  it.each(Object.entries(checkInFixtureFiles))("%s", (name, value) => {
    expect(JSON_FILES[name as keyof typeof JSON_FILES]).toEqual(value);
  });
});

describe("validateRosterAction", () => {
  it("accepts the canonical requests", () => {
    expect(validateRosterAction(rosterActionRecordAttendance).ok).toBe(true);
    expect(validateRosterAction(rosterActionRemoveAssignment).ok).toBe(true);
  });

  it.each([
    ["unknown type", { type: "patchRow" }],
    ["removal without reason", { type: "removeAssignment", reason: " " }],
    ["bad status", { type: "recordAttendance", status: "maybe" }],
    ["short requestId", { requestId: "x" }],
    ["no grant", { driverOperatingGrant: "" }],
    ["fractional time", { capturedAtMs: 1.5 }],
    ["seat too long", { type: "setSeatNote", seatLabel: "x".repeat(13), driverNote: null }],
  ])("rejects %s", (_n, overrides) => {
    expect(validateRosterAction({ ...rosterActionRecordAttendance, ...overrides }).ok).toBe(false);
  });
});
