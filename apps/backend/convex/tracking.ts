import {
  type AccessUnavailable,
  type EndedRun,
  endOfLocalDayMs,
  type Eta,
  localDate,
  POSITION_STALE_AFTER_MS,
  type StopStatus,
  type AccessUnavailableReason,
  type MyAssignmentsResult,
  type MyRouteResult,
  type MyRunResult,
  SCHEMA_VERSION,
  type ServerTimeResult,
  type ServiceNotice,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { healthForRun } from "./health";
import { getTrackableAssignment, getUser, listTrackableAssignments, missingUserReason } from "./lib/authz";
import { getRunProgress } from "./lib/progressStore";
import { familyReportedDelay } from "./runReports";
import { runState } from "./schema";

/**
 * Family-facing tracking queries (docs/08 §8). Each one resolves the caller
 * from the authenticated identity and rechecks the assignment relationship;
 * none of them accept a role, student, route, or run from the client.
 *
 * `serverNowMs` is the query's evaluation time. Clients use it only to
 * estimate clock offset; they age the position locally between updates.
 */

const accessUnavailable = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("access_unavailable"),
  serverNowMs: v.number(),
  reason: v.union(v.literal("unauthenticated"), v.literal("not_permitted")),
});

const gpsStatus = v.union(v.literal("valid"), v.literal("no_fix"), v.literal("receiver_missing"));

function denied(reason: AccessUnavailableReason): AccessUnavailable {
  return { schemaVersion: SCHEMA_VERSION, status: "access_unavailable", serverNowMs: Date.now(), reason };
}

/**
 * Uncached server time (docs/08 §8.1). A mutation, so it is never served
 * from the query cache the way a query's `serverNowMs` can be. It reads and
 * writes nothing, so it needs no sign-in.
 */
export const serverTime = mutation({
  args: {},
  returns: v.object({ schemaVersion: v.literal(SCHEMA_VERSION), serverNowMs: v.number() }),
  handler: async (): Promise<ServerTimeResult> => ({ schemaVersion: SCHEMA_VERSION, serverNowMs: Date.now() }),
});

