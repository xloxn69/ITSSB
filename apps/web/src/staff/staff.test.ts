import { POSITION_STALE_AFTER_MS } from "@itssb/contracts";
import { describe, expect, it } from "vitest";
import { staffFixtureSource } from "../dev/staffFixtures";
import {
  approvalBlocker,
  contactStatus,
  driversFileEntry,
  invitationState,
  maintenanceWindow,
  PIN_HASH_PLACEHOLDER,
  runActionsAvailable,
  serviceDateLabel,
  sweepSummary,
} from "./format";
import { credentialOutcome, grantOutcome, mutationOutcome, queryState } from "./source";
import { pathSegments } from "./DraftDiagram";

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

describe("credentialOutcome", () => {
  const secret = "f".repeat(64);
  it("shows a secret only for a well-formed issued answer", () => {
    expect(credentialOutcome({ schemaVersion: 1, status: "issued", deviceId: "d1", deviceSecret: secret })).toEqual({
      kind: "issued",
      deviceId: "d1",
      deviceSecret: secret,
    });
    expect(credentialOutcome({ schemaVersion: 1, status: "issued", deviceId: "d1" }).kind).toBe("failed");
    expect(credentialOutcome({ schemaVersion: 1, status: "issued", deviceId: "d1", deviceSecret: "short" }).kind).toBe("failed");
    expect(credentialOutcome({ schemaVersion: 1, status: "ok" }).kind).toBe("failed");
  });

  it("passes refusals and denials through without a secret", () => {
    expect(credentialOutcome({ schemaVersion: 1, status: "refused", code: "revoked", message: "Revoked." })).toEqual({
      kind: "refused",
      message: "Revoked.",
    });
    expect(credentialOutcome({ schemaVersion: 1, status: "access_unavailable", reason: "not_permitted" })).toEqual({
      kind: "access_unavailable",
      reason: "not_permitted",
    });
  });
});

describe("fixture credential actions", () => {
  it("rotation issues a new fictional secret and refuses a revoked device", async () => {
    const source = staffFixtureSource("staff");
    const rotated = credentialOutcome(await source.act("fleet:rotateDeviceCredential", { deviceId: "demo_device_001" }));
    expect(rotated.kind).toBe("issued");
    const refused = credentialOutcome(await source.act("fleet:rotateDeviceCredential", { deviceId: "demo_device_004" }));
    expect(refused.kind).toBe("refused");
  });
});

describe("sweepSummary", () => {
  it("says what a retention sweep deleted, and nothing for an unreadable record", () => {
    expect(sweepSummary("telemetry:1440,live:2")).toBe("1440 positions and 2 last-known positions deleted");
    expect(sweepSummary("telemetry:1,live:1")).toBe("1 position and 1 last-known position deleted");
    expect(sweepSummary("garbage")).toBeNull();
    expect(sweepSummary(null)).toBeNull();
  });
});

describe("enrollment staff pages", () => {
  it("attendance text names its source and never claims verified boarding", async () => {
    const { recordText, SOURCE_LABEL } = await import("./EnrollmentPages");
    const base = { checkInId: "c", recordedAtMs: 0, receivedAtMs: 0 };
    expect(recordText(null)).toBe("Nothing recorded");
    expect(recordText({ ...base, status: "boarded", source: "student_qr_claim" })).toContain("Student QR claim");
    expect(recordText({ ...base, status: "not_boarded", source: "staff_correction" })).toContain("Staff correction");
    for (const label of Object.values(SOURCE_LABEL)) expect(label.toLowerCase()).not.toContain("verified");
  });

  it("reads new success statuses as done and a refusal as refused", () => {
    for (const status of ["revoked", "created", "accepted", "already_recorded"]) {
      expect(mutationOutcome({ schemaVersion: 1, status }, "Done").kind).toBe("done");
    }
    expect(mutationOutcome({ schemaVersion: 1, status: "refused", message: "Choose a stop" }, "Done")).toEqual({
      kind: "refused",
      message: "Choose a stop",
    });
    expect(mutationOutcome({ schemaVersion: 1, status: "token_problem" }, "Done").kind).toBe("failed");
  });

  it("the fixture source refuses an approval at a stop outside the route", async () => {
    const source = staffFixtureSource("staff");
    const result = await source.mutate("enrollment:approve", { enrollmentRequestId: "demo_enrollment_request_001", stopId: "elsewhere" });
    expect(mutationOutcome(result, "Approved").kind).toBe("refused");
  });
});

describe("maintenanceWindow", () => {
  it("builds a bounded window and refuses unusable input", () => {
    const w = maintenanceWindow("2026-11-28T09:00", 2);
    expect(w && w.endsAtMs - w.startsAtMs).toBe(2 * 60 * 60_000);
    expect(maintenanceWindow("2026-11-28", 2)).toBeNull();
    expect(maintenanceWindow("2026-11-28T09:00", 0)).toBeNull();
    expect(maintenanceWindow("2026-11-28T09:00", 13)).toBeNull();
    expect(maintenanceWindow("2026-11-28T09:00", Number.NaN)).toBeNull();
  });
});

describe("serviceDateLabel", () => {
  it("shows the calendar day itself, whatever the browser's time zone", () => {
    expect(serviceDateLabel("2026-11-28")).toMatch(/28/);
    expect(serviceDateLabel("junk")).toBe("junk");
  });
});

