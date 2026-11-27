import { myAlertsReady, myPreferenceDefault, setPreferencesSaved } from "@itssb/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { AlertsStore } from "./alerts";
import type { TrackingSource } from "./store";

function source(overrides: Partial<TrackingSource> = {}): TrackingSource {
  return {
    assignments: () => () => {},
    run: () => () => {},
    route: () => () => {},
    serverTime: async () => Date.now(),
    alerts: (onValue) => {
      onValue(myAlertsReady);
      return () => {};
    },
    preference: (_id, onValue) => {
      onValue(myPreferenceDefault);
      return () => {};
    },
    ...overrides,
  };
}

describe("AlertsStore", () => {
  it("shows only the selected assignment's alerts with its preference", () => {
    const store = new AlertsStore(source());
    store.start("demo_assignment_001");
    expect(store.state).toMatchObject({ kind: "ready", preference: { approachingEnabled: false } });
    if (store.state.kind !== "ready") return;
    expect(store.state.alerts).toHaveLength(1);
    store.start("demo_assignment_002");
    expect(store.state).toMatchObject({ kind: "ready", alerts: [] });
  });

  it("changes the preference only when the server confirms the save", async () => {
    const sent: unknown[] = [];
    const store = new AlertsStore(
      source({
        setPreference: async (args) => {
          sent.push(args);
          return setPreferencesSaved;
        },
      }),
    );
    store.start("demo_assignment_001");
    await store.save(true, 7);
    expect(sent).toMatchObject([{ assignmentId: "demo_assignment_001", approachingEnabled: true, approachingMinutes: 7 }]);
    expect(store.state).toMatchObject({ kind: "ready", preference: { approachingEnabled: true, approachingMinutes: 7 } });
  });

  it("a failed save keeps the server's value and says so", async () => {
    const store = new AlertsStore(
      source({
        setPreference: async () => {
          throw new Error("offline");
        },
      }),
    );
    store.start("demo_assignment_001");
    await store.save(true, 5);
    expect(store.state).toMatchObject({ kind: "ready", saveFailed: true, preference: { approachingEnabled: false } });
  });

  it("a source without notifications shows no inbox", () => {
    const { alerts: _a, preference: _p, ...plain } = source();
    const store = new AlertsStore(plain);
    store.start("demo_assignment_001");
    expect(store.state.kind).toBe("unavailable");
  });
});
