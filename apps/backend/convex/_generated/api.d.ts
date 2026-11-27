/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as devices from "../devices.js";
import type * as driverGrants from "../driverGrants.js";
import type * as fleet from "../fleet.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_deviceAuth from "../lib/deviceAuth.js";
import type * as lib_routeChecks from "../lib/routeChecks.js";
import type * as lib_routeVersions from "../lib/routeVersions.js";
import type * as lib_staff from "../lib/staff.js";
import type * as routes from "../routes.js";
import type * as runs from "../runs.js";
import type * as seed from "../seed.js";
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
  devices: typeof devices;
  driverGrants: typeof driverGrants;
  fleet: typeof fleet;
  health: typeof health;
  http: typeof http;
  "lib/authz": typeof lib_authz;
  "lib/deviceAuth": typeof lib_deviceAuth;
  "lib/routeChecks": typeof lib_routeChecks;
  "lib/routeVersions": typeof lib_routeVersions;
  "lib/staff": typeof lib_staff;
  routes: typeof routes;
  runs: typeof runs;
  seed: typeof seed;
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
