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
  | "D04" // driver unlock
  | "D05" // driver dashboard
  | "D06" // route library (drafts on this device)
  | "D07" // record a new route
  | "D08" // recording a route
  | "D09" // add or edit a stop
  | "D10" // review recorded route
  | "D12" // start-trip preflight
  | "D13" // driving view (read-only)
  | "D15" // route enrollment QR ("Join this route")
  | "D16" // trip check-in QR ("Check in for this trip")
  | "D17" // student roster
  | "D18" // student detail, seat and note, remove from route
  | "D19" // attendance correction
  | "D21" // GPS and device diagnostics
  | "D22" // offline bus operation
  | "D23" // end-trip confirmation
  | "D24"; // trip summary

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
const MOVING_ALLOWED: ReadonlySet<ScreenId> = new Set(["D08", "D13", "D22"]);
/** Screens that need an unlocked driver. */
/** QR codes and the roster: an unlocked driver, parked, during the active run. */
export const STUDENT_SCREENS: ReadonlySet<ScreenId> = new Set(["D15", "D16", "D17", "D18", "D19"]);
const NEEDS_DRIVER: ReadonlySet<ScreenId> = new Set(["D06", "D07", "D08", "D09", "D10", "D12", "D23", "D24", ...STUDENT_SCREENS]);
/** Screens that change a draft: parked only. D08 itself is fine while moving (read-only). */
const NEEDS_PARKED: ReadonlySet<ScreenId> = new Set(["D07", "D09", "D12", "D23", ...STUDENT_SCREENS]);

export function runActive(o: Observed): boolean {
  return o.snapshot?.run?.state === "active";
}

/** Parked only when the service says so. Missing motion data is never parked. */
export function parked(o: Observed): boolean {
  return serviceAnswering(o) && o.snapshot?.motion?.parked === true;
}

export function recordingActive(o: Observed): boolean {
  return o.snapshot?.recording?.status === "recording";
}

export function driverUnlocked(o: Observed): boolean {
  return o.snapshot?.session?.unlocked === true;
}

export function selectScreen(o: Observed, requested: ScreenId | null): ScreenId {
  if (!serviceAnswering(o)) return "D01";
  if (runActive(o) && !parked(o)) {
    return requested !== null && MOVING_ALLOWED.has(requested) && requested !== "D08" ? requested : "D13";
  }
  if (recordingActive(o) && !parked(o)) {
    // Recording keeps sampling while driving; the view is read-only.
    return requested === "D22" ? "D22" : "D08";
  }
  if (requested === null || requested === "D01" || requested === "D13") return "D05";
  if (NEEDS_DRIVER.has(requested) && !driverUnlocked(o)) return "D04";
  if (NEEDS_PARKED.has(requested) && !parked(o)) return recordingActive(o) ? "D08" : "D05";
  if (STUDENT_SCREENS.has(requested) && !runActive(o)) return "D05";
  if (requested === "D07" && recordingActive(o)) return "D08";
  if (requested === "D12" && runActive(o)) return "D05";
  if (requested === "D23" && !runActive(o)) return o.snapshot?.lastEndedRun ? "D24" : "D05";
  return requested;
}

/** Why a draft-changing control is unavailable right now, or null if it can be used. */
export function editBlocked(o: Observed): string | null {
  if (!serviceAnswering(o)) return "The device service is not answering.";
  if (!driverUnlocked(o)) return "Unlock with your driver PIN first.";
  if (!parked(o)) return "Stop safely and confirm the bus is parked.";
  return null;
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
  // A recording in progress can be reopened without parking: its view is read-only while moving.
  if (id === "recordRoute" && recordingActive(o)) return { enabled: true, reason: null };
  if (!parked(o)) return { enabled: false, reason: "Stop safely and confirm the bus is parked." };
  return { enabled: true, reason: null };
}