export const myAssignments = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      assignments: v.array(
        v.object({
          assignmentId: v.string(),
          relationship: v.union(v.literal("self"), v.literal("guardian")),
          studentDisplayName: v.string(),
          routeLabel: v.string(),
          stopLabel: v.string(),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<MyAssignmentsResult> => {
    const user = await getUser(ctx);
    if (!user) return denied(await missingUserReason(ctx));
    const access = await listTrackableAssignments(ctx, user);
    const assignments = [];
    for (const { assignment, student, relationship } of access) {
      const [route, stop] = await Promise.all([
        ctx.db.get(assignment.routeVersionId),
        ctx.db.get(assignment.stopId),
      ]);
      if (!route || !stop) continue;
      assignments.push({
        assignmentId: assignment._id,
        relationship,
        studentDisplayName: student.displayName,
        routeLabel: route.label,
        stopLabel: stop.label,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), assignments };
  },
});

const lastPosition = v.object({
  eventId: v.string(),
  capturedAtMs: v.number(),
  receivedAtMs: v.number(),
  latitude: v.number(),
  longitude: v.number(),
  speedMps: v.union(v.number(), v.null()),
  headingDegrees: v.union(v.number(), v.null()),
  horizontalAccuracyM: v.union(v.number(), v.null()),
});

const assignedStopFields = {
  stopId: v.string(),
  label: v.string(),
  latitude: v.number(),
  longitude: v.number(),
};

const eta = v.object({
  arrivalAtMs: v.number(),
  generatedAtMs: v.number(),
  validUntilMs: v.number(),
  lowerArrivalAtMs: v.union(v.number(), v.null()),
  upperArrivalAtMs: v.union(v.number(), v.null()),
  algorithmVersion: v.string(),
  sourceEventId: v.string(),
});

const serviceNotice = v.union(
  v.object({
    serviceDate: v.string(),
    status: v.union(v.literal("no_service"), v.literal("late_start")),
    lateStartMinutes: v.union(v.number(), v.null()),
    notice: v.string(),
    validUntilMs: v.number(),
  }),
  v.null(),
);

const endedRun = v.union(
  v.object({
    runId: v.string(),
    state: v.union(v.literal("completed"), v.literal("cancelled")),
    serviceDate: v.string(),
    endedAtMs: v.union(v.number(), v.null()),
    replacement: v.union(v.literal("pending"), v.null()),
    validUntilMs: v.number(),
  }),
  v.null(),
);

/** A driver's delay report (docs/08 §9.3): category and minutes only, never text. */
const reportedDelay = v.object({
  category: v.union(
    v.literal("traffic"),
    v.literal("mechanical"),
    v.literal("weather"),
    v.literal("student_incident"),
    v.literal("other"),
  ),
  minutes: v.union(v.number(), v.null()),
  reportedAtMs: v.number(),
  validUntilMs: v.number(),
  source: v.literal("driver"),
});

/** Generic, honest label when the bus device has no family-facing name yet. */
const FALLBACK_BUS_LABEL = "School bus";

export const myRun = query({
  args: { assignmentId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      assignmentId: v.string(),
      routeVersionId: v.string(),
      run: v.object({
        runId: v.string(),
        state: runState,
        liveRevision: v.number(),
        busLabel: v.string(),
        lastDeviceContactAtMs: v.union(v.number(), v.null()),
        gpsStatus: v.union(gpsStatus, v.null()),
        lastPosition: v.union(lastPosition, v.null()),
        nextStopId: v.union(v.string(), v.null()),
        assignedStop: v.object({
          ...assignedStopFields,
          status: v.union(
            v.literal("upcoming"),
            v.literal("at_stop"),
            v.literal("passed"),
            v.literal("unknown"),
          ),
        }),
        eta: v.union(eta, v.null()),
        reportedDelay: v.optional(v.union(reportedDelay, v.null())),
      }),
      serviceNotice,
    }),
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("no_active_run"),
      serverNowMs: v.number(),
      assignmentId: v.string(),
      routeVersionId: v.string(),
      run: v.null(),
      endedRun,
      serviceNotice,
    }),
    accessUnavailable,
  ),
  handler: async (ctx, { assignmentId }): Promise<MyRunResult> => {
    const user = await getUser(ctx);
    if (!user) return denied(await missingUserReason(ctx));
    const access = await getTrackableAssignment(ctx, user, assignmentId);
    if (!access) return denied("not_permitted");
    const { assignment } = access;
    const stop = await ctx.db.get(assignment.stopId);
    if (!stop) return denied("not_permitted");

    const serverNowMs = Date.now();
    const [run, notice] = await Promise.all([activeRunFor(ctx, assignment), todaysServiceNotice(ctx, serverNowMs)]);
    if (!run) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: "no_active_run",
        serverNowMs,
        assignmentId: assignment._id,
        routeVersionId: assignment.routeVersionId,
        run: null,
        endedRun: await todaysEndedRun(ctx, assignment, serverNowMs),
        serviceNotice: notice,
      };
    }

    const [live, device, health, progress, delay] = await Promise.all([
      ctx.db
        .query("liveState")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .unique(),
      ctx.db.get(run.deviceId),
      healthForRun(ctx, run),
      getRunProgress(ctx, run._id),
      familyReportedDelay(ctx, run, serverNowMs),
    ]);
    // Last time the backend heard from this bus during the run: a health
    // heartbeat or an accepted observation, whichever came later.
    const contacts = [live?.receivedAtMs, health?.receivedAtMs].filter((ms): ms is number => ms !== undefined);
    const outcome = progress?.stops.find((s) => s.stopId === stop._id);
    const stopStatus: StopStatus = !outcome
      ? "unknown"
      : outcome.departedAtMs !== null
        ? "passed"
        : outcome.arrivedAtMs !== null
          ? "at_stop"
          : "upcoming";

    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs,
      assignmentId: assignment._id,
      routeVersionId: assignment.routeVersionId,
      run: {
        runId: run._id,
        state: run.state,
        liveRevision: live ? (live.revision ?? 1) : 0,
        busLabel: device?.busLabel ?? FALLBACK_BUS_LABEL,
        lastDeviceContactAtMs: contacts.length > 0 ? Math.max(...contacts) : null,
        // As last reported, with no expiry here: a query is not re-run as
        // time passes, so clients trust it only while lastDeviceContactAtMs
        // is recent (docs/08 §8). GPSD down on the Pi is not a fix status.
        gpsStatus: reportedGpsStatus(health, live),
        lastPosition: live
          ? {
              eventId: live.eventId,
              capturedAtMs: live.capturedAtMs,
              receivedAtMs: live.receivedAtMs,
              latitude: live.latitude,
              longitude: live.longitude,
              speedMps: live.speedMps,
              headingDegrees: live.headingDegrees,
              horizontalAccuracyM: live.horizontalAccuracyM ?? null,
            }
          : null,
        nextStopId: progress?.stops.find((s) => s.departedAtMs === null)?.stopId ?? null,
        assignedStop: {
          stopId: stop._id,
          label: stop.label,
          latitude: stop.latitude,
          longitude: stop.longitude,
          status: stopStatus,
        },
        eta:
          live && progress?.lastEventId === live.eventId && progress.lastStatus === "on_route" && stopStatus === "upcoming"
            ? await currentEta(ctx, run._id, stop._id, live, serverNowMs)
            : null,
        reportedDelay: delay,
      },
      serviceNotice: notice,
    };
  },
});

