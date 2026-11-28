/**
 * Development-only staff data: fictional routes, drafts, devices, and
 * drivers held in memory, with the server's review rules mirrored loosely so
 * every page state can be seen in a browser. Imported only behind
 * `import.meta.env.DEV`. The real rules live in apps/backend/convex/routes.ts.
 */
import type {
  DriverGrantSummary,
  MaintenanceWindow,
  StaffInvitationSummary,
  ServiceDay,
  DeviceSummary,
  DraftDetail,
  DriverSummary,
  RouteCheck,
  RouteSummary,
} from "@itssb/contracts";
import { myRouteReady } from "@itssb/contracts/fixtures";
import type { StaffActionName, StaffArgs, StaffMutationName, StaffQueryName, StaffSource } from "../staff/source";
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
const gpsLost: RouteCheck = {
  code: "gap_in_recording",
  severity: "warning",
  message: "GPS was lost 1 time while recording. The dashed line is not measured travel; check the road there.",
};
const noStops: RouteCheck = { code: "no_stops", severity: "blocking", message: "The route has no stops." };

// Stops sit 60 recorded points (about 1 km) apart along the path. Adjacent
// points are metres apart, so their pins would be drawn over one another.
const STOP_SPACING = 60;

function stops(label: string, i: number) {
  const p = basePath[Math.min(i * STOP_SPACING, basePath.length - 1)] ?? { latitude: 34.1, longitude: -83.98 };
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
      // GPS lost for a stretch: the points between were never recorded.
      path: [...shifted(0.004, -0.006).slice(0, 140), ...shifted(0.004, -0.006).slice(200)],
      gapBeforeIndexes: [140],
      stops: ["Birch & 2nd", "Cedar Park", "Elm Court"].map(stops).map((s) => ({ ...s, latitude: s.latitude + 0.004, longitude: s.longitude - 0.006 })),
      checks: [gpsLost],
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
  const dayMs = 24 * 60 * 60_000;
  const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * dayMs).toISOString().slice(0, 10);
  const days: ServiceDay[] =
    variant === "staff"
      ? [
          { serviceDate: isoDay(3), timezone: "America/New_York", status: "late_start", lateStartMinutes: 120, notice: "Two-hour delay for the teacher workshop", setByName: "Riley Staff", setAtMs: Date.now() - dayMs },
          { serviceDate: isoDay(9), timezone: "America/New_York", status: "no_service", lateStartMinutes: null, notice: "No buses: Thanksgiving break", setByName: "Riley Staff", setAtMs: Date.now() - 2 * dayMs },
        ]
      : [];
  const windows: MaintenanceWindow[] =
    variant === "staff"
      ? [{ windowId: "demo_window_001", deviceId: "demo_device_003", deviceLabel: "Spare Pi", startsAtMs: Date.now() + 20 * 60 * 60_000, endsAtMs: Date.now() + 22 * 60 * 60_000, reason: "Software update", scheduledByName: "Riley Staff" }]
      : [];
  const grants: DriverGrantSummary[] =
    variant === "staff"
      ? [
          {
            grantId: "demo_grant_001",
            driverUserId: "demo_user_021",
            deviceId: "demo_device_001",
            deviceLabel: "Bench Pi",
            routeVersions: [{ routeVersionId: "demo_route_version_003", label: "Route 17 Morning" }],
            issuedAtMs: Date.now() - 3 * 60 * 60_000,
            expiresAtMs: Date.now() + 9 * 60 * 60_000,
            issuedByName: "Riley Staff",
          },
        ]
      : [];
  const staffInvitations: StaffInvitationSummary[] =
    variant === "staff"
      ? [
          { invitationId: "demo_staff_inv_002", displayName: "Jamie Staff", issuedAtMs: Date.now() - 2 * 60 * 60_000, issuedByName: "Riley Staff", expiresAtMs: Date.now() + 2 * dayMs, revoked: false, usedAtMs: null },
          { invitationId: "demo_staff_inv_001", displayName: "Casey Staff", issuedAtMs: Date.now() - 5 * dayMs, issuedByName: "Riley Staff", expiresAtMs: Date.now() - 2 * dayMs, revoked: false, usedAtMs: Date.now() - 4 * dayMs },
        ]
      : [];
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
            // A measuring Pi, one that cannot read some values, and older software.
            metrics:
              d.lastContactAtMs === null
                ? null
                : i === 0
                  ? {
                      receivedAtMs: d.lastContactAtMs,
                      uploadConsecutiveFailures: 0,
                      uploadRetriesSinceStart: 4,
                      lastUploadErrorClass: "http_503",
                      processRssBytes: 41_900_000,
                      memAvailableBytes: 1_204_000_000,
                      cpuTemperatureC: 51.2,
                      databaseBytes: 3_150_000,
                    }
                  : i === 1
                    ? {
                        receivedAtMs: d.lastContactAtMs,
                        uploadConsecutiveFailures: 3,
                        uploadRetriesSinceStart: 12,
                        lastUploadErrorClass: "OSError",
                        processRssBytes: null,
                        memAvailableBytes: null,
                        cpuTemperatureC: null,
                        databaseBytes: 18_400_000,
                      }
                    : null,
            lastRunReport: d.activeRun
              ? {
                  reportId: "demo_run_report_001",
                  runId: d.activeRun.runId,
                  category: "traffic",
                  expectedDelayMinutes: 10,
                  capturedAtMs: Date.now() - 6 * 60_000,
                  receivedAtMs: Date.now() - 6 * 60_000 + 900,
                  driverName: "Dana Driver",
                }
              : null,
          })),
          notifications:
            variant === "staff-empty"
              ? {
                  oldestWaitingCreatedAtMs: null,
                  waitingCount: 0,
                  windowMs: 24 * 60 * 60_000,
                  countsByState: {
                    pending: 0,
                    in_progress: 0,
                    provider_accepted: 0,
                    retryable_failure: 0,
                    permanent_failure: 0,
                    expired: 0,
                    cancelled: 0,
                  },
                  truncated: false,
                }
              : {
                  oldestWaitingCreatedAtMs: Date.now() - 4 * 60_000,
                  waitingCount: 2,
                  windowMs: 24 * 60 * 60_000,
                  countsByState: {
                    pending: 1,
                    in_progress: 0,
                    provider_accepted: 18,
                    retryable_failure: 1,
                    permanent_failure: 0,
                    expired: 2,
                    cancelled: 1,
                  },
                  truncated: false,
                },
        });
      case "fleet:listMaintenance":
        return env({ status: "ready", windows });
      case "driverGrants:listForStaff":
        return env({
          status: "ready",
          grants,
          routeVersions: state.routes.flatMap((r) =>
            r.currentVersion ? [{ routeVersionId: r.currentVersion.routeVersionId, label: r.label, versionNumber: r.currentVersion.versionNumber }] : [],
          ),
        });
      case "staffInvitations:list":
        return env({ status: "ready", invitations: staffInvitations });
      case "calendar:listDays":
        return env({ status: "ready", days: days.toSorted((a, b) => a.serviceDate.localeCompare(b.serviceDate)) });
      default:
        return enrollmentAnswer(enrollment, name, args);
    }
  }


  function mutate(name: StaffMutationName, raw: StaffArgs): unknown {
    const args = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
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
      case "runOps:cancelRun":
      case "runOps:replaceDevice": {
        const device = state.devices.find((x) => x.activeRun?.runId === args.runId);
        if (!device) return refuse("not_active", "This run has already ended.");
        if (!args.reason?.trim()) return refuse("reason_required", "Say why, in 1 to 200 characters.");
        device.activeRun = null;
        changed();
        return env({ status: "ok" });
      }
      case "calendar:setDay": {
        if (!args.notice?.trim()) return refuse("notice_required", "Write the notice for families, 1 to 200 characters.");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args.serviceDate ?? "")) return refuse("invalid_date", "Use a real date (YYYY-MM-DD).");
        const i = days.findIndex((day) => day.serviceDate === args.serviceDate);
        if (i >= 0) days.splice(i, 1);
        days.push({
          serviceDate: args.serviceDate!,
          timezone: args.timezone ?? "America/New_York",
          status: args.status === "late_start" ? "late_start" : "no_service",
          lateStartMinutes: args.status === "late_start" ? Number(args.lateStartMinutes) : null,
          notice: args.notice.trim(),
          setByName: "Riley Staff",
          setAtMs: Date.now(),
        });
        changed();
        return env({ status: "ok" });
      }
      case "calendar:removeDay": {
        const i = days.findIndex((day) => day.serviceDate === args.serviceDate);
        if (i < 0) return refuse("not_found", "There is no entry for that date.");
        days.splice(i, 1);
        changed();
        return env({ status: "ok" });
      }
      case "fleet:scheduleMaintenance": {
        if (!args.reason?.trim()) return refuse("reason_required", "Say why, in 1 to 200 characters.");
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device || device.revoked) return refuse("device_unavailable", "That device doesn't exist or is revoked.");
        windows.push({
          windowId: `demo_window_${windows.length + 2}`,
          deviceId: device.deviceId,
          deviceLabel: device.label,
          startsAtMs: Number(args.startsAtMs),
          endsAtMs: Number(args.endsAtMs),
          reason: args.reason.trim(),
          scheduledByName: "Riley Staff",
        });
        changed();
        return env({ status: "ok" });
      }
      case "fleet:cancelMaintenance": {
        const i = windows.findIndex((w) => w.windowId === args.windowId);
        if (i < 0) return refuse("not_found", "That window doesn't exist.");
        windows.splice(i, 1);
        changed();
        return env({ status: "ok" });
      }
      case "fleet:addDriver": {
        const displayName = args.displayName?.trim() ?? "";
        if (!displayName || displayName.length > 80) return refuse("invalid_name", "Use 1 to 80 characters for the name.");
        const userId = `demo_user_new_${state.drivers.length + 1}`;
        state.drivers.push({ userId, displayName });
        changed();
        return env({ status: "created", userId });
      }
      case "driverGrants:revokeForStaff": {
        const i = grants.findIndex((g) => g.grantId === args.grantId);
        if (i < 0) return refuse("not_found", "That grant doesn't exist.");
        grants.splice(i, 1);
        changed();
        return env({ status: "ok" });
      }
      case "staffInvitations:revoke": {
        const inv = staffInvitations.find((x) => x.invitationId === args.invitationId);
        if (!inv) return refuse("not_found", "That invitation doesn't exist.");
        inv.revoked = true;
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

  function act(name: StaffActionName, args: StaffArgs): unknown {
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
      case "driverGrants:issueForDriver": {
        const driver = state.drivers.find((x) => x.userId === args.driverUserId);
        if (!driver) return refuse("driver_not_found", "That driver doesn't exist.");
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device || device.revoked) return refuse("device_unavailable", "That device doesn't exist or is revoked.");
        const ids = Array.isArray(args.routeVersionIds) ? args.routeVersionIds : [];
        const routeVersions = state.routes
          .filter((r) => r.currentVersion && ids.includes(r.currentVersion.routeVersionId))
          .map((r) => ({ routeVersionId: r.currentVersion!.routeVersionId, label: r.label }));
        if (routeVersions.length === 0 || routeVersions.length !== ids.length) {
          return refuse("route_version_unavailable", "A chosen route isn't approved for new runs. Reload and choose again.");
        }
        const expiresAtMs = Date.now() + Number(args.ttlMs);
        const grantId = `demo_grant_new_${grants.length + 2}`;
        grants.push({ grantId, driverUserId: driver.userId, deviceId: device.deviceId, deviceLabel: device.label, routeVersions, issuedAtMs: Date.now(), expiresAtMs, issuedByName: "Riley Staff" });
        changed();
        return env({ status: "issued", grantId, grant: fakeSecret(), expiresAtMs, driverUserId: driver.userId, driverName: driver.displayName, deviceId: device.deviceId, routeVersions });
      }
      case "staffInvitations:create": {
        const displayName = String(args.displayName ?? "").trim();
        if (!displayName) return refuse("invalid_name", "Use 1 to 80 characters for the name.");
        const expiresAtMs = Date.now() + Number(args.ttlMs);
        const invitationId = `demo_staff_inv_new_${staffInvitations.length + 1}`;
        staffInvitations.unshift({ invitationId, displayName, issuedAtMs: Date.now(), issuedByName: "Riley Staff", expiresAtMs, revoked: false, usedAtMs: null });
        changed();
        // Fictional and obviously fake; never a real code.
        return env({ status: "created", invitationId, token: "FAKE0STAFF0C0DE00000", expiresAtMs });
      }
      case "fleet:rotateDeviceCredential": {
        const device = state.devices.find((x) => x.deviceId === args.deviceId);
        if (!device) return refuse("not_found", "That device doesn't exist.");
        if (device.revoked) return refuse("revoked", "This device is revoked. Provision a new device instead.");
        return env({ status: "issued", deviceId: device.deviceId, deviceSecret: fakeSecret() });
      }
      default: {
        const result = enrollmentAct(enrollment, name, args as Record<string, string | number>);
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
