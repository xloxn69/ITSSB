import { POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { describe, expect, it } from "vitest";
import { staffFixtureSource } from "../dev/staffFixtures";
import { approvalBlocker, contactStatus } from "./format";
import { mutationOutcome, queryState } from "./source";

describe("queryState", () => {
  it("separates ready, not found, denial, and malformed answers", () => {
    expect(queryState({ schemaVersion: 1, status: "ready", routes: [] })).toMatchObject({ kind: "ready" });
    expect(queryState({ schemaVersion: 1, status: "not_found" })).toEqual({ kind: "not_found" });
    expect(queryState({ schemaVersion: 1, status: "access_unavailable", reason: "not_permitted" })).toEqual({
      kind: "access_unavailable",
      reason: "not_permitted",
    });
    expect(queryState({ schemaVersion: 2, status: "ready" })).toEqual({ kind: "failed" });
    expect(queryState(null)).toEqual({ kind: "failed" });
  });

  it("never reads a refusal or garbage as done", () => {
    expect(mutationOutcome({ schemaVersion: 1, status: "refused", message: "No" }, "Done")).toEqual({
      kind: "refused",
      message: "No",
    });
    expect(mutationOutcome(undefined, "Done").kind).toBe("failed");
    expect(mutationOutcome({ schemaVersion: 1, status: "approved" }, "Approved").kind).toBe("done");
  });
});

describe("contactStatus", () => {
  const now = 1_000_000_000;
  it("marks a device silent past the stale cutoff as not reporting", () => {
    expect(contactStatus(now - POSITION_STALE_AFTER_MS, now, now, now, false).tone).toBe("stale");
    expect(contactStatus(now - 5_000, now, now, now, false).tone).toBe("fresh");
  });

  it("a slow browser clock cannot make contact look recent", () => {
    // Browser 10 min slow; server says contact was 10 min ago.
    const slow = now - 10 * 60_000;
    expect(contactStatus(now - 10 * 60_000, now, slow, slow, false).tone).toBe("stale");
  });

  it("revoked and never-seen devices are not shown as reporting", () => {
    expect(contactStatus(now, now, now, now, true).tone).toBe("unknown");
    expect(contactStatus(null, now, now, now, false)).toEqual({ text: "No contact recorded", tone: "unknown" });
  });
});

describe("approvalBlocker", () => {
  it("allows only a waiting draft without blocking checks", () => {
    expect(approvalBlocker({ status: "submitted", checks: [] })).toBeNull();
    expect(approvalBlocker({ status: "submitted", checks: [{ code: "path_gap", severity: "warning", message: "" }] })).toBeNull();
    expect(approvalBlocker({ status: "submitted", checks: [{ code: "no_stops", severity: "blocking", message: "" }] })).not.toBeNull();
    expect(approvalBlocker({ status: "approved", checks: [] })).not.toBeNull();
  });
});

describe("staff fixtures follow the server's review rules", () => {
  it("approving a new route adds v1 to the library; a revision of an assigned route is refused", async () => {
    const source = staffFixtureSource("staff");
    expect(await source.mutate("routes:approveDraft", { draftId: "demo_draft_009" })).toMatchObject({
      status: "approved",
      versionNumber: 1,
    });
    expect(await source.mutate("routes:approveDraft", { draftId: "demo_draft_017" })).toMatchObject({
      status: "refused",
      code: "route_has_assignments",
    });
    expect(await source.mutate("routes:approveDraft", { draftId: "demo_draft_021" })).toMatchObject({
      code: "blocking_checks",
    });
    const routes = await new Promise((resolve) => source.watch("routes:list", {}, resolve, () => {}));
    expect(routes).toMatchObject({ routes: expect.arrayContaining([expect.objectContaining({ label: "Route 9 Morning" })]) });
  });
});