export const myRoute = query({
  args: { assignmentId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      assignmentId: v.string(),
      routeVersionId: v.string(),
      routeLabel: v.string(),
      path: v.array(v.object({ latitude: v.number(), longitude: v.number() })),
      assignedStop: v.object(assignedStopFields),
    }),
    accessUnavailable,
  ),
  handler: async (ctx, { assignmentId }): Promise<MyRouteResult> => {
    const user = await getUser(ctx);
    if (!user) return denied(await missingUserReason(ctx));
    const access = await getTrackableAssignment(ctx, user, assignmentId);
    if (!access) return denied("not_permitted");
    const { assignment } = access;
    const [route, stop] = await Promise.all([
      ctx.db.get(assignment.routeVersionId),
      ctx.db.get(assignment.stopId),
    ]);
    if (!route || !stop) return denied("not_permitted");
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: Date.now(),
      assignmentId: assignment._id,
      routeVersionId: route._id,
      routeLabel: route.label,
      path: route.path,
      assignedStop: {
        stopId: stop._id,
        label: stop.label,
        latitude: stop.latitude,
        longitude: stop.longitude,
      },
    };
  },
});

/**
 * The bus's last reported GPS status for families. `unknown` (GPSD down, or
 * expired by health.expire) is no status. A no-fix report is superseded by
 * any position captured after it: both times come from the Pi's clock.
 */
function reportedGpsStatus(
  health: Doc<"deviceHealth"> | null,
  live: Doc<"liveState"> | null,
): "valid" | "no_fix" | "receiver_missing" | null {
  if (!health || health.gpsStatus === "unknown") return null;
  if (health.gpsStatus !== "valid" && live && live.capturedAtMs > health.capturedAtMs) return null;
  return health.gpsStatus;
}

/**
 * The stored estimate for this stop, only if it was made from the current
 * live position, its validity has not ended, and that position is not stale.
 * Anything else returns null: an old number is never shown as current.
 */
async function currentEta(
  ctx: QueryCtx,
  runId: Doc<"runs">["_id"],
  stopId: string,
  live: Doc<"liveState">,
  serverNowMs: number,
): Promise<Eta | null> {
  if (serverNowMs - live.capturedAtMs >= POSITION_STALE_AFTER_MS) return null;
  const p = await ctx.db
    .query("etaPredictions")
    .withIndex("by_run_stop_generated", (q) => q.eq("runId", runId).eq("stopId", stopId))
    .order("desc")
    .first();
  if (!p || p.sourceEventId !== live.eventId || serverNowMs >= p.validUntilMs) return null;
  return {
    arrivalAtMs: p.arrivalAtMs,
    generatedAtMs: p.generatedAtMs,
    validUntilMs: p.validUntilMs,
    // Calibrated bounds stay null until evaluation supports them (docs/10 §4).
    lowerArrivalAtMs: null,
    upperArrivalAtMs: null,
    algorithmVersion: p.algorithmVersion,
    sourceEventId: p.sourceEventId,
  };
}

async function activeRunFor(ctx: QueryCtx, assignment: Doc<"assignments">) {
  return await ctx.db
    .query("runs")
    .withIndex("by_route_version_state", (q) =>
      q.eq("routeVersionId", assignment.routeVersionId).eq("state", "active"),
    )
    .first();
}

