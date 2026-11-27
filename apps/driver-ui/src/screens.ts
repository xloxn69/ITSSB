import type { CapabilitiesPart, Observed } from "./snapshot.js";
import { serviceAnswering } from "./snapshot.js";

/**
 * Which screen to show, from authoritative device state (docs/05 §3-4).
 * The driver can ask for a screen; the device state decides whether they
 * get it. A hidden button is not access control: the device service
 * enforces the same rules on every request.
 */
export type ScreenId =
  | "D01" // startup and self-check
  | "D05" // driver dashboard
  | "D13" // driving view (read-only)
  | "D21" // GPS and device diagnostics
  | "D22"; // offline bus operation

/** The four original dashboard actions, in their original order and wording. */
export const ACTIONS = [
  { id: "showQr", label: "Show QR Code" },
  { id: "recordRoute", label: "Record Route" },
  { id: "startRoute", label: "Start Route" },
  { id: "showStudents", label: "Show Students" },
] as const;

export type ActionId = (typeof ACTIONS)[number]["id"];

export interface Availability {
  enabled: boolean;
  /** Why it is unavailable, in words a driver can act on. */
  reason: string | null;
}

/** Screens that stay reachable while the bus may be moving: short and read-only. */
const MOVING_ALLOWED: ReadonlySet<ScreenId> = new Set(["D13", "D22"]);

export function runActive(o: Observed): boolean {
  return o.snapshot?.run?.state === "active";
}

/** Parked only when the service says so. Missing motion data is never parked. */
export function parked(o: Observed): boolean {
  return serviceAnswering(o) && o.snapshot?.motion?.parked === true;
}

export function selectScreen(o: Observed, requested: ScreenId | null): ScreenId {
  if (!serviceAnswering(o)) return "D01";
  if (runActive(o) && !parked(o)) {
    return requested !== null && MOVING_ALLOWED.has(requested) ? requested : "D13";
  }
  if (requested === null || requested === "D01" || requested === "D13") return "D05";
  return requested;
}

const UNSUPPORTED = "This device software does not support it yet.";

function capability(caps: CapabilitiesPart | undefined, id: ActionId): Availability {
  const c = caps?.[id];
  if (c?.available === true) return { enabled: true, reason: null };
  return { enabled: false, reason: c?.reason ?? UNSUPPORTED };
}

/**
 * Whether one dashboard action can be used now. Checks run in the order a
 * driver can fix them: device state, what the system supports, the run,
 * the driver's unlock, and finally the safe stop.
 */
export function actionAvailability(o: Observed, id: ActionId): Availability {
  if (!serviceAnswering(o) || o.snapshot === null) {
    return { enabled: false, reason: "The device service is not answering." };
  }
  const s = o.snapshot;
  const cap = capability(s.capabilities, id);
  if (!cap.enabled) return cap;
  const active = runActive(o);
  if (id === "startRoute" && active) return { enabled: false, reason: "A run is already active." };
  if (id === "recordRoute" && active) return { enabled: false, reason: "End the active run before recording a route." };
  if (s.session?.unlocked !== true) return { enabled: false, reason: "Unlock with your driver PIN first." };
  if (!parked(o)) return { enabled: false, reason: "Stop safely and confirm the bus is parked." };
  return { enabled: true, reason: null };
}
