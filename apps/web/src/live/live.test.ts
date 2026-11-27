import { myAssignmentsReady, myRunNoActiveRun, myRunReady } from "@itssb/contracts/fixtures";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { connectionNotice, SessionExpiredError, TrackStore } from "../tracking/store";
import { liveConfig } from "./config";
import { convexSource, type LiveClient, mapError } from "./convexSource";

const key = (name: string, args: unknown) => `${name}:${JSON.stringify(args)}`;

/** A fake Convex client: tests set each query's current result or error. */
function fakeClient() {
  const results = new Map<string, { value?: unknown; error?: unknown }>();
  const listeners = new Map<string, Set<() => void>>();
  const mutation = vi.fn<(name: string) => Promise<unknown>>();
  let conn = { isWebSocketConnected: true, hasEverConnected: true };
  const connListeners = new Set<(s: typeof conn) => void>();
  const client = {
    connectionState: () => conn,
    subscribeToConnectionState: (cb: (s: typeof conn) => void) => {
      connListeners.add(cb);
      return () => connListeners.delete(cb);
    },
    watchQuery: (q: unknown, args: unknown) => {
      const k = key(getFunctionName(q as never), args ?? {});
      return {
        localQueryResult() {
          const r = results.get(k);
          if (r?.error) throw r.error;
          return r?.value;
        },
        onUpdate(cb: () => void) {
          const set = listeners.get(k) ?? new Set();
          set.add(cb);
          listeners.set(k, set);
          return () => set.delete(cb);
        },
      };
    },
    mutation: (m: unknown) => mutation(getFunctionName(m as never)),
  } as unknown as LiveClient;
  const push = (name: string, args: unknown, r: { value?: unknown; error?: unknown }) => {
    results.set(key(name, args), r);
    for (const cb of listeners.get(key(name, args)) ?? []) cb();
  };
  const setConnected = (isWebSocketConnected: boolean) => {
    conn = { isWebSocketConnected, hasEverConnected: true };
    for (const cb of connListeners) cb(conn);
  };
  return { client, push, mutation, listeners, setConnected };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("convexSource", () => {
  it("drives the store from live query updates and verifies server time", async () => {
    const { client, push, mutation } = fakeClient();
    mutation.mockResolvedValue({ schemaVersion: 1, serverNowMs: Date.now() });
    const store = new TrackStore(convexSource(client));
    store.start();
    expect(store.state.kind).toBe("loading");
    push("tracking:myAssignments", {}, { value: myAssignmentsReady });
    push("tracking:myRun", { assignmentId: "demo_assignment_001" }, { value: myRunReady });
    await flush();
    expect(mutation).toHaveBeenCalledWith("tracking:serverTime");
    expect(store.state).toMatchObject({ kind: "tracking", clock: { kind: "verified" } });
  });

  it("an auth error from the SDK is signed out; other errors are failures", () => {
    const { client, push } = fakeClient();
    const store = new TrackStore(convexSource(client));
    store.start();
    push("tracking:myAssignments", {}, { error: new ConvexError({ code: "UNAUTHENTICATED" }) });
    expect(store.state).toEqual({ kind: "session_expired" });
    expect(mapError(new Error("WebSocket closed"))).not.toBeInstanceOf(SessionExpiredError);
  });

  it("a bad serverTime answer leaves time unverified", async () => {
    const { client, push, mutation } = fakeClient();
    mutation.mockResolvedValue({ schemaVersion: 1, serverNowMs: "soon" });
    const store = new TrackStore(convexSource(client));
    store.start();
    push("tracking:myAssignments", {}, { value: myAssignmentsReady });
    push("tracking:myRun", { assignmentId: "demo_assignment_001" }, { value: myRunReady });
    await flush();
    expect(store.state).toMatchObject({ kind: "tracking", clock: { kind: "query" } });
  });

  it("stopping unsubscribes from every query", () => {
    const { client, push, listeners } = fakeClient();
    const store = new TrackStore(convexSource(client));
    store.start();
    push("tracking:myAssignments", {}, { value: myAssignmentsReady });
    store.stop();
    const remaining = [...listeners.values()].reduce((n, s) => n + s.size, 0);
    expect(remaining).toBe(0);
  });
});

describe("connection loss (no error from the SDK)", () => {
  it("a remembered no-trip answer is not shown as no trip while disconnected", () => {
    const { client, push, setConnected } = fakeClient();
    const store = new TrackStore(convexSource(client));
    store.start();
    push("tracking:myAssignments", {}, { value: myAssignmentsReady });
    push("tracking:myRun", { assignmentId: "demo_assignment_001" }, { value: myRunNoActiveRun });
    expect(connectionNotice(store.state, store.connectionLost)).toBeNull();
    setConnected(false);
    expect(store.state.kind).toBe("no_active_run");
    expect(connectionNotice(store.state, store.connectionLost)).toBe("replace");
    setConnected(true);
    expect(connectionNotice(store.state, store.connectionLost)).toBeNull();
  });

  it("a tracking view gets a banner; loading before the first connection is not doubted", () => {
    expect(connectionNotice({ kind: "tracking" } as never, true)).toBe("banner");
    expect(connectionNotice({ kind: "access_unavailable" }, true)).toBe("replace");
    expect(connectionNotice({ kind: "failed", message: "x" }, true)).toBeNull();
  });
});

describe("liveConfig", () => {
  it("needs an https Convex URL and a publishable key", () => {
    expect(liveConfig({})).toBeNull();
    expect(liveConfig({ VITE_CONVEX_URL: "http://x", VITE_CLERK_PUBLISHABLE_KEY: "pk_test_x" })).toBeNull();
    expect(liveConfig({ VITE_CONVEX_URL: "https://x.convex.cloud", VITE_CLERK_PUBLISHABLE_KEY: "sk_test_x" })).toBeNull();
    expect(liveConfig({ VITE_CONVEX_URL: "https://x.convex.cloud", VITE_CLERK_PUBLISHABLE_KEY: "pk_test_x" })).toEqual({
      convexUrl: "https://x.convex.cloud",
      clerkPublishableKey: "pk_test_x",
    });
  });
});
