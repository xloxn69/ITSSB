/**
 * Development-only tracking source built from the canonical fictional
 * fixtures in `@itssb/contracts`. Imported only behind `import.meta.env.DEV`,
 * so a production build cannot show an invented position.
 *
 * Times are shifted to "now" so each scenario shows its state as it would
 * look live, and the age keeps advancing on screen.
 */
import type { MyAssignmentsResult, MyRunResult } from "@itssb/contracts";
import {
  myAlertsEmpty,
  myAlertsReady,
  myAssignmentsReady,
  myPreferenceDefault,
  myPreferenceReady,
  myRouteReady,
  myRunReady,
} from "@itssb/contracts/fixtures";
import { SessionExpiredError, type TrackingSource } from "../tracking/store";

export const FIXTURE_SCENARIOS = [
  "live",
  "eta",
  "at-stop",
  "passed",
  "aging",
  "stale",
  "no-fix",
  "receiver-missing",
  "awaiting",
  "completed",
  "cancelled",
  "no-run",
  "no-access",
  "signed-out",
  "error",
  "loading",
  "two-students",
  "offline-no-run",
  "offline-live",
] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

const readyRun = myRunReady as Extract<MyRunResult, { status: "ready" }>;
const readyAssignments = myAssignmentsReady as Extract<MyAssignmentsResult, { status: "ready" }>;

const AGE_MS: Partial<Record<FixtureScenario, number>> = {
  live: 3_000,
  eta: 3_000,
  "at-stop": 3_000,
  passed: 3_000,
  "two-students": 3_000,
  aging: 45_000,
  stale: 6 * 60_000,
  "no-fix": 20_000,
};

function runFor(scenario: FixtureScenario, assignmentId: string): unknown {
  const now = Date.now();
  if (scenario === "no-run" || scenario === "offline-no-run") {
    return { schemaVersion: 1, status: "no_active_run", serverNowMs: now, assignmentId, routeVersionId: readyRun.routeVersionId, run: null };
  }
  if (scenario === "no-access") {
    return { schemaVersion: 1, status: "access_unavailable", serverNowMs: now, reason: "not_permitted" };
  }
  const captured = now - (AGE_MS[scenario] ?? 3_000);
  const position = readyRun.run.lastPosition && {
    ...readyRun.run.lastPosition,
    capturedAtMs: captured,
    receivedAtMs: captured + 400,
  };
  const run = { ...readyRun.run, lastDeviceContactAtMs: captured + 400, lastPosition: position, eta: null };
  switch (scenario) {
    case "eta": {
      // The canonical estimate, shifted to now: 6 minutes out, made 2 s ago.
      const e = readyRun.run.eta!;
      Object.assign(run, {
        eta: {
          ...e,
          arrivalAtMs: captured + 6 * 60_000,
          generatedAtMs: now - 2_000,
          validUntilMs: captured + 60_000,
          sourceEventId: position?.eventId ?? e.sourceEventId,
        },
      });
      break;
    }
    case "at-stop":
    case "passed":
      Object.assign(run, { assignedStop: { ...readyRun.run.assignedStop, status: scenario === "at-stop" ? "at_stop" : "passed" } });
      break;
    case "no-fix":
      Object.assign(run, { gpsStatus: "no_fix", lastDeviceContactAtMs: now - 2_000 });
      break;
    case "receiver-missing":
      Object.assign(run, { gpsStatus: "receiver_missing", lastPosition: null, liveRevision: 0, lastDeviceContactAtMs: now - 2_000 });
      break;
    case "awaiting":
      Object.assign(run, { gpsStatus: null, lastPosition: null, liveRevision: 0, lastDeviceContactAtMs: null });
      break;
    case "completed":
    case "cancelled":
      Object.assign(run, { state: scenario });
      break;
  }
  return { ...readyRun, serverNowMs: now, assignmentId, run };
}

const never = () => () => {};

export function fixtureSource(scenario: FixtureScenario): TrackingSource {
  return {
    assignments(onValue, onError) {
      if (scenario === "loading") return never();
      if (scenario === "error") {
        const t = setTimeout(() => onError(new Error("fixture: network unavailable")), 0);
        return () => clearTimeout(t);
      }
      if (scenario === "signed-out") {
        const t = setTimeout(() => onError(new SessionExpiredError()), 0);
        return () => clearTimeout(t);
      }
      const assignments = [...readyAssignments.assignments];
      if (scenario === "two-students") {
        assignments.push({
          assignmentId: "demo_assignment_002",
          relationship: "guardian",
          studentDisplayName: "Jordan Example",
          routeLabel: "Route 17 Morning",
          stopLabel: "Maple & 3rd",
        });
      }
      const t = setTimeout(() => onValue({ ...readyAssignments, serverNowMs: Date.now(), assignments }), 0);
      return () => clearTimeout(t);
    },
    run(assignmentId, onValue) {
      const t = setTimeout(() => onValue(runFor(scenario, assignmentId)), 0);
      return () => clearTimeout(t);
    },
    route(assignmentId, onValue) {
      const t = setTimeout(() => onValue({ ...myRouteReady, serverNowMs: Date.now(), assignmentId }), 0);
      return () => clearTimeout(t);
    },
    serverTime: async () => Date.now(),
    alerts(onValue) {
      const base = scenario === "eta" ? myAlertsReady : myAlertsEmpty;
      const now = Date.now();
      const alerts =
        base.status === "ready"
          ? base.alerts.map((a) => ({ ...a, createdAtMs: now - 70_000, predictionGeneratedAtMs: now - 70_000, predictedArrivalAtMs: now + 4 * 60_000 }))
          : [];
      const t = setTimeout(() => onValue({ ...base, serverNowMs: now, alerts }), 0);
      return () => clearTimeout(t);
    },
    preference(assignmentId, onValue) {
      const base = scenario === "eta" ? myPreferenceReady : myPreferenceDefault;
      const t = setTimeout(() => onValue({ ...base, serverNowMs: Date.now(), preference: { ...(base as { preference: object }).preference, assignmentId } }), 0);
      return () => clearTimeout(t);
    },
    async setPreference(args) {
      // Fixture mode never writes anywhere; it echoes the choice as saved.
      return {
        schemaVersion: 1,
        status: "saved",
        serverNowMs: Date.now(),
        preference: { assignmentId: args.assignmentId, approachingEnabled: args.approachingEnabled, approachingMinutes: args.approachingMinutes, updatedAtMs: Date.now() },
      };
    },
    connection(onChange) {
      if (!scenario.startsWith("offline")) return () => {};
      const t = setTimeout(() => onChange(false), 50);
      return () => clearTimeout(t);
    },
  };
}
