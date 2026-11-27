/**
 * Enrollment and guardian-link contract (docs/09 §3–§5, docs/08 §9).
 *
 * Family functions resolve the caller from the verified sign-in identity.
 * A new applicant has no approved `users` row yet, so these functions key
 * on that identity; only staff approval creates the account, the student
 * record, the assignment, or the guardian link. A pending request never
 * grants tracking.
 *
 * Every nullable field is sent explicitly as `null`, never omitted.
 */
import type { SCHEMA_VERSION } from "./index.js";
import type { RouteDirection } from "./staff.js";
import type { AccessUnavailable } from "./tracking.js";

type Envelope = { schemaVersion: typeof SCHEMA_VERSION; serverNowMs: number };
type Ready<T> = Envelope & { status: "ready" } & T;

// MARK: Scoped tokens

/**
 * The three token purposes (docs/09 §2). A token is valid only for its own
 * purpose: an enrollment invitation is never a check-in challenge, and
 * neither one links a guardian.
 */
export const TOKEN_PURPOSES = ["route_enrollment", "guardian_link", "trip_check_in"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/**
 * Tokens are 20 characters of Crockford base32 (100 random bits), shown in
 * groups of four (`ABCD-EFGH-JKMN-PQRS-TVWX`). Clients may send them with or
 * without dashes and in any case; `normalizeToken` gives the canonical form
 * the server hashes. Only the hash is stored.
 */
export const TOKEN_LENGTH = 20;
export const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Canonical token, or null if the text cannot be one. Rejects before any lookup. */
export function normalizeToken(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length !== TOKEN_LENGTH) return null;
  for (const ch of compact) if (!TOKEN_ALPHABET.includes(ch)) return null;
  return compact;
}

/** `ABCD-EFGH-JKMN-PQRS-TVWX`, for display and manual entry. */
export function formatToken(token: string): string {
  return (token.match(/.{1,4}/g) ?? []).join("-");
}

/**
 * Link paths per purpose. The host is a deployment decision (docs/08 §9);
 * documentation and fixtures use `https://example.invalid`.
 */
export const TOKEN_LINK_PATHS: Record<TokenPurpose, string> = {
  route_enrollment: "/join",
  guardian_link: "/link",
  trip_check_in: "/checkin",
};

/**
 * Extracts a token from a scanned QR payload or typed code. Accepts a bare
 * code, or an HTTPS link on one of `allowedHosts` whose path is the
 * purpose's path and whose only query parameter is `token`. The backend
 * still validates purpose, expiry, revocation and scope.
 */
export function parseScannedToken(
  text: string,
  purpose: TokenPurpose,
  allowedHosts: readonly string[],
): string | null {
  if (typeof text !== "string" || text.length > 256) return null;
  const trimmed = text.trim();
  const bare = normalizeToken(trimmed);
  if (bare) return bare;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !allowedHosts.includes(url.host)) return null;
  if (url.pathname !== TOKEN_LINK_PATHS[purpose]) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "token") return null;
  return normalizeToken(url.searchParams.get("token") ?? "");
}

/** Why a token was not accepted. Unknown and revoked are deliberately the same. */
export const TOKEN_PROBLEMS = ["invalid", "expired", "wrong_purpose", "already_used", "unavailable"] as const;
export type TokenProblem = (typeof TOKEN_PROBLEMS)[number];

// MARK: Limits

