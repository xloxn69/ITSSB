import { type ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { SessionExpiredError, type TrackingSource, type Unsubscribe } from "../tracking/store";

/**
 * Live `TrackingSource` over the authenticated Convex client (docs/08 §8).
 *
 * Function references are made by name, so the web app does not import
 * backend code; results are validated by the store's mapping, never trusted
 * as typed. `tracking:serverTime` (docs/08 §8.1) fails closed: if it is
 * missing or answers badly, time stays unverified and nothing is fresh.
 */
const ref = {
  myAssignments: makeFunctionReference<"query", Record<string, never>, unknown>("tracking:myAssignments"),
  myRun: makeFunctionReference<"query", { assignmentId: string }, unknown>("tracking:myRun"),
  myRoute: makeFunctionReference<"query", { assignmentId: string }, unknown>("tracking:myRoute"),
  serverTime: makeFunctionReference<"mutation", Record<string, never>, unknown>("tracking:serverTime"),
  myAlerts: makeFunctionReference<"query", Record<string, never>, unknown>("notifications:myAlerts"),
  myPreference: makeFunctionReference<"query", { assignmentId: string }, unknown>("notifications:myPreference"),
  setPreferences: makeFunctionReference<
    "mutation",
    { requestId: string; assignmentId: string; approachingEnabled: boolean; approachingMinutes: number },
    unknown
  >("notifications:setPreferences"),
};

/** The part of `ConvexReactClient` this source uses, so tests can fake it. */
export type LiveClient = Pick<ConvexReactClient, "watchQuery" | "mutation" | "action"> &
  Partial<Pick<ConvexReactClient, "connectionState" | "subscribeToConnectionState">>;

/** Maps the SDK's typed auth failure to the signed-out state; anything else stays a transport error. */
export function mapError(error: unknown): unknown {
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: unknown } | null)?.code;
    if (code === "UNAUTHENTICATED") return new SessionExpiredError();
  }
  return error;
}

export function convexSource(client: LiveClient): TrackingSource {
  function watch<A extends Record<string, unknown>>(
    query: ReturnType<typeof makeFunctionReference<"query", A, unknown>>,
    args: A,
    onValue: (raw: unknown) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe {
    // `A` is generic here, so the SDK's conditional args type can't resolve it.
    const watcher = client.watchQuery(query as Parameters<LiveClient["watchQuery"]>[0], args);
    let active = true;
    const emit = () => {
      if (!active) return;
      let value: unknown;
      try {
        value = watcher.localQueryResult();
      } catch (error) {
        onError(mapError(error));
        return;
      }
      // Undefined means still loading: the store stays in its loading state.
      if (value !== undefined) onValue(value);
    };
    const stop = watcher.onUpdate(emit);
    emit();
    return () => {
      active = false;
      stop();
    };
  }

  return {
    assignments: (onValue, onError) => watch(ref.myAssignments, {}, onValue, onError),
    run: (assignmentId, onValue, onError) => watch(ref.myRun, { assignmentId }, onValue, onError),
    route: (assignmentId, onValue, onError) => watch(ref.myRoute, { assignmentId }, onValue, onError),
    alerts: (onValue, onError) => watch(ref.myAlerts, {}, onValue, onError),
    preference: (assignmentId, onValue, onError) => watch(ref.myPreference, { assignmentId }, onValue, onError),
    setPreference: (args) => client.mutation(ref.setPreferences, args),
    connection(onChange) {
      if (!client.subscribeToConnectionState || !client.connectionState) return () => {};
      // Before the first connection, queries are still loading; nothing to doubt yet.
      const report = (s: { isWebSocketConnected: boolean; hasEverConnected: boolean }) =>
        onChange(s.isWebSocketConnected || !s.hasEverConnected);
      report(client.connectionState());
      return client.subscribeToConnectionState(report);
    },
    async serverTime() {
      const result = (await client.mutation(ref.serverTime, {})) as { schemaVersion?: unknown; serverNowMs?: unknown };
      if (result?.schemaVersion !== 1 || typeof result.serverNowMs !== "number" || !Number.isFinite(result.serverNowMs)) {
        throw new Error("Invalid serverTime result");
      }
      return result.serverNowMs;
    },
  };
}
