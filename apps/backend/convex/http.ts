import {
  type DeviceHealthAccepted,
  MAX_EVENTS_PER_TELEMETRY_REQUEST,
  MAX_HEALTH_BODY_BYTES,
  MAX_ROSTER_BODY_BYTES,
  validateRosterAction,
  MAX_TRIP_EVENT_BODY_BYTES,
  MAX_TELEMETRY_BODY_BYTES,
  SCHEMA_VERSION,
  type TelemetryResponse,
} from "@itssb/contracts";
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, httpAction } from "./_generated/server";
import { parseBearer, sha256Hex } from "./lib/deviceAuth";
import { generateToken, tokenHash } from "./lib/tokens";

const http = httpRouter();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function requestError(status: number, code: string, message: string, retryable: boolean) {
  return json(status, { schemaVersion: SCHEMA_VERSION, error: { code, message, retryable } });
}

function isDeviceNotAuthorized(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    (error.data as { code?: unknown } | null)?.code === "DEVICE_NOT_AUTHORIZED"
  );
}

/** POST /device/v1/telemetry — see docs/08 §4. */
http.route({
  path: "/device/v1/telemetry",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = parseBearer(req.headers.get("Authorization"));
    if (!secret) return requestError(401, "UNAUTHENTICATED", "Device credential required.", false);
    const credentialHash = await sha256Hex(secret);
    const deviceId = await ctx.runQuery(internal.devices.byCredentialHash, { credentialHash });
    if (!deviceId) return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);

    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_TELEMETRY_BODY_BYTES) {
      return requestError(413, "BODY_TOO_LARGE", "Split the batch into smaller requests.", false);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return requestError(400, "MALFORMED_JSON", "Body is not valid JSON.", false);
    }
    const envelope = body as { schemaVersion?: unknown; events?: unknown };
    if (envelope?.schemaVersion !== SCHEMA_VERSION) {
      return requestError(400, "UNSUPPORTED_SCHEMA_VERSION", "Unsupported protocol version.", false);
    }
    if (!Array.isArray(envelope.events) || envelope.events.length === 0) {
      return requestError(400, "INVALID_ENVELOPE", "events must be a non-empty array.", false);
    }
    if (envelope.events.length > MAX_EVENTS_PER_TELEMETRY_REQUEST) {
      return requestError(413, "TOO_MANY_EVENTS", "Split the batch into smaller requests.", false);
    }

    const nowMs = Date.now();
    let results: TelemetryResponse["results"];
    try {
      results = await ctx.runMutation(internal.telemetry.ingestBatch, {
        deviceId,
        credentialHash,
        events: envelope.events,
        nowMs,
      });
    } catch (error) {
      // Revoked or rotated between the credential lookup and the commit.
      if (isDeviceNotAuthorized(error)) {
        return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);
      }
      throw error;
    }
    const response: TelemetryResponse = { schemaVersion: SCHEMA_VERSION, serverNowMs: nowMs, results };
    return json(200, response);
  }),
});

/** POST /device/v1/trip-events — start or end a run (docs/08 §6). */
http.route({
  path: "/device/v1/trip-events",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = parseBearer(req.headers.get("Authorization"));
    if (!secret) return requestError(401, "UNAUTHENTICATED", "Device credential required.", false);
    const credentialHash = await sha256Hex(secret);
    const deviceId = await ctx.runQuery(internal.devices.byCredentialHash, { credentialHash });
    if (!deviceId) return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);

    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_TRIP_EVENT_BODY_BYTES) {
      return requestError(413, "BODY_TOO_LARGE", "Trip-event body is too large.", false);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return requestError(400, "MALFORMED_JSON", "Body is not valid JSON.", false);
    }
    // Only the grant's hash crosses into the database layer.
    const grant = (body as { driverOperatingGrant?: unknown } | null)?.driverOperatingGrant;
    const grantHash = await sha256Hex(typeof grant === "string" ? grant : "");

    try {
      const outcome = await ctx.runMutation(internal.tripEvents.apply, {
        deviceId,
        credentialHash,
        grantHash,
        request: body,
        nowMs: Date.now(),
      });
      if (outcome.ok) return json(200, outcome.body);
      return requestError(outcome.status, outcome.code, outcome.message, false);
    } catch (error) {
      if (isDeviceNotAuthorized(error)) {
        return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);
      }
      throw error;
    }
  }),
});

