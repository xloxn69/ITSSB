/**
 * Server-aligned clock for aging a bus position (docs/08 §8.1).
 *
 * Mirrors the iOS `ServerClock`. A query result can come from cache and the
 * browser clock can be wrong, so a position may only be called fresh once
 * verified server time (`tracking:serverTime`, a mutation, never cached) has
 * been measured. Every error in this file is allowed to make a position look
 * older, never fresher.
 */

/** A sample whose round trip took longer than this is rejected. */
export const MAX_SERVER_TIME_ROUND_TRIP_MS = 5_000;

/** Readings of the browser's two clocks at one instant. */
export interface Instant {
  /** `Date.now()`: wall clock, may be wrong or jump. */
  wallMs: number;
  /** `performance.now()`: monotonic, but may pause while the device sleeps. */
  monoMs: number;
}

export type ServerClock =
  | {
      kind: "verified";
      /** Server time pinned to the round trip's midpoint. */
      serverNowMs: number;
      at: Instant;
      /** Half the round trip, added so the error never favors freshness. */
      uncertaintyMs: number;
    }
  | {
      /** Only a query's `serverNowMs`, which may be cached and old. */
      kind: "query";
      serverNowMs: number;
      receivedAtWallMs: number;
    };

export function readInstant(): Instant {
  return { wallMs: Date.now(), monoMs: performance.now() };
}

/** The clock implied by one query result, before verified time exists. */
export function queryClock(serverNowMs: number, receivedAtWallMs: number): ServerClock {
  return { kind: "query", serverNowMs, receivedAtWallMs };
}

/**
 * Builds a verified clock from one `tracking:serverTime` round trip, or null
 * when the sample is unusable (too slow, non-finite, or out of order).
 */
export function verifiedClock(sent: Instant, received: Instant, serverNowMs: number): ServerClock | null {
  const roundTrip = received.monoMs - sent.monoMs;
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(roundTrip)) return null;
  if (roundTrip < 0 || roundTrip > MAX_SERVER_TIME_ROUND_TRIP_MS) return null;
  const half = roundTrip / 2;
  return {
    kind: "verified",
    serverNowMs,
    at: { wallMs: sent.wallMs + half, monoMs: sent.monoMs + half },
    uncertaintyMs: half,
  };
}

/**
 * The best estimate of "now" for aging a position.
 *
 * Verified: server time advanced by elapsed time. Browsers' monotonic clock
 * may pause while the device sleeps (iOS's does not), and the wall clock can
 * be set back, so elapsed time is the larger of the two. Either failure can
 * only make the position look older.
 *
 * Query-only: the larger of browser time and query-aligned time. A cached
 * `serverNowMs` makes the aligned time look earlier, never later.
 */
export function ageClockMs(clock: ServerClock, now: Instant): number {
  if (clock.kind === "verified") {
    const elapsed = Math.max(now.monoMs - clock.at.monoMs, now.wallMs - clock.at.wallMs, 0);
    return clock.serverNowMs + elapsed + clock.uncertaintyMs;
  }
  const aligned = now.wallMs + (clock.serverNowMs - clock.receivedAtWallMs);
  return Math.max(now.wallMs, aligned);
}
