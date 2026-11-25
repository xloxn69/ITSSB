import {
  MAX_EVENTS_PER_TELEMETRY_REQUEST,
  MAX_TELEMETRY_BODY_BYTES,
  SCHEMA_VERSION,
  type TelemetryResponse,
} from "@itssb/contracts";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { parseBearer, sha256Hex } from "./lib/deviceAuth";

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

/** POST /device/v1/telemetry — see docs/08 §4. */
http.route({
  path: "/device/v1/telemetry",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = parseBearer(req.headers.get("Authorization"));
    if (!secret) return requestError(401, "UNAUTHENTICATED", "Device credential required.", false);
    const deviceId = await ctx.runQuery(internal.devices.byCredentialHash, {
      credentialHash: await sha256Hex(secret),
    });
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
    const results = await ctx.runMutation(internal.telemetry.ingestBatch, {
      deviceId,
      events: envelope.events,
      nowMs,
    });
    const response: TelemetryResponse = { schemaVersion: SCHEMA_VERSION, serverNowMs: nowMs, results };
    return json(200, response);
  }),
});

export default http;