/** POST /device/v1/health — device heartbeat (docs/08 §7). */
http.route({
  path: "/device/v1/health",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = parseBearer(req.headers.get("Authorization"));
    if (!secret) return requestError(401, "UNAUTHENTICATED", "Device credential required.", false);
    const deviceId = await ctx.runQuery(internal.devices.byCredentialHash, {
      credentialHash: await sha256Hex(secret),
    });
    if (!deviceId) return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);

    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_HEALTH_BODY_BYTES) {
      return requestError(413, "BODY_TOO_LARGE", "Health body is too large.", false);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return requestError(400, "MALFORMED_JSON", "Body is not valid JSON.", false);
    }
    const nowMs = Date.now();
    try {
      const outcome = await ctx.runMutation(internal.health.record, { deviceId, report: body, nowMs });
      if (!outcome.ok) return requestError(400, outcome.code, outcome.message, false);
      const accepted: DeviceHealthAccepted = {
        schemaVersion: SCHEMA_VERSION,
        status: "accepted",
        receivedAtMs: outcome.receivedAtMs,
        serverNowMs: nowMs,
      };
      return json(200, accepted);
    } catch (error) {
      if (isDeviceNotAuthorized(error)) {
        return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);
      }
      throw error;
    }
  }),
});

/**
 * Shared front of the driver-grant device endpoints (docs/08 §9.2):
 * authenticate the device, bound and parse the body, check the schema
 * version, and hash the grant so only its hash reaches the database layer.
 */
async function deviceGrantRequest(
  ctx: ActionCtx,
  req: Request,
): Promise<
  | { ok: true; deviceId: Id<"devices">; body: Record<string, unknown>; grantHash: string }
  | { ok: false; response: Response }
> {
  const secret = parseBearer(req.headers.get("Authorization"));
  if (!secret) return { ok: false, response: requestError(401, "UNAUTHENTICATED", "Device credential required.", false) };
  const deviceId = await ctx.runQuery(internal.devices.byCredentialHash, { credentialHash: await sha256Hex(secret) });
  if (!deviceId) return { ok: false, response: requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false) };
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_ROSTER_BODY_BYTES) {
    return { ok: false, response: requestError(413, "BODY_TOO_LARGE", "Body is too large.", false) };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, response: requestError(400, "MALFORMED_JSON", "Body is not valid JSON.", false) };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: requestError(400, "INVALID_REQUEST", "Body must be an object.", false) };
  }
  const b = body as Record<string, unknown>;
  if (b.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, response: requestError(400, "UNSUPPORTED_SCHEMA_VERSION", "Unsupported protocol version.", false) };
  }
  const grant = b.driverOperatingGrant;
  return { ok: true, deviceId, body: b, grantHash: await sha256Hex(typeof grant === "string" ? grant : "") };
}

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (isDeviceNotAuthorized(error)) return requestError(401, "UNAUTHENTICATED", "Device credential rejected.", false);
    throw error;
  }
}

/** POST /device/v1/qr-codes — a check-in challenge or enrollment invitation (docs/08 §9.2). */
http.route({
  path: "/device/v1/qr-codes",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const parsed = await deviceGrantRequest(ctx, req);
    if (!parsed.ok) return parsed.response;
    // Generated here, where randomness is real; only the hash is stored.
    const token = generateToken();
    return await guarded(async () => {
      const nowMs = Date.now();
      const outcome = await ctx.runMutation(internal.deviceRoster.issueQrCode, {
        deviceId: parsed.deviceId,
        grantHash: parsed.grantHash,
        tokenHash: (await tokenHash(token)) as string,
        request: parsed.body,
        nowMs,
      });
      if (!outcome.ok) return requestError(outcome.status, outcome.code, outcome.message, false);
      return json(200, {
        schemaVersion: SCHEMA_VERSION,
        purpose: outcome.purpose,
        token,
        linkPath: outcome.linkPath,
        expiresAtMs: outcome.expiresAtMs,
        serverNowMs: nowMs,
      });
    });
  }),
});

/** POST /device/v1/roster — the run's students for the driver screen (docs/08 §9.2). */
http.route({
  path: "/device/v1/roster",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const parsed = await deviceGrantRequest(ctx, req);
    if (!parsed.ok) return parsed.response;
    if (typeof parsed.body.runId !== "string") return requestError(400, "INVALID_REQUEST", "runId is required.", false);
    const runId = parsed.body.runId;
    return await guarded(async () => {
      const outcome = await ctx.runQuery(internal.deviceRoster.roster, {
        deviceId: parsed.deviceId,
        grantHash: parsed.grantHash,
        runId,
        nowMs: Date.now(),
      });
      return outcome.ok ? json(200, outcome.body) : requestError(outcome.status, outcome.code, outcome.message, false);
    });
  }),
});

/** POST /device/v1/roster-actions — one driver action, possibly queued offline (docs/08 §9.2). */
http.route({
  path: "/device/v1/roster-actions",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const parsed = await deviceGrantRequest(ctx, req);
    if (!parsed.ok) return parsed.response;
    const checked = validateRosterAction(parsed.body);
    if (!checked.ok) return requestError(400, "INVALID_REQUEST", checked.message, false);
    return await guarded(async () =>
      json(
        200,
        await ctx.runMutation(internal.deviceRoster.applyAction, {
          deviceId: parsed.deviceId,
          grantHash: parsed.grantHash,
          action: checked.value,
          nowMs: Date.now(),
        }),
      ),
    );
  }),
});

export default http;