export const MAX_STUDENT_NAME_LENGTH = 80;
export const MAX_ADDRESS_LENGTH = 200;
export const MAX_NOTE_LENGTH = 300;
export const MAX_REASON_LENGTH = 300;
/** Enrollment invitations: from one hour to 30 days. */
export const MIN_INVITATION_TTL_MS = 60 * 60 * 1000;
export const MAX_ENROLLMENT_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Guardian invitations are single use and last at most 14 days. */
export const MAX_GUARDIAN_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const REQUEST_STATUSES = ["pending", "approved", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// MARK: enrollment:previewInvitation (family)

export interface EligibleStop {
  stopId: string;
  label: string;
  /** Travel order, from 0. */
  sequence: number;
  instructions: string | null;
}

/**
 * What a valid enrollment invitation offers before any request: the route's
 * label and direction and its approved stops. Never the bus position, the
 * roster, or another family's data (docs/09 §4 step 2).
 */
export type PreviewInvitationResult =
  | Ready<{
      routeLabel: string;
      direction: RouteDirection;
      expiresAtMs: number;
      stops: EligibleStop[];
    }>
  | (Envelope & { status: "token_problem"; problem: TokenProblem })
  | AccessUnavailable;

// MARK: enrollment:request (family)

export interface EnrollmentRequestArgs {
  /** UUID created once per submission; reused after a timeout or double tap. */
  requestId: string;
  token: string;
  studentName: string;
  address: string;
  /** An approved stop from the preview, or null when none fits (manual review). */
  stopId: string | null;
  note: string | null;
}

export const ENROLLMENT_REFUSAL_CODES = [
  "invalid_details",
  "stop_not_eligible",
  "request_id_conflict",
  "already_requested",
  "already_enrolled",
] as const;
export type EnrollmentRefusalCode = (typeof ENROLLMENT_REFUSAL_CODES)[number];

export type EnrollmentRequestResult =
  | (Envelope & {
      /** The backend has the request. A retry with the same requestId returns this again. */
      status: "submitted";
      enrollmentRequestId: string;
      requestStatus: RequestStatus;
    })
  | (Envelope & { status: "token_problem"; problem: TokenProblem })
  | (Envelope & { status: "refused"; code: EnrollmentRefusalCode; message: string })
  | AccessUnavailable;

// MARK: enrollment:myRequests (family)

export interface MyEnrollmentRequest {
  enrollmentRequestId: string;
  routeLabel: string;
  direction: RouteDirection;
  studentName: string;
  /** The stop asked for, or null for manual review. */
  requestedStopLabel: string | null;
  status: RequestStatus;
  submittedAtMs: number;
  decidedAtMs: number | null;
  /** Staff's reason, shown only for a rejection. */
  decisionReason: string | null;
}

export type MyEnrollmentRequestsResult = Ready<{ requests: MyEnrollmentRequest[] }> | AccessUnavailable;

// MARK: guardianLinks:request, guardianLinks:myRequests (family)

export interface GuardianLinkRequestArgs {
  requestId: string;
  token: string;
  guardianName: string;
}

export type GuardianLinkRequestResult =
  | (Envelope & { status: "submitted"; linkRequestId: string; requestStatus: RequestStatus })
  | (Envelope & { status: "token_problem"; problem: TokenProblem })
  | (Envelope & {
      status: "refused";
      code: "invalid_details" | "request_id_conflict" | "already_linked";
      message: string;
    })
  | AccessUnavailable;

export interface MyGuardianLinkRequest {
  linkRequestId: string;
  status: RequestStatus;
  submittedAtMs: number;
  decidedAtMs: number | null;
  decisionReason: string | null;
  /** Shown only once the link is approved; a pending request reveals nothing. */
  studentDisplayName: string | null;
}

export type MyGuardianLinkRequestsResult = Ready<{ requests: MyGuardianLinkRequest[] }> | AccessUnavailable;

// MARK: Staff: invitations

export interface CreatedInvitation {
  invitationId: string;
  /** Shown once; only its hash is stored. */
  token: string;
  expiresAtMs: number;
}

export type CreateInvitationResult =
  | (Envelope & { status: "created" } & CreatedInvitation)
  | (Envelope & { status: "refused"; code: "not_found" | "invalid_ttl" | "route_unavailable"; message: string })
  | AccessUnavailable;

export interface InvitationSummary {
  invitationId: string;
  purpose: "route_enrollment" | "guardian_link";
  /** Route label for an enrollment invitation; null for a guardian invitation. */
  routeLabel: string | null;
  /** Student name for a guardian invitation; null for an enrollment invitation. */
  studentDisplayName: string | null;
  issuedAtMs: number;
  issuedByName: string | null;
  expiresAtMs: number;
  revoked: boolean;
  /** Guardian invitations are single use. */
  usedAtMs: number | null;
}

export type ListInvitationsResult = Ready<{ invitations: InvitationSummary[] }> | AccessUnavailable;

// MARK: Staff: review

export interface EnrollmentRequestForReview {
  enrollmentRequestId: string;
  routeId: string;
  routeLabel: string;
  direction: RouteDirection;
  studentName: string;
  /** Private: staff review only, never returned to drivers or other families. */
  address: string;
  note: string | null;
  requestedStopId: string | null;
  requestedStopLabel: string | null;
  /** The route's current approved stops, for choosing at approval. */
  eligibleStops: EligibleStop[];
  status: RequestStatus;
  submittedAtMs: number;
  decidedAtMs: number | null;
  reviewerName: string | null;
  decisionReason: string | null;
  assignmentId: string | null;
}

export type ListEnrollmentRequestsResult =
  | Ready<{ requests: EnrollmentRequestForReview[] }>
  | AccessUnavailable;

export interface GuardianLinkRequestForReview {
  linkRequestId: string;
  guardianName: string;
  studentId: string;
  studentDisplayName: string;
  status: RequestStatus;
  submittedAtMs: number;
  decidedAtMs: number | null;
  reviewerName: string | null;
  decisionReason: string | null;
}

export type ListGuardianLinkRequestsResult =
  | Ready<{ requests: GuardianLinkRequestForReview[] }>
  | AccessUnavailable;

export const DECISION_REFUSAL_CODES = [
  "not_found",
  "already_decided",
  "stop_not_eligible",
  "route_unavailable",
  /** The applicant's sign-in is already a staff or driver account. */
  "account_conflict",
  "reason_required",
] as const;
export type DecisionRefusalCode = (typeof DECISION_REFUSAL_CODES)[number];

export type DecisionResult =
  | (Envelope & { status: "approved"; assignmentId: string | null; guardianLinkId: string | null })
  | (Envelope & { status: "rejected" })
  | (Envelope & { status: "revoked" })
  | (Envelope & { status: "refused"; code: DecisionRefusalCode; message: string })
  | AccessUnavailable;

// MARK: Staff: students

export interface StudentSummary {
  studentId: string;
  displayName: string;
  hasOwnAccount: boolean;
  assignments: {
    assignmentId: string;
    routeLabel: string;
    direction: RouteDirection | null;
    stopLabel: string;
    status: "approved" | "revoked";
  }[];
  guardians: { guardianLinkId: string; guardianName: string; status: "approved" | "revoked" }[];
}

export type ListStudentsResult = Ready<{ students: StudentSummary[] }> | AccessUnavailable;

// MARK: Staff: audit

export interface AuditEntry {
  auditId: string;
  atMs: number;
  /** Person's display name, `device:<label>`, or `system`. */
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: "allowed" | "denied";
  reason: string | null;
  /** Where the action came from: `staff_web`, `family_app`, `driver_device`. */
  source: string | null;
  /** Device capture time for an action queued on the Pi. */
  capturedAtMs: number | null;
}

export type ListAuditResult = Ready<{ entries: AuditEntry[] }> | AccessUnavailable;
