/**
 * The device service's local snapshot (`GET /health`, docs/04 §12; the
 * field table is in apps/device/README.md). This is a local API between the
 * Pi service and its own screen, not a cloud contract, so it lives here and
 * not in @itssb/contracts.
 *
 * Every field the screen reads is optional or nullable on purpose: an older
 * or newer device service may omit it, and a missing field must render as
 * "unknown", never as a healthy default.
 */

export type GpsStatus = "valid" | "no_fix" | "receiver_missing" | "unknown";
export type NetworkStatus = "unknown" | "online" | "offline";
export type RunState = "scheduled" | "active" | "completed" | "cancelled";

export interface GpsPart {
  status: GpsStatus;
  gpsd: "connecting" | "connected" | "unreachable";
  gpsdError?: string | null;
  receivers?: number | null;
  lastReportAgeMs?: number | null;
  lastValidFixCapturedAtMs?: number | null;
  lastValidFixAgeMs?: number | null;
  lastValidFixMode?: number | null;
  lastRejectReason?: string | null;
}

export interface LinkPart {
  status: string;
  detail?: string | null;
  lastCheckedAtMs?: number | null;
}

export interface NetworkPart extends LinkPart {
  status: NetworkStatus;
  lastOnlineAtMs?: number | null;
}

export interface BackendPart extends LinkPart {
  httpStatus?: number | null;
  lastOkAtMs?: number | null;
}

export interface OutboxPart {
  pending: number | null;
  acknowledged?: number | null;
  rejected?: number | null;
  oldestPendingCapturedAtMs?: number | null;
}

export interface RunPart {
  runId: string;
  state: RunState;
  nextRunSequence?: number;
}

export interface RecorderPart {
  lastRecordedAtMs?: number | null;
  observationsThisBoot?: number;
  fault?: string | null;
  faultSinceMs?: number | null;
}

/**
 * Motion as the service judges it. `parked` is true only when the driver
 * confirmed a safe stop AND a current fix does not contradict it (docs/05 §3).
 * GPS speed alone never sets it, and unknown motion keeps it false.
 */
export interface MotionPart {
  state: "moving" | "stopped" | "unknown";
  parked: boolean;
  parkedSinceMs?: number | null;
}

export interface SessionPart {
  unlocked: boolean;
  driverName?: string | null;
}

/** What this device software and its server connection can do today. */
export interface Capability {
  available: boolean;
  reason?: string | null;
}

export interface CapabilitiesPart {
  recordRoute?: Capability;
  startRoute?: Capability;
  showQr?: Capability;
  showStudents?: Capability;
}

/** The route draft being recorded (device-side only until the server accepts drafts). */
export interface DraftSummary {
  draftId: string;
  name: string;
  direction: "to_school" | "from_school";
  status: "recording" | "finished";
  submission: "not_submitted";
  startedAtMs: number;
  finishedAtMs: number | null;
  pointCount: number;
  gapCount: number;
  lastPointCapturedAtMs: number | null;
  stopCount: number;
}

export interface DraftStop {
  stopId: string;
  position: number;
  name: string;
  latitude: number;
  longitude: number;
  capturedAtMs: number;
}

export interface PathPoint {
  capturedAtMs: number;
  latitude: number;
  longitude: number;
  gapBefore: boolean;
}

export interface DraftDetail extends DraftSummary {
  stops: DraftStop[];
  path: PathPoint[];
}

export interface DeviceSnapshot {
  schemaVersion: number;
  generatedAtMs: number;
  process: { version: string; bootId: string; startedAtMs?: number; uptimeS: number };
  gps: GpsPart;
  network: NetworkPart;
  backend: BackendPart;
  outbox: OutboxPart;
  run: RunPart | null;
  recorder?: RecorderPart;
  /** Absent on device software that does not report motion: treated as unknown. */
  motion?: MotionPart;
  /** Absent on device software without driver unlock: treated as locked. */
  session?: SessionPart;
  /** Absent: every action is unavailable. */
  capabilities?: CapabilitiesPart;
  /** The draft being recorded, shown only to an unlocked driver. */
  recording?: DraftSummary | null;
  /** An online start still waiting for the server's answer, and the last outcome. */
  runStart?: { pending: boolean; routeVersionId: string | null; lastStatus: string | null; lastCode: string | null };
  /** The most recently ended run and whether the server has its end. */
  lastEndedRun?: EndedRun | null;
}

export interface EndedRun {
  runId: string;
  endedAtMs: number;
  endSync: "pending" | "accepted" | "rejected";
  endError: string | null;
  endAttempts: number;
  positionsRecorded: number;
  positionsWaiting: number;
}

/**
 * What the screen knows right now: the last snapshot it received, when it
 * received it (this page's monotonic clock), and whether the latest poll
 * failed. `elapsedMs` is how long ago the snapshot arrived, so every age
 * keeps counting up between polls instead of freezing.
 */
export interface Observed {
  snapshot: DeviceSnapshot | null;
  /** Milliseconds since `snapshot` arrived; null before the first one. */
  elapsedMs: number | null;
  /** The latest poll failed (service down, timeout, bad response). */
  pollFailed: boolean;
}

/** No answer for this long means the service is not answering, whatever the last snapshot said. */
export const SERVICE_SILENT_MS = 6_000;

export function serviceAnswering(o: Observed): boolean {
  return o.snapshot !== null && !o.pollFailed && (o.elapsedMs ?? 0) <= SERVICE_SILENT_MS;
}

/** A snapshot age advanced by the time since the snapshot arrived. */
export function ageNow(ageMs: number | null | undefined, o: Observed): number | null {
  if (ageMs === null || ageMs === undefined) return null;
  return ageMs + (o.elapsedMs ?? 0);
}

/** Age of a device-clock timestamp, measured against the snapshot's own clock. */
export function ageOfTimestamp(atMs: number | null | undefined, o: Observed): number | null {
  if (atMs === null || atMs === undefined || o.snapshot === null) return null;
  return Math.max(0, o.snapshot.generatedAtMs - atMs) + (o.elapsedMs ?? 0);
}
