/**
 * Development-only staff data: fictional routes, drafts, devices, and
 * drivers held in memory, with the server's review rules mirrored loosely so
 * every page state can be seen in a browser. Imported only behind
 * `import.meta.env.DEV`. The real rules live in apps/backend/convex/routes.ts.
 */
import type {
  DeviceSummary,
  DraftDetail,
  DriverSummary,
  RouteCheck,
  RouteSummary,
} from "@itssb/contracts";
import { myRouteReady } from "@itssb/contracts/fixtures";
import type { StaffActionName, StaffMutationName, StaffQueryName, StaffSource } from "../staff/source";
import { enrollmentAct, enrollmentAnswer, enrollmentFixtureState, enrollmentMutate } from "./enrollmentStaffFixtures";

export const STAFF_VARIANTS = ["staff", "staff-empty", "staff-denied", "staff-error", "staff-loading"] as const;
export type StaffVariant = (typeof STAFF_VARIANTS)[number];

const MIN = 60_000;
const basePath = myRouteReady.status === "ready" ? myRouteReady.path : [];

function shifted(dLat: number, dLon: number) {
  return basePath.map((p) => ({ latitude: p.latitude + dLat, longitude: p.longitude + dLon }));
}

function draft(
  partial: Partial<DraftDetail> & Pick<DraftDetail, "draftId" | "label" | "path" | "stops" | "checks">,
): DraftDetail {
  return {
    routeId: null,
    direction: "to_school",
    status: "submitted",
    submittedAtMs: Date.now() - 40 * MIN,
    pointCount: partial.path.length,
    stopCount: partial.stops.length,
    reviewedAtMs: null,
    reviewerName: null,
    decisionReason: null,
    approvedVersionId: null,
    ...partial,
  };
}

const gapWarning: RouteCheck = {
  code: "path_gap",
  severity: "warning",
  message: "1 gap longer than 100 m in the recording.",
};
const noStops: RouteCheck = { code: "no_stops", severity: "blocking", message: "The route has no stops." };

function stops(label: string, i: number) {
  const p = basePath[Math.min(i, basePath.length - 1)] ?? { latitude: 34.1, longitude: -83.98 };
  return { sequence: i, label, latitude: p.latitude, longitude: p.longitude, instructions: i === 0 ? "Wait on the north corner." : null };
}

const env = (body: object) => ({ schemaVersion: 1, serverNowMs: Date.now(), ...body });
const refuse = (code: string, message: string) => env({ status: "refused", code, message });

function initialState(variant: StaffVariant) {
  const now = Date.now();
  if (variant === "staff-empty") {
    return { routes: [] as RouteSummary[], drafts: [] as DraftDetail[], devices: [] as DeviceSummary[], drivers: [] as DriverSummary[], assigned: new Set<string>() };
  }
  const routes: RouteSummary[] = [
    {
      routeId: "demo_route_017",
      label: "Route 17 Morning",
      direction: "to_school",
      currentVersion: {
        routeVersionId: "demo_route_version_003",
        versionNumber: 3,
        approvedAtMs: now - 6 * 24 * 60 * MIN,
        approvedByName: "Riley Staff",
        effectiveFromMs: now - 6 * 24 * 60 * MIN,
        stopCount: 6,
      },
    },
    {
      routeId: "demo_route_004",
      label: "Route 4 Afternoon",
      direction: "from_school",
      currentVersion: {
        routeVersionId: "demo_route_version_010",
        versionNumber: 1,
        approvedAtMs: now - 2 * 24 * 60 * MIN,
        approvedByName: "Riley Staff",
        effectiveFromMs: now - 2 * 24 * 60 * MIN,
        stopCount: 4,
      },
    },
  ];
  const drafts: DraftDetail[] = [
    draft({
      draftId: "demo_draft_009",
      label: "Route 9 Morning",
      path: shifted(0.004, -0.006),
      stops: ["Birch & 2nd", "Cedar Park", "Elm Court"].map(stops).map((s) => ({ ...s, latitude: s.latitude + 0.004, longitude: s.longitude - 0.006 })),
      checks: [],
    }),
    draft({
      draftId: "demo_draft_017",
      routeId: "demo_route_017",
      label: "Route 17 Morning",
      path: shifted(0, 0),
      stops: ["Oak & Pine", "Maple & 3rd"].map(stops),
      checks: [gapWarning],
      submittedAtMs: now - 3 * 60 * MIN,
    }),
    draft({
      draftId: "demo_draft_021",
      label: "Route 21 Afternoon",
      direction: "from_school",
      path: shifted(-0.003, 0.004),
      stops: [],
      checks: [noStops],
      submittedAtMs: now - 26 * 60 * MIN,
    }),
    draft({
      draftId: "demo_draft_004",
      routeId: "demo_route_004",
      label: "Route 4 Afternoon",
      direction: "from_school",
      path: shifted(0.002, 0.002),
      stops: ["Willow Lane"].map(stops),
      checks: [],
      status: "rejected",
      reviewedAtMs: now - 2 * 24 * 60 * MIN,
      reviewerName: "Riley Staff",
      decisionReason: "Stop is on the wrong side of the road for afternoon drop-off.",
    }),
  ];
  const devices: DeviceSummary[] = [
    {
      deviceId: "demo_device_001",
      label: "Bench Pi",
      busLabel: "Bus 12",
      revoked: false,
      activeRun: { runId: "demo_run_001", routeLabel: "Route 17 Morning", startedAtMs: now - 22 * MIN },
      lastContactAtMs: now - 8_000,
    },
    {
      deviceId: "demo_device_002",
      label: "Pi in Bus 7",
      busLabel: "Bus 7",
      revoked: false,
      activeRun: { runId: "demo_run_002", routeLabel: "Route 4 Afternoon", startedAtMs: now - 40 * MIN },
      lastContactAtMs: now - 6 * MIN,
    },
    { deviceId: "demo_device_003", label: "Spare Pi", busLabel: null, revoked: false, activeRun: null, lastContactAtMs: null },
    { deviceId: "demo_device_004", label: "Old Pi", busLabel: "Bus 3", revoked: true, activeRun: null, lastContactAtMs: null },
  ];
  const drivers: DriverSummary[] = [
    { userId: "demo_user_021", displayName: "Dana Driver" },
    { userId: "demo_user_022", displayName: "Morgan Driver" },
  ];
  // Route 17's current version has assigned students, as in the server rule.
  return { routes, drafts, devices, drivers, assigned: new Set(["demo_route_017"]) };
}

