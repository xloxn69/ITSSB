import { formatAge } from "./format.js";
import { ageNow, ageOfTimestamp, type Observed, serviceAnswering, type StoragePart } from "./snapshot.js";

/**
 * Turns the device snapshot into independent status indicators (docs/05 §2).
 * GPS, internet, and the school server are separate: a fix never implies
 * internet, and internet never implies an authorized server connection.
 *
 * Levels:
 * - ok:      measured and good, with its age
 * - warn:    working but degraded (aging, waiting to sync)
 * - problem: measured and bad
 * - unknown: not measured, or the measurement is not current
 * - off:     deliberately not set up on this device
 */
export type Level = "ok" | "warn" | "problem" | "unknown" | "off";
export type IndicatorKey = "service" | "gps" | "network" | "cloud" | "queue" | "storage";

export interface Indicator {
  key: IndicatorKey;
  label: string;
  level: Level;
  /** Short value for the status bar ("Fix", "No fix", "Offline"). */
  value: string;
  /** One honest sentence with the relevant age. */
  detail: string;
}

const LABELS: Record<IndicatorKey, string> = {
  service: "Device",
  gps: "GPS",
  network: "Internet",
  cloud: "School server",
  queue: "Waiting to sync",
  storage: "Recording",
};

function make(key: IndicatorKey, level: Level, value: string, detail: string): Indicator {
  return { key, label: LABELS[key], level, value, detail };
}

/** A valid fix older than this reads as aging even if the service still says valid. */
const GPS_AGING_MS = 3_000;

export function serviceIndicator(o: Observed): Indicator {
  if (o.snapshot === null) {
    return o.pollFailed
      ? make("service", "problem", "Not answering", "The device service has not answered since this screen opened.")
      : make("service", "unknown", "Checking", "Waiting for the device service's first answer.");
  }
  if (!serviceAnswering(o)) {
    return make(
      "service",
      "problem",
      "Not answering",
      `The device service last answered ${formatAge(o.elapsedMs)}. Nothing below is current.`,
    );
  }
  return make("service", "ok", "Running", `Device software v${o.snapshot.process.version}.`);
}

export function gpsIndicator(o: Observed): Indicator {
  const s = o.snapshot;
  if (s === null || !serviceAnswering(o)) {
    return make("gps", "unknown", "Unknown", "No current answer from the device service.");
  }
  const g = s.gps;
  const fixAge = ageNow(g.lastValidFixAgeMs, o);
  const lastFix = fixAge === null ? "No fix since the device started." : `Last fix ${formatAge(fixAge)}.`;
  switch (g.status) {
    case "valid":
      if (fixAge !== null && fixAge > GPS_AGING_MS) {
        return make("gps", "warn", "Fix aging", `Last fix ${formatAge(fixAge)}.`);
      }
      return make("gps", "ok", "Fix", `Position fix ${formatAge(fixAge)}${g.lastValidFixMode === 3 ? " (3D)" : ""}.`);
    case "no_fix":
      return make("gps", "problem", "No fix", `Receiver connected but has no usable fix. ${lastFix}`);
    case "receiver_missing":
      return make("gps", "problem", "No receiver", "The GPS receiver is not detected. Check the USB cable.");
    default:
      return g.gpsd === "connecting"
        ? make("gps", "unknown", "Connecting", "Connecting to the GPS service.")
        : make("gps", "problem", "GPS service down", "The GPS service on this device is not reachable.");
  }
}

export function networkIndicator(o: Observed): Indicator {
  const s = o.snapshot;
  if (s === null || !serviceAnswering(o)) {
    return make("network", "unknown", "Unknown", "No current answer from the device service.");
  }
  const n = s.network;
  if (s.backend.status === "unconfigured" && n.status === "unknown") {
    return make("network", "off", "Not checked", "Internet is only checked once the school server is set up.");
  }
  const lastOnline = ageOfTimestamp(n.lastOnlineAtMs, o);
  switch (n.status) {
    case "online":
      return make("network", "ok", "Online", `Reached the internet ${formatAge(ageOfTimestamp(n.lastCheckedAtMs, o))}.`);
    case "offline":
      return make(
        "network",
        "problem",
        "Offline",
        lastOnline === null ? "No internet since the device started." : `No internet. Last online ${formatAge(lastOnline)}.`,
      );
    default:
      return make("network", "unknown", "Not checked yet", "The device has not tested the internet yet.");
  }
}

const CLOUD_PROBLEMS: Record<string, string> = {
  credential_rejected: "The school server rejected this device's credential.",
  forbidden: "The school server refused this device for this run.",
  unreachable: "The school server could not be reached.",
  no_response: "The school server did not answer.",
  tls_error: "The secure connection to the school server failed.",
  bad_response: "The school server sent an unreadable answer.",
  rate_limited: "The school server asked the device to slow down.",
  request_rejected: "The school server rejected the upload request.",
  error: "The school server reported an error.",
};

