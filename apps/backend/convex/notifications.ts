import {
  type AccessUnavailable,
  type AccessUnavailableReason,
  APPROACHING_MINUTES_DEFAULT,
  APPROACHING_MINUTES_MAX,
  APPROACHING_MINUTES_MIN,
  type MyAlertsResult,
  type MyPreferenceResult,
  type NotificationPreference,
  type RegisterDeviceResult,
  SCHEMA_VERSION,
  type SetPreferencesResult,
} from "@itssb/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import { getTrackableAssignment, getUser } from "./lib/authz";

/**
 * Family notification functions (docs/08 §9). The account is always the
 * authenticated caller; an assignment is usable only through the same
 * relationship check as tracking. Preferences are per person and
 * assignment, separate from the phone's notification permission.
 */

const accessUnavailable = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("access_unavailable"),
  serverNowMs: v.number(),
  reason: v.union(v.literal("unauthenticated"), v.literal("not_permitted")),
});

const invalid = v.object({
  schemaVersion: v.literal(SCHEMA_VERSION),
  status: v.literal("invalid"),
  serverNowMs: v.number(),
  message: v.string(),
});

const preference = v.object({
  assignmentId: v.string(),
  approachingEnabled: v.boolean(),
  approachingMinutes: v.number(),
  updatedAtMs: v.union(v.number(), v.null()),
});

function denied(reason: AccessUnavailableReason): AccessUnavailable {
  return { schemaVersion: SCHEMA_VERSION, status: "access_unavailable", serverNowMs: Date.now(), reason };
}

/** How many recent save requests are remembered for retry detection. */
const RECENT_REQUEST_IDS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APNS_TOKEN = /^[0-9a-f]{64,200}$/;

function present(assignmentId: string, row: Doc<"notificationPreferences"> | null): NotificationPreference {
  return {
    assignmentId,
    approachingEnabled: row?.approachingEnabled ?? false,
    approachingMinutes: row?.approachingMinutes ?? APPROACHING_MINUTES_DEFAULT,
    updatedAtMs: row?.updatedAtMs ?? null,
  };
}

async function preferenceRow(ctx: QueryCtx, user: Doc<"users">, assignment: Doc<"assignments">) {
  return await ctx.db
    .query("notificationPreferences")
    .withIndex("by_user_assignment", (q) => q.eq("userId", user._id).eq("assignmentId", assignment._id))
    .unique();
}

export const myPreference = query({
  args: { assignmentId: v.string() },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      preference,
    }),
    accessUnavailable,
  ),
  handler: async (ctx, { assignmentId }): Promise<MyPreferenceResult> => {
    const user = await getUser(ctx);
    if (!user) return denied("unauthenticated");
    const access = await getTrackableAssignment(ctx, user, assignmentId);
    if (!access) return denied("not_permitted");
    const row = await preferenceRow(ctx, user, access.assignment);
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "ready",
      serverNowMs: Date.now(),
      preference: present(access.assignment._id, row),
    };
  },
});

export const setPreferences = mutation({
  args: {
    requestId: v.string(),
    assignmentId: v.string(),
    approachingEnabled: v.boolean(),
    approachingMinutes: v.number(),
  },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("saved"),
      serverNowMs: v.number(),
      preference,
    }),
    invalid,
    accessUnavailable,
  ),
  handler: async (ctx, args): Promise<SetPreferencesResult> => {
    const user = await getUser(ctx);
    if (!user) return denied("unauthenticated");
    const access = await getTrackableAssignment(ctx, user, args.assignmentId);
    if (!access) return denied("not_permitted");
    const nowMs = Date.now();
    const bad = (message: string): SetPreferencesResult => ({
      schemaVersion: SCHEMA_VERSION,
      status: "invalid",
      serverNowMs: nowMs,
      message,
    });
    if (!UUID.test(args.requestId)) return bad("requestId must be a UUID.");
    if (
      !Number.isInteger(args.approachingMinutes) ||
      args.approachingMinutes < APPROACHING_MINUTES_MIN ||
      args.approachingMinutes > APPROACHING_MINUTES_MAX
    ) {
      return bad(`approachingMinutes must be a whole number from ${APPROACHING_MINUTES_MIN} to ${APPROACHING_MINUTES_MAX}.`);
    }
    const row = await preferenceRow(ctx, user, access.assignment);
    // A retry of any recent save returns the current row unchanged, so a
    // delayed retry of an older choice never overrides a newer one.
    if (row && (row.lastRequestId === args.requestId || (row.recentRequestIds ?? []).includes(args.requestId))) {
      return { schemaVersion: SCHEMA_VERSION, status: "saved", serverNowMs: nowMs, preference: present(access.assignment._id, row) };
    }
    const fields = {
      userId: user._id,
      assignmentId: access.assignment._id,
      approachingEnabled: args.approachingEnabled,
      approachingMinutes: args.approachingMinutes,
      updatedAtMs: nowMs,
      lastRequestId: args.requestId,
      recentRequestIds: [args.requestId, ...(row?.recentRequestIds ?? (row ? [row.lastRequestId] : []))].slice(
        0,
        RECENT_REQUEST_IDS,
      ),
    };
    if (row) await ctx.db.replace(row._id, fields);
    else await ctx.db.insert("notificationPreferences", fields);
    const saved = await preferenceRow(ctx, user, access.assignment);
    return { schemaVersion: SCHEMA_VERSION, status: "saved", serverNowMs: nowMs, preference: present(access.assignment._id, saved) };
  },
});

