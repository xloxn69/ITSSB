import type { CheckInRecord, CheckInSource, TokenProblem } from "@itssb/contracts";

/**
 * What a family command's answer means on screen. Only an answer the server
 * actually gave is shown as sent or recorded; anything else is
 * "not confirmed", and the retry reuses the same request identity.
 */

export const TOKEN_PROBLEM_TEXT: Record<TokenProblem, { title: string; detail: string }> = {
  invalid: { title: "That code didn't work", detail: "Check the code and try again, or scan it again." },
  expired: { title: "This code has expired", detail: "Ask for a new code, or scan the one on the bus again." },
  wrong_purpose: { title: "That's a different kind of code", detail: "This code is for something else. Use the code meant for this step." },
  already_used: { title: "This code was already used", detail: "Guardian codes work once. Ask the school for a new one." },
  unavailable: { title: "This route isn't open yet", detail: "The school hasn't approved this route. Try again later." },
};

export type CommandView =
  | { kind: "sent"; status: string; id: string | null; checkIn: CheckInRecord | null }
  | { kind: "token_problem"; problem: TokenProblem }
  | { kind: "refused"; code: string; message: string }
  | { kind: "signed_out" }
  | { kind: "not_permitted" }
  | { kind: "unconfirmed" };

const PROBLEMS = new Set(["invalid", "expired", "wrong_purpose", "already_used", "unavailable"]);

export function commandView(raw: unknown): CommandView {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.schemaVersion !== 1) return { kind: "unconfirmed" };
  switch (r.status) {
    case "submitted":
      return {
        kind: "sent",
        status: typeof r.requestStatus === "string" ? r.requestStatus : "pending",
        id: (r.enrollmentRequestId ?? r.linkRequestId ?? null) as string | null,
        checkIn: null,
      };
    case "joined":
      return { kind: "sent", status: "joined", id: null, checkIn: null };
    case "accepted":
    case "already_recorded":
      if (!isRecord(r.checkIn)) return { kind: "unconfirmed" };
      return { kind: "sent", status: r.status, id: null, checkIn: r.checkIn };
    case "token_problem":
      return PROBLEMS.has(r.problem as string) ? { kind: "token_problem", problem: r.problem as TokenProblem } : { kind: "unconfirmed" };
    case "refused":
    case "rejected":
      return {
        kind: "refused",
        code: typeof r.code === "string" ? r.code : "unknown",
        message: typeof r.message === "string" ? r.message : "The school's system didn't accept this.",
      };
    case "access_unavailable":
      return r.reason === "unauthenticated" ? { kind: "signed_out" } : { kind: "not_permitted" };
    default:
      return { kind: "unconfirmed" };
  }
}

function isRecord(x: unknown): x is CheckInRecord {
  const c = x as Partial<CheckInRecord> | null;
  return !!c && typeof c.checkInId === "string" && typeof c.recordedAtMs === "number" && typeof c.source === "string";
}

/** Plain words for where a record came from. A scan is a claim, not proof of boarding. */
export const FAMILY_SOURCE_TEXT: Record<CheckInSource, string> = {
  student_qr_claim: "your scan",
  staff_recorded: "recorded by staff",
  staff_correction: "corrected by staff",
};

export function checkInLine(c: CheckInRecord, time: (ms: number) => string): string {
  const what = c.status === "boarded" ? "Checked in" : "Marked not on the bus";
  return `${what} at ${time(c.recordedAtMs)}, ${FAMILY_SOURCE_TEXT[c.source]}`;
}

/**
 * Editing the join form clears an old answer so the person can fix it (A07:
 * a `stop_not_eligible` refusal, then a permitted stop or "school chooses").
 * An unconfirmed answer stays: that request may exist, so its resend must be
 * unchanged under the same identity.
 */
export function clearsOnEdit(view: CommandView | null): boolean {
  return view !== null && view.kind !== "unconfirmed";
}

/** The `enrollment:request` arguments. `"none"` is "the school chooses": no stop is sent. */
export function enrollmentRequestArgs(form: {
  requestId: string;
  token: string;
  studentName: string;
  address: string;
  stopId: string;
  note: string;
}) {
  return {
    requestId: form.requestId,
    token: form.token,
    studentName: form.studentName,
    address: form.address,
    stopId: form.stopId === "none" ? null : form.stopId,
    note: form.note.trim() ? form.note : null,
  };
}