export function cloudIndicator(o: Observed): Indicator {
  const s = o.snapshot;
  if (s === null || !serviceAnswering(o)) {
    return make("cloud", "unknown", "Unknown", "No current answer from the device service.");
  }
  const b = s.backend;
  const lastOk = ageOfTimestamp(b.lastOkAtMs, o);
  const since = lastOk === null ? " No successful contact since the device started." : ` Last accepted ${formatAge(lastOk)}.`;
  if (b.status === "unconfigured") {
    return make("cloud", "off", "Not set up", "This device has no school server address or credential yet.");
  }
  if (b.status === "ok" || b.status === "ok_split") {
    return make("cloud", "ok", "Connected", `Last accepted ${formatAge(lastOk)}.`);
  }
  if (b.status === "unknown") {
    return make("cloud", "unknown", "No uploads yet", "No positions have been uploaded since the device started.");
  }
  const level: Level = b.status === "rate_limited" ? "warn" : "problem";
  const short = b.status === "credential_rejected" || b.status === "forbidden" ? "Not authorized" : "Not reachable";
  return make("cloud", level, short, (CLOUD_PROBLEMS[b.status] ?? "The school server connection failed.") + since);
}

export function queueIndicator(o: Observed): Indicator {
  const s = o.snapshot;
  if (s === null || !serviceAnswering(o)) {
    return make("queue", "unknown", "Unknown", "No current answer from the device service.");
  }
  const pending = s.outbox.pending;
  if (pending === null) return make("queue", "unknown", "Unknown", "The saved-record count is not available yet.");
  if (pending === 0) return make("queue", "ok", "0", "Nothing on this device is waiting to sync.");
  const oldest = ageOfTimestamp(s.outbox.oldestPendingCapturedAtMs, o);
  return make(
    "queue",
    "warn",
    String(pending),
    `${pending} saved on this device, waiting to sync${oldest === null ? "" : `; oldest ${formatAge(oldest)}`}.`,
  );
}

/** "95 MB", "1.2 GB": decimal units, matching the device's MB settings. */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.floor(mb)} MB`;
}

/** Why storage is low, with the measured number and the limit it crossed. */
function storageReasons(st: StoragePart): string[] {
  const out: string[] = [];
  const d = st.disk;
  if ((d.level === "warning" || d.level === "critical") && d.freeBytes !== null) {
    const limit = d.level === "critical" ? d.criticalFreeBytes : d.warnFreeBytes;
    const state = d.level === "critical" ? "nearly full" : "getting full";
    out.push(`Storage ${state}: ${formatBytes(d.freeBytes)} free (limit ${formatBytes(limit)})`);
  }
  const q = st.queue;
  if ((q.level === "warning" || q.level === "critical") && q.pending !== null) {
    const limit = q.level === "critical" ? q.criticalPending : q.warnPending;
    out.push(`${q.pending} positions waiting to sync (limit ${limit})`);
  }
  return out;
}

export function storageIndicator(o: Observed): Indicator {
  const s = o.snapshot;
  if (s === null || !serviceAnswering(o)) {
    return make("storage", "unknown", "Unknown", "No current answer from the device service.");
  }
  const fault = s.recorder?.fault;
  if (fault) {
    return make("storage", "problem", "Not saving", `Positions are not being saved on this device (${fault}).`);
  }
  const st = s.storage;
  if (st && (st.level === "critical" || st.level === "warning")) {
    const why = storageReasons(st).join(". ");
    if (st.recording === "reduced") {
      return make(
        "storage",
        "problem",
        "Saving less",
        `${why}. Saving one position every ${st.reducedIntervalS} s until this clears; nothing waiting to sync is deleted.`,
      );
    }
    return make("storage", "warn", st.disk.level === "warning" || st.disk.level === "critical" ? "Space low" : "Queue long", `${why}. Positions still save normally.`);
  }
  if (s.run?.state !== "active") {
    return make("storage", "off", "No run", "Positions save on this device only during an active run.");
  }
  return make("storage", "ok", "Saving", "The active run's positions are saving on this device.");
}

export function allIndicators(o: Observed): Indicator[] {
  return [
    serviceIndicator(o),
    gpsIndicator(o),
    networkIndicator(o),
    cloudIndicator(o),
    queueIndicator(o),
    storageIndicator(o),
  ];
}

/**
 * A visible label for a non-production device (docs/14 §2), so a bench or
 * test Pi is never mistaken for a live bus. Null in production, when the
 * device didn't say (older software), and when it isn't answering now:
 * nothing is guessed.
 */
export function environmentLabel(o: Observed): string | null {
  // A cached answer from a device that stopped answering says nothing now.
  if (!serviceAnswering(o)) return null;
  const env = o.snapshot?.process.environment;
  if (env === "development") return "Development device";
  if (env === "staging") return "Staging device";
  return null;
}
