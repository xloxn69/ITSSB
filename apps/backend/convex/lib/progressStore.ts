import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { BASELINE_V1, predictArrival } from "./eta";
import { advance, type Fix, initialProgress, type PreparedRoute, prepareRoute, type ProgressState } from "./routeProgress";

/**
 * Database side of route progress and stored predictions. Telemetry ingest
 * feeds each live-applied fix through `ProgressTracker`; `commit` writes the
 * progress row and one prediction per stop ahead for the newest fix only, so
 * a drained offline batch does not write a prediction for every old point.
 */

export async function loadPreparedRoute(
  ctx: QueryCtx,
  routeVersionId: string,
): Promise<PreparedRoute | null> {
  const id = ctx.db.normalizeId("routeVersions", routeVersionId);
  const version = id ? await ctx.db.get(id) : null;
  if (!id || !version) return null;
  const stops = await ctx.db
    .query("stops")
    .withIndex("by_route_version", (q) => q.eq("routeVersionId", id))
    .collect();
  return prepareRoute(
    version.path,
    stops.map((s) => ({ stopId: s._id, sequence: s.sequence, latitude: s.latitude, longitude: s.longitude })),
  );
}

export async function getRunProgress(ctx: QueryCtx, runId: Id<"runs">) {
  return await ctx.db
    .query("runProgress")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

type Tracked = {
  run: Doc<"runs">;
  route: PreparedRoute;
  state: ProgressState;
  last: { eventId: string; capturedAtMs: number; liveRevision: number } | null;
};

export class ProgressTracker {
  private readonly runs = new Map<Id<"runs">, Tracked | null>();

  constructor(private readonly ctx: MutationCtx) {}

  /** Applies one fix that just replaced the run's live position. */
  async observe(run: Doc<"runs">, fix: Fix & { eventId: string }, liveRevision: number): Promise<void> {
    let tracked = this.runs.get(run._id);
    if (tracked === undefined) {
      tracked = await this.load(run);
      this.runs.set(run._id, tracked);
    }
    if (!tracked) return;
    tracked.state = advance(tracked.route, tracked.state, fix);
    tracked.last = { eventId: fix.eventId, capturedAtMs: fix.capturedAtMs, liveRevision };
  }

  private async load(run: Doc<"runs">): Promise<Tracked | null> {
    const route = await loadPreparedRoute(this.ctx, run.routeVersionId);
    // No ordered stops or no usable path: no progress, no estimate, never a guess.
    if (!route) return null;
    const row = await getRunProgress(this.ctx, run._id);
    const state: ProgressState =
      row && row.stops.length === route.stops.length
        ? { alongM: row.alongM, atMs: row.atMs, lastStatus: row.lastStatus, stops: row.stops }
        : initialProgress(route, run.startedAtMs ?? run._creationTime);
    return { run, route, state, last: null };
  }

  /** Writes progress and the newest fix's predictions for each touched run. */
  async commit(nowMs: number): Promise<void> {
    for (const tracked of this.runs.values()) {
      if (!tracked?.last) continue;
      const { run, route, state, last } = tracked;
      const fields = {
        runId: run._id,
        routeVersionId: run.routeVersionId,
        alongM: state.alongM,
        atMs: state.atMs,
        lastStatus: state.lastStatus,
        lastEventId: last.eventId,
        stops: state.stops,
      };
      const row = await getRunProgress(this.ctx, run._id);
      if (row) await this.ctx.db.replace(row._id, fields);
      else await this.ctx.db.insert("runProgress", fields);

      for (const stop of route.stops) {
        const p = predictArrival(route, state, stop.stopId, BASELINE_V1, last.capturedAtMs);
        if (!p) continue;
        await this.ctx.db.insert("etaPredictions", {
          runId: run._id,
          routeVersionId: run.routeVersionId,
          stopId: stop.stopId,
          sourceEventId: last.eventId,
          sourceCapturedAtMs: last.capturedAtMs,
          liveRevision: last.liveRevision,
          generatedAtMs: nowMs,
          arrivalAtMs: p.arrivalAtMs,
          validUntilMs: p.validUntilMs,
          algorithmVersion: BASELINE_V1.algorithmVersion,
        });
      }
    }
  }
}