export const registerDevice = mutation({
  args: {
    installationId: v.string(),
    apnsToken: v.union(v.string(), v.null()),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    permission: v.union(
      v.literal("authorized"),
      v.literal("provisional"),
      v.literal("denied"),
      v.literal("not_determined"),
    ),
  },
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("registered"),
      serverNowMs: v.number(),
      pushEnabled: v.boolean(),
    }),
    invalid,
    accessUnavailable,
  ),
  handler: async (ctx, args): Promise<RegisterDeviceResult> => {
    const user = await getUser(ctx);
    if (!user) return denied("unauthenticated");
    const nowMs = Date.now();
    const bad = (message: string): RegisterDeviceResult => ({
      schemaVersion: SCHEMA_VERSION,
      status: "invalid",
      serverNowMs: nowMs,
      message,
    });
    if (!UUID.test(args.installationId)) return bad("installationId must be a UUID.");
    const token = args.apnsToken?.toLowerCase() ?? null;
    if (token !== null && !APNS_TOKEN.test(token)) return bad("apnsToken must be hex.");

    // A token belongs to the phone (installation) that holds it. Another
    // installation presenting an active token is refused, never allowed to
    // take it over. Account switching on the same phone is handled below.
    if (token) {
      const holders = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .collect();
      if (holders.some((h) => h.active && h.installationId !== args.installationId)) {
        return bad("This notification token is registered to another installation.");
      }
    }
    // One installation, one current row: a phone that signs in as someone
    // else stops receiving the previous account's alerts.
    const rows = await ctx.db
      .query("pushTokens")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
      .collect();
    for (const r of rows) {
      if (r.active && r.userId !== user._id) await ctx.db.patch(r._id, { active: false, updatedAtMs: nowMs });
    }
    const pushEnabled = token !== null && (args.permission === "authorized" || args.permission === "provisional");
    const mine = rows.find((r) => r.userId === user._id);
    const fields = {
      userId: user._id,
      installationId: args.installationId,
      token,
      environment: args.environment,
      permission: args.permission,
      active: pushEnabled,
      updatedAtMs: nowMs,
    };
    if (mine) await ctx.db.replace(mine._id, fields);
    else await ctx.db.insert("pushTokens", fields);
    return { schemaVersion: SCHEMA_VERSION, status: "registered", serverNowMs: nowMs, pushEnabled };
  },
});

const INBOX_LIMIT = 50;

export const myAlerts = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      alerts: v.array(
        v.object({
          alertId: v.string(),
          type: v.literal("approaching"),
          assignmentId: v.string(),
          runId: v.string(),
          stopLabel: v.string(),
          createdAtMs: v.number(),
          predictedArrivalAtMs: v.number(),
          predictionGeneratedAtMs: v.number(),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<MyAlertsResult> => {
    const user = await getUser(ctx);
    if (!user) return denied("unauthenticated");
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_user_created", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(INBOX_LIMIT);
    const alerts = [];
    for (const a of rows) {
      // Revoked access hides past alerts too.
      const access = await getTrackableAssignment(ctx, user, a.assignmentId);
      if (!access || access.assignment.stopId !== a.stopId) continue;
      const stop = await ctx.db.get(a.stopId);
      if (!stop) continue;
      alerts.push({
        alertId: a._id,
        type: a.type,
        assignmentId: a.assignmentId,
        runId: a.runId,
        stopLabel: stop.label,
        createdAtMs: a.createdAtMs,
        predictedArrivalAtMs: a.predictedArrivalAtMs,
        predictionGeneratedAtMs: a.predictionGeneratedAtMs,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: Date.now(), alerts };
  },
});
