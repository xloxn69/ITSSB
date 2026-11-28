import type { DeviceSnapshot, DraftDetail, DraftStop, DraftSummary } from "./snapshot.js";
import type { RunReport, StopResponse } from "./stopViews.js";
import type { DeviceQrCode, QrPurpose, RosterAction, RosterResponse } from "./students.js";

/**
 * Local API client. Same origin as the page (the device serves both), so no
 * CORS and no remote host. The browser never sees the device's cloud token.
 *
 * Commands carry the session's CSRF token (only same-origin script can read
 * it) and, for anything that creates a record, a `requestId` that stays the
 * same across retries of one logical action (see RequestIds).
 */

const TIMEOUT_MS = 4_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, { cache: "no-store", credentials: "same-origin", signal: ctrl.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeSnapshot(v: unknown): v is DeviceSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["generatedAtMs"] === "number" &&
    typeof s["gps"] === "object" &&
    typeof s["network"] === "object" &&
    typeof s["backend"] === "object" &&
    typeof s["outbox"] === "object" &&
    "run" in s
  );
}

export interface SessionInfo {
  csrfToken: string;
  driver: { driverId: string; displayName: string } | null;
  drivers: { driverId: string; displayName: string }[];
  /** Route versions the unlocked driver may start (empty when locked). */
  routes?: { routeVersionId: string; label: string }[];
  lockoutRemainingS: number;
}

let session: SessionInfo | null = null;

export async function fetchSession(): Promise<SessionInfo> {
  const res = await call("/api/session");
  if (!res.ok) throw new ApiError(res.status, "SESSION", `device service answered HTTP ${res.status}`);
  session = (await res.json()) as SessionInfo;
  return session;
}

export function currentSession(): SessionInfo | null {
  return session;
}

/**
 * The operating snapshot. Prefers `/api/status` (adds driver session, motion,
 * capabilities, and the recording) and falls back to `/health` on device
 * software that only has the health endpoint. A 401 means the kiosk session
 * is gone (service restarted): get a new one and ask again.
 */
export async function fetchSnapshot(): Promise<DeviceSnapshot> {
  let res = await call("/api/status");
  if (res.status === 401) {
    await fetchSession();
    res = await call("/api/status");
  }
  if (res.status === 404) res = await call("/health");
  if (!res.ok) throw new Error(`device service answered HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!looksLikeSnapshot(body)) throw new Error("device service sent an unexpected answer");
  return body;
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const send = async () =>
    call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ITSSB-CSRF": session?.csrfToken ?? "" },
      body: JSON.stringify(body),
    });
  if (session === null) await fetchSession();
  let res = await send();
  if (res.status === 401) {
    await fetchSession();
    res = await send();
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data["error"] ?? "ERROR"),
      String(data["message"] ?? `The device refused (HTTP ${res.status}).`),
      data,
    );
  }
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await call(path);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(data["error"] ?? "ERROR"), String(data["message"] ?? "Failed."), data);
  return data as T;
}

export const api = {
  unlock: (driverId: string, pin: string) => post("/api/session/unlock", { driverId, pin }),
  lock: () => post("/api/session/lock"),
  confirmParked: () => post("/api/motion/parked"),
  drafts: () => get<{ drafts: DraftSummary[] }>("/api/recordings"),
  draft: (id: string) => get<DraftDetail>(`/api/recordings/${id}`),
  startRecording: (requestId: string, name: string, direction: string) =>
    post<DraftSummary>("/api/recordings", { requestId, name, direction }),
  markStop: (draftId: string, requestId: string) =>
    post<DraftStop>(`/api/recordings/${draftId}/stops`, { requestId }),
  renameStop: (draftId: string, stopId: string, name: string) =>
    post<{ stops: DraftStop[] }>(`/api/recordings/${draftId}/stops/${stopId}`, { name }),
  moveStop: (draftId: string, stopId: string, position: number) =>
    post<{ stops: DraftStop[] }>(`/api/recordings/${draftId}/stops/${stopId}`, { position }),
  removeStop: (draftId: string, stopId: string) =>
    post<{ stops: DraftStop[] }>(`/api/recordings/${draftId}/stops/${stopId}`, { remove: true }),
  finish: (draftId: string) => post<DraftSummary>(`/api/recordings/${draftId}/finish`),
  submitDraft: (draftId: string, requestId: string) =>
    post<DraftSummary>(`/api/recordings/${draftId}/submit`, { requestId }),
  reviewStatus: () =>
    post<{ checked: boolean; problem: string | null; drafts: DraftSummary[] }>("/api/recordings/review-status"),
  startRun: (requestId: string, routeVersionId: string) =>
    post<{ status: "accepted" | "unknown"; runId?: string; message?: string }>("/api/runs/start", {
      requestId,
      routeVersionId,
    }),
  qrCode: (purpose: QrPurpose) => post<DeviceQrCode>("/api/qr-codes", { purpose }),
  roster: () => get<RosterResponse>("/api/roster"),
  stop: () => get<StopResponse>("/api/stop"),
  report: (requestId: string, category: string, minutes: number | null) =>
    post<{ report: RunReport }>("/api/run-reports", { requestId, category, minutes }),
  rosterAction: (body: Record<string, unknown>) => post<{ action: RosterAction }>("/api/roster-actions", body),
  endRun: (runId: string, requestId: string) =>
    post<{ completedLocally: boolean; endSync: string; message?: string }>(`/api/runs/${runId}/end`, { requestId }),
};

/**
 * One requestId per logical action. A retry after a timeout or a double tap
 * reuses it, so the device returns the same record instead of a second one.
 * The id is dropped only once the device has answered, success or refusal.
 */
export class RequestIds {
  private pending = new Map<string, string>();

  constructor(private readonly make: () => string = () => crypto.randomUUID()) {}

  for(action: string): string {
    let id = this.pending.get(action);
    if (id === undefined) {
      id = this.make();
      this.pending.set(action, id);
    }
    return id;
  }

  /** The device answered (accepted or refused): the next tap is a new action. */
  answered(action: string): void {
    this.pending.delete(action);
  }
}

/** Whether an error means "no answer" (keep the requestId) rather than a refusal. */
export function noAnswer(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500;
}
