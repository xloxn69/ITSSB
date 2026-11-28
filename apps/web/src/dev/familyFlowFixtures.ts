/**
 * Development-only family enrollment, link and check-in answers, built from
 * the canonical fictional fixtures. `?fixture=family-flows&v=<variant>`.
 * The real rules live in apps/backend/convex.
 */
import { normalizeToken } from "@itssb/contracts";
import {
  checkInAccepted,
  myAssignmentsReady,
  myEnrollmentRequestsReady,
  myGuardianLinkRequestsReady,
  previewInvitationReady,
} from "@itssb/contracts/fixtures";
import type { FamilyMutationName, FamilyQueryName, FamilySource } from "../family/familySource";

export const FAMILY_FLOW_VARIANTS = ["default", "guardian", "no-trip", "done", "offline", "empty", "loading"] as const;
export type FamilyFlowVariant = (typeof FAMILY_FLOW_VARIANTS)[number];

const env = (body: object) => ({ schemaVersion: 1, serverNowMs: Date.now(), ...body });

export function familyFlowSource(variant: FamilyFlowVariant): FamilySource {
  let recorded = variant === "done" && checkInAccepted.status === "accepted" ? { ...checkInAccepted.checkIn, recordedAtMs: Date.now() - 4 * 60_000 } : null;
  const listeners = new Set<() => void>();

  function answer(name: FamilyQueryName, args: Record<string, string | null>): unknown {
    switch (name) {
      case "enrollment:previewInvitation": {
        const t = normalizeToken(args.token ?? "") ?? "";
        if (t.startsWith("EXP")) return env({ status: "token_problem", problem: "expired" });
        if (t.startsWith("GRD")) return env({ status: "token_problem", problem: "wrong_purpose" });
        return { ...previewInvitationReady, serverNowMs: Date.now(), expiresAtMs: Date.now() + 3 * 24 * 3600_000 };
      }
      case "enrollment:myRequests":
        return variant === "empty" ? env({ status: "ready", requests: [] }) : myEnrollmentRequestsReady;
      case "guardianLinks:myRequests":
        return variant === "empty" ? env({ status: "ready", requests: [] }) : myGuardianLinkRequestsReady;
      case "tracking:myAssignments":
        if (variant === "guardian" && myAssignmentsReady.status === "ready") {
          return { ...myAssignmentsReady, assignments: myAssignmentsReady.assignments.map((a) => ({ ...a, relationship: "guardian" })) };
        }
        return myAssignmentsReady;
      case "checkIns:forAssignment":
        return env({ status: "ready", assignmentId: args.assignmentId, runId: variant === "no-trip" ? null : "demo_run_001", checkIn: recorded });
    }
  }

  function mutate(name: FamilyMutationName, args: Record<string, string | null>): unknown {
    if (variant === "offline") throw new Error("fixture: offline");
    switch (name) {
      case "enrollment:request":
        if ((args.studentName ?? "").toLowerCase().includes("refuse")) {
          return env({ status: "refused", code: "already_requested", message: "A request for this route is already waiting for the school." });
        }
        return env({ status: "submitted", enrollmentRequestId: "demo_enrollment_request_009", requestStatus: "pending" });
      case "guardianLinks:request":
        return env({ status: "submitted", linkRequestId: "demo_link_request_009", requestStatus: "pending" });
      case "staffInvitations:redeem": {
        // Codes starting "BAD" stand in for every unusable code; "LNK" for a sign-in already linked.
        const t = normalizeToken(args.token ?? "") ?? "";
        if (t.startsWith("BAD")) {
          return env({ status: "refused", code: "invalid_code", message: "This code can't be used. Ask the person who invited you for a new one." });
        }
        if (t.startsWith("LNK")) {
          return env({ status: "refused", code: "already_linked", message: "This sign-in already belongs to an account. Sign in with a different email to join as staff." });
        }
        return env({ status: "joined", displayName: "Jamie Staff" });
      }
      case "checkIns:record": {
        const t = normalizeToken(args.token ?? "") ?? "";
        if (t.startsWith("EXP")) return env({ status: "token_problem", problem: "expired" });
        const first = !recorded;
        recorded ??= {
          checkInId: "demo_check_in_009",
          status: "boarded",
          source: "student_qr_claim",
          recordedAtMs: Date.now(),
          receivedAtMs: Date.now(),
        };
        for (const l of listeners) l();
        return env({ status: first ? "accepted" : "already_recorded", requestId: args.requestId, runId: args.runId, checkIn: recorded });
      }
    }
  }

  return {
    watch(name, args, onValue) {
      if (variant === "loading") return () => {};
      const emit = () => onValue(structuredClone(answer(name, args)));
      const t = setTimeout(emit, 0);
      listeners.add(emit);
      return () => {
        clearTimeout(t);
        listeners.delete(emit);
      };
    },
    mutate: async (name, args) => mutate(name, args),
  };
}
