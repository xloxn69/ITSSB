import {
  type AccessUnavailable,
  type AccessUnavailableReason,
  type MyAssignmentsResult,
  type MyRouteResult,
  type MyRunResult,
  SCHEMA_VERSION,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { getTrackableAssignment, getUser, listTrackableAssignments } from "./lib/authz";
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
    if (!user) return denied("unauthenticated");
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
      }),
    }),
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("no_active_run"),
      serverNowMs: v.number(),
      assignmentId: v.string(),
      routeVersionId: v.string(),
      run: v.null(),
    }),
    accessUnavailable,
  ),
  handler: async (ctx, { assignmentId }): Promise<MyRunResult> => {
    const user = await getUser(ctx);
    if (!user) return denied("unauthenticated");
    const access = await getTrackableAssignment(ctx, user, assignmentId);
    if (!access) return denied("not_permitted");
    const { assignment } = access;
    const stop = await ctx.db.get(assignment.stopId);
    if (!stop) return denied("not_permitted");

    const serverNowMs = Date.now();
    const run = await activeRunFor(ctx, assignment);
    if (!run) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: "no_active_run",
        serverNowMs,
        assignmentId: assignment._id,
        routeVersionId: assignment.routeVersionId,
        run: null,
      };
    }

    const [live, device] = await Promise.all([
      ctx.db
        .query("liveState")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .unique(),
      ctx.db.get(run.deviceId),
    ]);

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
        // Telemetry is the only device contact recorded so far; health
        // reporting (docs/08 §7) will refine this and supply gpsStatus.
        lastDeviceContactAtMs: live?.receivedAtMs ?? null,
        gpsStatus: null,
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
        // Route progress and ETA are later milestones; never guess them.
        nextStopId: null,
        assignedStop: {
          stopId: stop._id,
          label: stop.label,
          latitude: stop.latitude,
          longitude: stop.longitude,
          status: "unknown",
        },
        eta: null,
      },
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
    if (!user) return denied("unauthenticated");
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

async function activeRunFor(ctx: QueryCtx, assignment: Doc<"assignments">) {
  return await ctx.db
    .query("runs")
    .withIndex("by_route_version_state", (q) =>
      q.eq("routeVersionId", assignment.routeVersionId).eq("state", "active"),
    )
    .first();
}
