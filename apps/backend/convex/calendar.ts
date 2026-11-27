import {
  CALENDAR_REFUSAL_CODES,
  type CalendarRefusalCode,
  type CalendarResult,
  isValidTimeZone,
  type ListServiceDaysResult,
  localDate,
  MAX_LATE_START_MINUTES,
  MAX_STAFF_REASON_LENGTH,
  SCHEMA_VERSION,
  type ServiceDay,
} from "@itssb/contracts";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { accessUnavailable, audit, denied, staffCaller } from "./lib/staff";
import { boundedText, okResult, refusedResult, staffActionResult } from "./lib/staffResults";

/**
 * Service calendar (docs/12 §3, §7): dates with no service or a late start,
 * each with a family-facing notice. Only today and later can be changed, so
 * the record of what was announced for a past day stays as it was.
 */

const result = staffActionResult(CALENDAR_REFUSAL_CODES);
const ok = okResult<CalendarRefusalCode>;
const refused = refusedResult<CalendarRefusalCode>;

/** A real calendar date in `YYYY-MM-DD` form. */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

const nullable = <T extends Parameters<typeof v.union>[0]>(x: T) => v.union(x, v.null());

export const listDays = query({
  args: {},
  returns: v.union(
    v.object({
      schemaVersion: v.literal(SCHEMA_VERSION),
      status: v.literal("ready"),
      serverNowMs: v.number(),
      days: v.array(
        v.object({
          serviceDate: v.string(),
          timezone: v.string(),
          status: v.union(v.literal("no_service"), v.literal("late_start")),
          lateStartMinutes: nullable(v.number()),
          notice: v.string(),
          setByName: nullable(v.string()),
          setAtMs: v.number(),
        }),
      ),
    }),
    accessUnavailable,
  ),
  handler: async (ctx): Promise<ListServiceDaysResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) return denied(caller.reason);
    const nowMs = Date.now();
    const days: ServiceDay[] = [];
    // Upcoming entries first; 30 days of history for context.
    const from = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const row of await ctx.db
      .query("serviceDays")
      .withIndex("by_date", (q) => q.gte("serviceDate", from))
      .take(366)) {
      days.push({
        serviceDate: row.serviceDate,
        timezone: row.timezone,
        status: row.status,
        lateStartMinutes: row.lateStartMinutes ?? null,
        notice: row.notice,
        setByName: (await ctx.db.get(row.setByUserId))?.displayName ?? null,
        setAtMs: row.setAtMs,
      });
    }
    return { schemaVersion: SCHEMA_VERSION, status: "ready", serverNowMs: nowMs, days };
  },
});

/** Adds or replaces the entry for one date. */
export const setDay = mutation({
  args: {
    serviceDate: v.string(),
    timezone: v.string(),
    status: v.union(v.literal("no_service"), v.literal("late_start")),
    lateStartMinutes: v.optional(v.number()),
    notice: v.string(),
  },
  returns: result,
  handler: async (ctx, args): Promise<CalendarResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "calendar.setDay", "serviceDays", args.serviceDate, "denied");
      return denied(caller.reason);
    }
    if (!isCalendarDate(args.serviceDate)) return refused("invalid_date", "Use a real date (YYYY-MM-DD).");
    if (!isValidTimeZone(args.timezone)) return refused("invalid_timezone", "Use a time zone like America/New_York.");
    if (args.serviceDate < localDate(Date.now(), args.timezone)) {
      return refused("past_date", "Past days can't be changed; they record what was announced.");
    }
    const notice = boundedText(args.notice, MAX_STAFF_REASON_LENGTH);
    if (!notice) return refused("notice_required", `Write the notice families see, 1 to ${MAX_STAFF_REASON_LENGTH} characters.`);
    const minutes = args.lateStartMinutes;
    const lateStart =
      args.status === "late_start" && minutes !== undefined && Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_LATE_START_MINUTES
        ? minutes
        : null;
    if (args.status === "late_start" && lateStart === null) {
      return refused("invalid_delay", `A late start is 1 to ${MAX_LATE_START_MINUTES} whole minutes.`);
    }
    const row = {
      serviceDate: args.serviceDate,
      timezone: args.timezone,
      status: args.status,
      notice,
      setByUserId: caller.user._id,
      setAtMs: Date.now(),
      ...(lateStart !== null ? { lateStartMinutes: lateStart } : {}),
    };
    const existing = await ctx.db
      .query("serviceDays")
      .withIndex("by_date", (q) => q.eq("serviceDate", args.serviceDate))
      .unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("serviceDays", row);
    await audit(ctx, caller.user, "calendar.setDay", "serviceDays", args.serviceDate, "allowed");
    return ok();
  },
});

/** Returns a future date to a normal operating day. */
export const removeDay = mutation({
  args: { serviceDate: v.string() },
  returns: result,
  handler: async (ctx, { serviceDate }): Promise<CalendarResult> => {
    const caller = await staffCaller(ctx);
    if (!caller.ok) {
      await audit(ctx, caller.user, "calendar.removeDay", "serviceDays", serviceDate, "denied");
      return denied(caller.reason);
    }
    const existing = isCalendarDate(serviceDate)
      ? await ctx.db
          .query("serviceDays")
          .withIndex("by_date", (q) => q.eq("serviceDate", serviceDate))
          .unique()
      : null;
    if (!existing) return refused("not_found", "There is no entry for that date.");
    if (serviceDate < localDate(Date.now(), existing.timezone)) {
      return refused("past_date", "Past days can't be changed; they record what was announced.");
    }
    await ctx.db.delete(existing._id);
    await audit(ctx, caller.user, "calendar.removeDay", "serviceDays", serviceDate, "allowed");
    return ok();
  },
});
