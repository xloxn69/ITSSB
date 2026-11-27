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
  | "fleet:listDrivers";

export type StaffMutationName = "routes:approveDraft" | "routes:rejectDraft" | "fleet:setBusLabel" | "fleet:revokeDevice";

export interface StaffSource {
  watch(
    name: StaffQueryName,
    args: Record<string, string>,
    onValue: (raw: unknown) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;
  mutate(name: StaffMutationName, args: Record<string, string>): Promise<unknown>;
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

export function mutationOutcome(raw: unknown, doneMessage: string): MutationOutcome {
  const env = (raw ?? {}) as { schemaVersion?: unknown; status?: unknown; message?: unknown; reason?: unknown };
  if (env.schemaVersion !== 1) return { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." };
  if (env.status === "access_unavailable" && (env.reason === "unauthenticated" || env.reason === "not_permitted")) {
    return { kind: "access_unavailable", reason: env.reason };
  }
  if (env.status === "refused") {
    return { kind: "refused", message: typeof env.message === "string" ? env.message : "The server refused this action." };
  }
  if (env.status === "ok" || env.status === "approved" || env.status === "rejected") return { kind: "done", message: doneMessage };
  return { kind: "failed", message: "The server's answer couldn't be read. Nothing is assumed." };
}
