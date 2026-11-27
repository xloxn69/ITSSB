/**
 * Staff console data (docs/08 §11). The server decides access on every
 * call; these pages only display what it returns, including a denial.
 */
import type { AccessUnavailableReason } from "@itssb/contracts";
import type { Unsubscribe } from "../tracking/store";

export type StaffQueryName =
  | "routes:list"
  | "routes:listDrafts"
  | "routes:getDraft"
  | "fleet:listDevices"
  | "fleet:listDrivers"
  | "fleet:diagnostics"
  | "enrollment:listRequests"
  | "enrollment:listInvitations"
  | "guardianLinks:listRequests"
  | "students:list"
  | "checkIns:recentRuns"
  | "checkIns:runAttendance"
  | "audit:list";

export type StaffMutationName =
  | "routes:approveDraft"
  | "routes:rejectDraft"
  | "fleet:setBusLabel"
  | "fleet:revokeDevice"
  | "enrollment:approve"
  | "enrollment:reject"
  | "enrollment:revokeInvitation"
  | "guardianLinks:approve"
  | "guardianLinks:reject"
  | "guardianLinks:revoke"
  | "routes:removeAssignment"
  | "checkIns:staffRecord";

/** Actions create invitation codes, which need real randomness on the server. */
export type StaffActionName =
  | "enrollment:createRouteInvitation"
  | "guardianLinks:createInvitation"
  | "fleet:provisionDevice"
  | "fleet:rotateDeviceCredential";

/** Convex actions: they return a one-time device secret (docs/14 §4). */

export interface StaffSource {
  watch(
    name: StaffQueryName,
    args: Record<string, string>,
    onValue: (raw: unknown) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;
  mutate(name: StaffMutationName, args: Record<string, string>): Promise<unknown>;
  act(name: StaffActionName, args: Record<string, string | number>): Promise<unknown>;
}

export type QueryState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "not_found" }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason }
  | { kind: "failed" };

/**
 * Checks a staff envelope before showing it. A malformed or unexpected
 * answer is a failure, never an empty list.
 */
export function queryState<T>(raw: unknown): QueryState<T> {
  if (!raw || typeof raw !== "object") return { kind: "failed" };
  const env = raw as { schemaVersion?: unknown; status?: unknown; reason?: unknown };
  if (env.schemaVersion !== 1) return { kind: "failed" };
  if (env.status === "ready") return { kind: "ready", value: raw as T };
  if (env.status === "not_found") return { kind: "not_found" };
  if (env.status === "access_unavailable" && (env.reason === "unauthenticated" || env.reason === "not_permitted")) {
    return { kind: "access_unavailable", reason: env.reason };
  }
  return { kind: "failed" };
}

/** What a mutation result means for the person who pressed the button. */
export type MutationOutcome =
  | { kind: "done"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "access_unavailable"; reason: AccessUnavailableReason }
  | { kind: "failed"; message: string };

const DONE_STATUSES = new Set(["ok", "approved", "rejected", "revoked", "created", "accepted", "already_recorded"]);

export function mutationOutcome(raw: unknown, doneMessage: string): MutationOutcome {
  const env = (raw ?? {}) as { schemaVersion?: unknown; status?: unknown; message?: unknown; reason?: unknown };
  if (env.schemaVersion !== 1) return { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." };
  if (env.status === "access_unavailable" && (env.reason === "unauthenticated" || env.reason === "not_permitted")) {
    return { kind: "access_unavailable", reason: env.reason };
  }
  if (env.status === "refused") {
    return { kind: "refused", message: typeof env.message === "string" ? env.message : "The server refused this action." };
  }
  if (DONE_STATUSES.has(env.status as string)) return { kind: "done", message: doneMessage };
  return { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." };
}

/** A credential the server just issued, or why it didn't. */
export type CredentialOutcome = { kind: "issued"; deviceId: string; deviceSecret: string } | MutationOutcome;

/**
 * Reads `fleet:provisionDevice` / `fleet:rotateDeviceCredential`. Only a
 * well-formed `issued` answer shows a secret; anything else is a refusal,
 * a denial, or a failure that assumes nothing.
 */
export function credentialOutcome(raw: unknown): CredentialOutcome {
  const env = (raw ?? {}) as { schemaVersion?: unknown; status?: unknown; deviceId?: unknown; deviceSecret?: unknown };
  if (env.schemaVersion === 1 && env.status === "issued") {
    if (typeof env.deviceId === "string" && typeof env.deviceSecret === "string" && env.deviceSecret.length >= 32) {
      return { kind: "issued", deviceId: env.deviceId, deviceSecret: env.deviceSecret };
    }
    return { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." };
  }
  const outcome = mutationOutcome(raw, "");
  return outcome.kind === "done" ? { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." } : outcome;
}
