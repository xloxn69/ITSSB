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

describe("AlertsStore sign-out and account switch (docs/13 §5 A10)", () => {
  it("stopping releases the subscriptions and drops A's alerts and preference", () => {
    let open = 0;
    const store = new AlertsStore(
      source({
        alerts: (onValue) => {
          open += 1;
          onValue(myAlertsReady);
          return () => (open -= 1);
        },
        preference: (_id, onValue) => {
          open += 1;
          onValue(myPreferenceDefault);
          return () => (open -= 1);
        },
      }),
    );
    store.start("demo_assignment_001");
    expect(store.state).toMatchObject({ kind: "ready", alerts: [{ alertId: "demo_alert_001" }] });
    store.stop();
    expect(open).toBe(0);
    expect(store.state).toEqual({ kind: "loading" });
  });

  it("A's save answering after B signs in never replaces B's preference", async () => {
    let answerA: ((raw: unknown) => void) | undefined;
    const bPreference = {
      ...myPreferenceDefault,
      preference: { assignmentId: "demo_assignment_b01", approachingEnabled: false, approachingMinutes: 10, updatedAtMs: null },
    };
    const store = new AlertsStore(
      source({
        preference: (id, onValue) => {
          onValue(id === "demo_assignment_b01" ? bPreference : myPreferenceDefault);
          return () => {};
        },
        setPreference: () =>
          new Promise((resolve) => {
            answerA = resolve;
          }),
      }),
    );
    store.start("demo_assignment_001");
    const saving = store.save(true, 7);
    store.stop();
    store.start("demo_assignment_b01");
    answerA?.(setPreferencesSaved);
    await saving;
    expect(store.state).toMatchObject({
      kind: "ready",
      alerts: [],
      saving: false,
      saveFailed: false,
      preference: { assignmentId: "demo_assignment_b01", approachingMinutes: 10 },
    });
  });
});
