/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as audit from "../audit.js";
import type * as checkIns from "../checkIns.js";
import type * as crons from "../crons.js";
import type * as deviceRoster from "../deviceRoster.js";
import type * as calendar from "../calendar.js";
import type * as devices from "../devices.js";
import type * as driverGrants from "../driverGrants.js";
import type * as enrollment from "../enrollment.js";
import type * as fleet from "../fleet.js";
import type * as guardianLinks from "../guardianLinks.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as lib_alertRules from "../lib/alertRules.js";
import type * as lib_apns from "../lib/apns.js";
import type * as lib_attendance from "../lib/attendance.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";
import type * as lib_eta from "../lib/eta.js";
import type * as lib_family from "../lib/family.js";
import type * as lib_progressStore from "../lib/progressStore.js";
import type * as lib_push from "../lib/push.js";
import type * as lib_routeChecks from "../lib/routeChecks.js";
import type * as lib_routeProgress from "../lib/routeProgress.js";
import type * as lib_routeVersions from "../lib/routeVersions.js";
import type * as lib_staff from "../lib/staff.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as notificationJobs from "../notificationJobs.js";
import type * as notifications from "../notifications.js";
import type * as pushDelivery from "../pushDelivery.js";
import type * as retention from "../retention.js";
import type * as lib_staffResults from "../lib/staffResults.js";
import type * as routes from "../routes.js";
import type * as runOps from "../runOps.js";
import type * as runs from "../runs.js";
import type * as seed from "../seed.js";
import type * as staffInvitations from "../staffInvitations.js";
import type * as students from "../students.js";
import type * as telemetry from "../telemetry.js";
import type * as tracking from "../tracking.js";
import type * as tripEvents from "../tripEvents.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  audit: typeof audit;
  checkIns: typeof checkIns;
  crons: typeof crons;
  deviceRoster: typeof deviceRoster;
  calendar: typeof calendar;
  devices: typeof devices;
  driverGrants: typeof driverGrants;
  enrollment: typeof enrollment;
  fleet: typeof fleet;
  guardianLinks: typeof guardianLinks;
  health: typeof health;
  http: typeof http;
  "lib/alertRules": typeof lib_alertRules;
  "lib/apns": typeof lib_apns;
  "lib/attendance": typeof lib_attendance;
  "lib/authz": typeof lib_authz;
  "lib/deviceAuth": typeof lib_deviceAuth;
  "lib/eta": typeof lib_eta;
  "lib/family": typeof lib_family;
  "lib/progressStore": typeof lib_progressStore;
  "lib/push": typeof lib_push;
  "lib/routeChecks": typeof lib_routeChecks;
  "lib/routeProgress": typeof lib_routeProgress;
  "lib/routeVersions": typeof lib_routeVersions;
  "lib/staff": typeof lib_staff;
  "lib/tokens": typeof lib_tokens;
  notificationJobs: typeof notificationJobs;
  notifications: typeof notifications;
  pushDelivery: typeof pushDelivery;
  retention: typeof retention;
  "lib/staffResults": typeof lib_staffResults;
  routes: typeof routes;
  runOps: typeof runOps;
  runs: typeof runs;
  seed: typeof seed;
  staffInvitations: typeof staffInvitations;
  students: typeof students;
  telemetry: typeof telemetry;
  tracking: typeof tracking;
  tripEvents: typeof tripEvents;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
