import {
  checkInAccepted,
  checkInAlreadyRecorded,
  checkInExpired,
  checkInRejected,
  enrollmentRequestRefused,
  enrollmentRequestSubmitted,
  guardianLinkRequestSubmitted,
} from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { checkInLine, commandView } from "./enrollmentModel";

describe("commandView", () => {
  it("shows a request as sent only when the server says submitted", () => {
    expect(commandView(enrollmentRequestSubmitted)).toMatchObject({ kind: "sent", status: "pending", id: "demo_enrollment_request_001" });
    expect(commandView(guardianLinkRequestSubmitted)).toMatchObject({ kind: "sent", id: "demo_link_request_001" });
    expect(commandView(enrollmentRequestRefused)).toMatchObject({ kind: "refused", code: "stop_not_eligible" });
  });

  it("shows a staff invitation as joined only when the server says joined", () => {
    expect(commandView({ schemaVersion: 1, status: "joined", serverNowMs: 1, displayName: "Jamie Staff" })).toMatchObject({ kind: "sent", status: "joined" });
    expect(commandView({ schemaVersion: 1, status: "refused", serverNowMs: 1, code: "invalid_code", message: "No" })).toMatchObject({ kind: "refused", code: "invalid_code" });
    expect(commandView({ schemaVersion: 2, status: "joined" })).toEqual({ kind: "unconfirmed" });
  });

  it("a lost or unreadable answer is unconfirmed, never sent", () => {
    for (const raw of [undefined, null, {}, { schemaVersion: 2, status: "submitted" }, { schemaVersion: 1, status: "accepted" }]) {
      expect(commandView(raw).kind).toBe("unconfirmed");
    }
  });

  it("reads check-in results and token problems", () => {
    expect(commandView(checkInAccepted)).toMatchObject({ kind: "sent", status: "accepted" });
    expect(commandView(checkInAlreadyRecorded)).toMatchObject({ kind: "sent", status: "already_recorded" });
    expect(commandView(checkInExpired)).toEqual({ kind: "token_problem", problem: "expired" });
    expect(commandView(checkInRejected)).toMatchObject({ kind: "refused", code: "run_not_active" });
  });

  it("separates signed out from not permitted", () => {
    expect(commandView({ schemaVersion: 1, status: "access_unavailable", reason: "unauthenticated" }).kind).toBe("signed_out");
    expect(commandView({ schemaVersion: 1, status: "access_unavailable", reason: "not_permitted" }).kind).toBe("not_permitted");
  });

  it("a check-in line names its source and never says verified", () => {
    const c = checkInAccepted.status === "accepted" ? checkInAccepted.checkIn : null;
    const line = checkInLine(c as NonNullable<typeof c>, () => "7:42");
    expect(line).toBe("Checked in at 7:42, your scan");
    expect(line.toLowerCase()).not.toContain("verified");
  });
});

describe("takeLinkedCode", () => {
  it("maps each link path to its page and keeps only the token", async () => {
    const { takeLinkedCode } = await import("./FamilyApp");
    expect(takeLinkedCode({ pathname: "/join", search: "?token=ABCD-EFGH", hash: "" })).toEqual({ page: "join", code: "ABCD-EFGH" });
    expect(takeLinkedCode({ pathname: "/link", search: "?token=X", hash: "" })).toEqual({ page: "link", code: "X" });
    expect(takeLinkedCode({ pathname: "/checkin", search: "", hash: "" })).toEqual({ page: "checkin", code: "" });
    expect(takeLinkedCode({ pathname: "/", search: "?token=X", hash: "" })).toBeNull();
    expect(takeLinkedCode({ pathname: "/join", search: `?token=${"A".repeat(500)}`, hash: "" })?.code).toHaveLength(64);
  });
});
