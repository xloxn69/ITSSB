import { describe, expect, it } from "vitest";
import { formatToken, normalizeToken, parseScannedToken } from "./enrollment.js";
import { enrollmentFixtureFiles } from "./enrollmentFixtures.js";
import enrollment_preview_ready from "../fixtures/enrollment.preview.ready.json" with { type: "json" };
import enrollment_preview_expired from "../fixtures/enrollment.preview.expired.json" with { type: "json" };
import enrollment_request_submitted from "../fixtures/enrollment.request.submitted.json" with { type: "json" };
import enrollment_request_refused from "../fixtures/enrollment.request.refused.json" with { type: "json" };
import enrollment_myRequests_ready from "../fixtures/enrollment.myRequests.ready.json" with { type: "json" };
import guardianLinks_request_submitted from "../fixtures/guardianLinks.request.submitted.json" with { type: "json" };
import guardianLinks_myRequests_ready from "../fixtures/guardianLinks.myRequests.ready.json" with { type: "json" };


const HOSTS = ["example.invalid"];

const JSON_FILES = {
  "enrollment.preview.ready": enrollment_preview_ready,
  "enrollment.preview.expired": enrollment_preview_expired,
  "enrollment.request.submitted": enrollment_request_submitted,
  "enrollment.request.refused": enrollment_request_refused,
  "enrollment.myRequests.ready": enrollment_myRequests_ready,
  "guardianLinks.request.submitted": guardianLinks_request_submitted,
  "guardianLinks.myRequests.ready": guardianLinks_myRequests_ready,
};

describe("scoped token parsing", () => {
  it("normalizes case, spaces and dashes", () => {
    expect(normalizeToken(" abcd-efgh jkmn-pqrs-tvwx ")).toBe("ABCDEFGHJKMNPQRSTVWX");
    expect(formatToken("ABCDEFGHJKMNPQRSTVWX")).toBe("ABCD-EFGH-JKMN-PQRS-TVWX");
  });

  it.each(["", "ABCD", "ABCDEFGHJKMNPQRSTVWXY", "ILOU-ILOU-ILOU-ILOU-ILOU", "x".repeat(65)])("rejects %j", (raw) => {
    expect(normalizeToken(raw)).toBeNull();
  });

  it("accepts a link only on an allowed host with the purpose's path", () => {
    const code = "ABCD-EFGH-JKMN-PQRS-TVWX";
    expect(parseScannedToken(`https://example.invalid/join?token=${code}`, "route_enrollment", HOSTS)).toBe(
      "ABCDEFGHJKMNPQRSTVWX",
    );
    expect(parseScannedToken(code, "trip_check_in", HOSTS)).toBe("ABCDEFGHJKMNPQRSTVWX");
    for (const bad of [
      `http://example.invalid/join?token=${code}`,
      `https://evil.example/join?token=${code}`,
      `https://example.invalid/checkin?token=${code}`,
      `https://example.invalid/join?token=${code}&next=x`,
      `https://example.invalid/join?token=${code}#x`,
      `https://example.invalid.evil.example/join?token=${code}`,
    ]) {
      expect(parseScannedToken(bad, "route_enrollment", HOSTS)).toBeNull();
    }
  });
});

describe("enrollment fixtures on disk match the typed values", () => {
  it.each(Object.entries(enrollmentFixtureFiles))("%s", (name, value) => {
    expect(JSON_FILES[name as keyof typeof JSON_FILES]).toEqual(value);
  });
});