export function staffFixtureSource(variant: StaffVariant): StaffSource {
  const state = initialState(variant);
  const enrollment = enrollmentFixtureState(variant === "staff-empty");
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of listeners) l();
  };

  function answer(name: StaffQueryName, args: Record<string, string>): unknown {
    if (variant === "staff-denied") return env({ status: "access_unavailable", reason: "not_permitted" });
    switch (name) {
      case "routes:list":
        return env({ status: "ready", routes: state.routes });
      case "routes:listDrafts": {
        const summaries = state.drafts.map(({ path: _p, stops: _s, checks: _c, ...summary }) => summary);
        return env({
          status: "ready",
          drafts: [...summaries.filter((d) => d.status === "submitted"), ...summaries.filter((d) => d.status !== "submitted")],
        });
      }
      case "routes:getDraft": {
        const found = state.drafts.find((d) => d.draftId === args.draftId);
        return found ? env({ status: "ready", draft: found }) : env({ status: "not_found" });
      }
      case "fleet:listDevices":
        return env({ status: "ready", devices: state.devices });
      case "fleet:listDrivers":
        return env({ status: "ready", drivers: state.drivers });
      case "fleet:diagnostics":
        return env({
          status: "ready",
          deployment: { release: "2026.11.27-0f1c2d3", environment: "development", contractSchemaVersion: 1 },
          retention: {
            rawGpsDays: 30,
            lastSweepAtMs: variant === "staff-empty" ? null : Date.now() - 6 * 60 * 60_000,
            lastSweepDeleted: variant === "staff-empty" ? null : "telemetry:1440,live:2",
          },
          devices: state.devices.map((d, i) => ({
            deviceId: d.deviceId,
            label: d.label,
            busLabel: d.busLabel,
            revoked: d.revoked,
            activeRunId: d.activeRun?.runId ?? null,
            lastContactAtMs: d.lastContactAtMs,
            softwareVersion: d.lastContactAtMs === null ? null : "0.1.0",
            pendingCount: d.lastContactAtMs === null ? null : i === 1 ? 37 : 0,
            oldestPendingCapturedAtMs: i === 1 ? Date.now() - 7 * 60_000 : null,
            lastRun: d.activeRun
              ? { runId: d.activeRun.runId, state: "active", endedAtMs: null }
              : i === 2
                ? { runId: "demo_run_031", state: "completed", endedAtMs: Date.now() - 26 * 60 * 60_000 }
                : null,
          })),
        });
      default:
        return enrollmentAnswer(enrollment, name, args);
    }
  }


  function mutate(name: StaffMutationName, args: Record<string, string>): unknown {
    if (variant === "staff-denied") return env({ status: "access_unavailable", reason: "not_permitted" });
    const d = state.drafts.find((x) => x.draftId === args.draftId);
    switch (name) {
      case "routes:approveDraft": {
        if (!d) return refuse("not_found", "That draft doesn't exist.");
        if (d.status === "rejected") return refuse("already_decided", "This draft has already been decided.");
        if (d.checks.some((c) => c.severity === "blocking")) return refuse("blocking_checks", "Fix the blocking problems before approving.");
        if (d.routeId && state.assigned.has(d.routeId)) {
          return refuse(
            "route_has_assignments",
            "Students are assigned to the current version. Moving them to a new version isn't supported yet.",
          );
        }
        if (d.status === "approved") return env({ status: "approved" });
        const existing = state.routes.find((r) => r.routeId === d.routeId);
        const versionNumber = (existing?.currentVersion?.versionNumber ?? 0) + 1;
        const routeVersionId = `demo_route_version_${d.draftId}`;
        const currentVersion = {
          routeVersionId,
          versionNumber,
          approvedAtMs: Date.now(),
          approvedByName: "Riley Staff",
          effectiveFromMs: Date.now(),
          stopCount: d.stops.length,
        };
        if (existing) existing.currentVersion = currentVersion;
        else state.routes.push({ routeId: `demo_route_${d.draftId}`, label: d.label, direction: d.direction, currentVersion });
        Object.assign(d, { status: "approved", reviewedAtMs: Date.now(), reviewerName: "Riley Staff", approvedVersionId: routeVersionId });
        changed();
        return env({ status: "approved", routeVersionId, versionNumber });
      }
      case "routes:rejectDraft": {
        if (!d) return refuse("not_found", "That draft doesn't exist.");
        if (!args.reason?.trim()) return refuse("reason_required", "Say why the draft is rejected, so the driver can fix it.");
        if (d.status !== "submitted") return refuse("already_decided", "This draft has already been decided.");
        Object.assign(d, { status: "rejected", reviewedAtMs: Date.now(), reviewerName: "Riley Staff", decisionReason: args.reason.trim() });
        changed();
        return env({ status: "rejected" });
      }
      case "fleet:setBusLabel": {
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device) return refuse("not_found", "That device doesn't exist.");
        const label = args.busLabel?.trim() ?? "";
        if (!label || label.length > 40) return refuse("invalid_label", "Use 1 to 40 characters.");
        device.busLabel = label;
        changed();
        return env({ status: "ok" });
      }
      case "fleet:revokeDevice": {
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device) return refuse("not_found", "That device doesn't exist.");
        device.revoked = true;
        changed();
        return env({ status: "ok" });
      }
      default: {
        const result = enrollmentMutate(enrollment, name, args);
        changed();
        return result;
      }
    }
  }

  /** Fictional, obviously fake secrets: never a real credential. */
  let issuedCount = 0;
  const fakeSecret = () => `fixture0not0a0real0device0secret${String(++issuedCount).padStart(32, "0")}`;

  function act(name: StaffActionName, args: Record<string, string | number>): unknown {
    if (variant === "staff-denied") return env({ status: "access_unavailable", reason: "not_permitted" });
    switch (name) {
      case "fleet:provisionDevice": {
        const label = String(args.label ?? "").trim();
        if (!label || label.length > 80) return refuse("invalid_label", "Use 1 to 80 characters for the device name.");
        const deviceId = `demo_device_new_${state.devices.length + 1}`;
        state.devices.push({ deviceId, label, busLabel: String(args.busLabel ?? "").trim() || null, revoked: false, activeRun: null, lastContactAtMs: null });
        changed();
        return env({ status: "issued", deviceId, deviceSecret: fakeSecret() });
      }
      case "fleet:rotateDeviceCredential": {
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device) return refuse("not_found", "That device doesn't exist.");
        if (device.revoked) return refuse("revoked", "This device is revoked. Provision a new device instead.");
        return env({ status: "issued", deviceId: device.deviceId, deviceSecret: fakeSecret() });
      }
      default: {
        const result = enrollmentAct(enrollment, name, args);
        changed();
        return result;
      }
    }
  }

  return {
    act: async (name, args) => act(name, args),
    watch(name, args, onValue, onError) {
      if (variant === "staff-loading") return () => {};
      if (variant === "staff-error") {
        const t = setTimeout(() => onError(new Error("fixture: network unavailable")), 0);
        return () => clearTimeout(t);
      }
      const emit = () => onValue(structuredClone(answer(name, args)));
      const t = setTimeout(emit, 0);
      listeners.add(emit);
      return () => {
        clearTimeout(t);
        listeners.delete(emit);
      };
    },
    mutate: async (name, args) => mutate(name, args),
  };
}