/**
 * The local date and the end of that day for a stored row, or null when its
 * time zone can't be computed. One bad row is dropped and logged, never
 * allowed to fail `myRun` for every family on it (docs/08 §8).
 */
function serviceDay(
  nowMs: number,
  serviceDate: string | undefined,
  timeZone: string | undefined,
  what: string,
): { today: boolean; validUntilMs: number } | null {
  if (serviceDate === undefined || timeZone === undefined) return null;
  try {
    if (serviceDate !== localDate(nowMs, timeZone)) return { today: false, validUntilMs: 0 };
    return { today: true, validUntilMs: endOfLocalDayMs(serviceDate, timeZone) };
  } catch (error) {
    console.error(`tracking.myRun: dropped ${what} with an unusable time zone`, { serviceDate, timeZone, error });
    return null;
  }
}

const endedAt = (r: Doc<"runs">) => r.cancelledAtMs ?? r.endedAtMs ?? r._creationTime;
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Enough for every run one route version has in a day, newest first. */
const ENDED_RUNS_SCANNED = 20;

/**
 * Today's most recent finished run on the assignment's route version (D14):
 * completed, or cancelled by staff. "Today" is each run's own service date
 * in its own time zone; a run without one (written before trip events
 * existed) is never reported. A query is not re-run as time passes, so the
 * result carries `validUntilMs` and clients hide it once that day ends.
 */
async function todaysEndedRun(
  ctx: QueryCtx,
  assignment: Doc<"assignments">,
  nowMs: number,
): Promise<EndedRun | null> {
  const ended = (
    await Promise.all(
      (["completed", "cancelled"] as const).map((state) =>
        ctx.db
          .query("runs")
          .withIndex("by_route_version_state", (q) =>
            q.eq("routeVersionId", assignment.routeVersionId).eq("state", state),
          )
          .order("desc")
          .take(ENDED_RUNS_SCANNED),
      ),
    )
  )
    .flat()
    .flatMap((run) => {
      const day = serviceDay(nowMs, run.serviceDate, run.serviceTimezone, `run ${run._id}`);
      return day?.today && run.serviceDate !== undefined ? [{ run, serviceDate: run.serviceDate, validUntilMs: day.validUntilMs }] : [];
    });
  const pick = ended.reduce<(typeof ended)[number] | null>((a, r) => (!a || endedAt(r.run) > endedAt(a.run) ? r : a), null);
  if (!pick) return null;
  const latest = pick.run;
  const state = latest.state === "cancelled" ? "cancelled" : "completed";
  return {
    runId: latest._id,
    state,
    serviceDate: pick.serviceDate,
    endedAtMs: latest.cancelledAtMs ?? latest.endedAtMs ?? null,
    // An active replacement is returned as the run itself, never here.
    replacement:
      state === "cancelled" && latest.replacementDeviceId !== undefined && latest.replacedByRunId === undefined
        ? "pending"
        : null,
    validUntilMs: pick.validUntilMs,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Today's service-calendar entry, if any (docs/12 §3). The calendar is
 * district-wide, so every route sees it. Each entry is "today" in its own
 * time zone; local dates are always within a day of the UTC date.
 */
async function todaysServiceNotice(ctx: QueryCtx, nowMs: number): Promise<ServiceNotice | null> {
  const rows = await ctx.db
    .query("serviceDays")
    .withIndex("by_date", (q) => q.gte("serviceDate", utcDate(nowMs - DAY_MS)).lte("serviceDate", utcDate(nowMs + DAY_MS)))
    .take(3);
  for (const today of rows) {
    const day = serviceDay(nowMs, today.serviceDate, today.timezone, `calendar entry ${today.serviceDate}`);
    if (day?.today) return { ...noticeFields(today), validUntilMs: day.validUntilMs };
  }
  return null;
}

function noticeFields(today: Doc<"serviceDays">): Omit<ServiceNotice, "validUntilMs"> {
  return {
    serviceDate: today.serviceDate,
    status: today.status,
    lateStartMinutes: today.status === "late_start" ? (today.lateStartMinutes ?? null) : null,
    notice: today.notice,
  };
}