describe("fixture service operations", () => {
  it("cancelling a run needs a reason and then ends it", async () => {
    const source = staffFixtureSource("staff");
    expect(mutationOutcome(await source.mutate("runOps:cancelRun", { runId: "demo_run_001", reason: " " }), "x").kind).toBe(
      "refused",
    );
    expect(mutationOutcome(await source.mutate("runOps:cancelRun", { runId: "demo_run_001", reason: "Weather" }), "x").kind).toBe(
      "done",
    );
    expect(mutationOutcome(await source.mutate("runOps:cancelRun", { runId: "demo_run_001", reason: "Again" }), "x").kind).toBe(
      "refused",
    );
  });
});

describe("runActionsAvailable", () => {
  const device = { deviceId: "d", label: "Pi", busLabel: null, lastContactAtMs: null };
  const run = { runId: "r", routeLabel: null, startedAtMs: null };
  it("offers cancel and replace for any active run, including on a revoked bus", () => {
    expect(runActionsAvailable({ ...device, revoked: false, activeRun: run })).toBe(true);
    // Revoking mid-run leaves the run active and the route occupied; staff must be able to clear it.
    expect(runActionsAvailable({ ...device, revoked: true, activeRun: run })).toBe(true);
    expect(runActionsAvailable({ ...device, revoked: false, activeRun: null })).toBe(false);
  });
});

describe("grantOutcome", () => {
  const issued = {
    schemaVersion: 1,
    status: "issued",
    serverNowMs: 1,
    grantId: "g1",
    grant: "a".repeat(64),
    expiresAtMs: 2,
    driverUserId: "u1",
    driverName: "Dana Driver",
    deviceId: "d1",
    routeVersions: [{ routeVersionId: "rv1", label: "Route 17 Morning" }],
  };
  it("shows a grant only for a well-formed issued answer the Pi would accept", () => {
    expect(grantOutcome(issued)).toEqual({
      kind: "issued",
      grant: issued.grant,
      expiresAtMs: 2,
      driverUserId: "u1",
      driverName: "Dana Driver",
      routeVersions: [{ routeVersionId: "rv1", label: "Route 17 Morning" }],
    });
    expect(grantOutcome({ ...issued, grant: "short" }).kind).toBe("failed");
    expect(grantOutcome({ ...issued, grant: "has spaces ".repeat(4) }).kind).toBe("failed");
    expect(grantOutcome({ ...issued, routeVersions: [] }).kind).toBe("failed");
    expect(grantOutcome({ ...issued, routeVersions: [{ routeVersionId: 3 }] }).kind).toBe("failed");
    expect(grantOutcome({ ...issued, expiresAtMs: undefined }).kind).toBe("failed");
    expect(grantOutcome({ schemaVersion: 1, status: "ok" }).kind).toBe("failed");
  });
  it("passes refusals and denials through without a grant", () => {
    expect(grantOutcome({ schemaVersion: 1, status: "refused", code: "invalid_ttl", message: "No" })).toEqual({ kind: "refused", message: "No" });
    expect(grantOutcome({ schemaVersion: 1, status: "access_unavailable", reason: "not_permitted" })).toEqual({
      kind: "access_unavailable",
      reason: "not_permitted",
    });
  });
});

describe("driversFileEntry", () => {
  it("is exactly the Pi's drivers-file entry shape, with the PIN hash left for the Pi", () => {
    const entry = JSON.parse(
      driversFileEntry({
        driverUserId: "u1",
        driverName: "Dana Driver",
        grant: "a".repeat(64),
        routeVersions: [{ routeVersionId: "rv1", label: "Route 17 Morning" }],
      }),
    );
    expect(entry).toEqual({
      driverId: "u1",
      displayName: "Dana Driver",
      pinHash: PIN_HASH_PLACEHOLDER,
      operatingGrant: "a".repeat(64),
      routeVersions: [{ routeVersionId: "rv1", label: "Route 17 Morning" }],
    });
    // The Pi refuses a drivers file whose pinHash isn't an scrypt hash, so a
    // forgotten placeholder fails closed instead of unlocking.
    expect(PIN_HASH_PLACEHOLDER.startsWith("scrypt$")).toBe(false);
  });
});

describe("invitationState", () => {
  const now = 1_000_000;
  it("offers revoke only while the code is still waiting", () => {
    expect(invitationState({ revoked: false, usedAtMs: null, expiresAtMs: now + 1 }, now).pending).toBe(true);
    expect(invitationState({ revoked: false, usedAtMs: null, expiresAtMs: now }, now)).toEqual({ text: "Expired", pending: false });
    expect(invitationState({ revoked: true, usedAtMs: null, expiresAtMs: now + 1 }, now)).toEqual({ text: "Revoked", pending: false });
    expect(invitationState({ revoked: true, usedAtMs: now - 5, expiresAtMs: now + 1 }, now).text).toMatch(/^Joined/);
  });
});

describe("pathSegments", () => {
  it("draws the segment across a GPS loss on its own, so it can be dashed", () => {
    expect(pathSegments(["a", "b", "c", "d", "e"], [2])).toEqual([
      { points: ["a", "b"], gap: false },
      { points: ["b", "c"], gap: true },
      { points: ["c", "d", "e"], gap: false },
    ]);
  });
  it("handles a gap at the end, adjacent gaps, and ignores impossible indexes", () => {
    expect(pathSegments(["a", "b", "c"], [1, 2])).toEqual([
      { points: ["a", "b"], gap: true },
      { points: ["b", "c"], gap: true },
    ]);
    expect(pathSegments(["a", "b", "c"], [0, 9, 1.5])).toEqual([{ points: ["a", "b", "c"], gap: false }]);
    expect(pathSegments(["a", "b"])).toEqual([{ points: ["a", "b"], gap: false }]);
  });
});
