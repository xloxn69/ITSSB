/**
 * Runtime-neutral parts of the APNs adapter (docs/10 §9): configuration,
 * request building, and response classification. Signing and the HTTP/2
 * connection live in the Node action (pushDelivery.ts). Nothing here has
 * been exercised against Apple yet: that needs the owner's APNs key and a
 * signed device build.
 */
import type { PushMessage, PushResult } from "./push";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** Contents of the .p8 signing key. Server-side only, from deployment env. */
  privateKey: string;
  bundleId: string;
}

/** Null unless every value is set: with no key, nothing is ever sent. */
export function apnsConfigFromEnv(env: Record<string, string | undefined>): ApnsConfig | null {
  const teamId = env.APNS_TEAM_ID;
  const keyId = env.APNS_KEY_ID;
  const privateKey = env.APNS_PRIVATE_KEY;
  const bundleId = env.APNS_BUNDLE_ID;
  if (!teamId || !keyId || !privateKey || !bundleId) return null;
  return { teamId, keyId, privateKey, bundleId };
}

export function apnsHost(environment: PushMessage["environment"]): string {
  return environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

/** APNs `apns-expiration` is epoch seconds; ITSSB keeps milliseconds everywhere else. */
export function apnsExpirationSeconds(expiresAtMs: number): number {
  return Math.floor(expiresAtMs / 1000);
}

export function buildApnsRequest(config: ApnsConfig, message: PushMessage, providerToken: string) {
  return {
    origin: apnsHost(message.environment),
    path: `/3/device/${message.token}`,
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(apnsExpirationSeconds(message.expiresAtMs)),
      "apns-collapse-id": message.collapseId,
    },
    body: JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      // Opaque: the app opens this assignment and fetches current state.
      itssb: { type: "approaching", assignmentId: message.assignmentId },
    }),
  };
}

const TOKEN_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered", "ExpiredToken"]);
const RETRYABLE_REASONS = new Set(["ExpiredProviderToken", "TooManyProviderTokenUpdates", "TooManyRequests"]);

/** Maps an APNs HTTP status and `reason` to the outbox result. */
export function classifyApnsResponse(status: number, reason: string | null): PushResult {
  if (status === 200) return { kind: "accepted" };
  const r = reason ?? `HTTP ${status}`;
  if (status === 410 || (reason !== null && TOKEN_REASONS.has(reason))) return { kind: "permanent_token", reason: r };
  if (status === 429 || status >= 500 || (reason !== null && RETRYABLE_REASONS.has(reason))) {
    return { kind: "retryable", reason: r };
  }
  return { kind: "permanent", reason: r };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** The unsigned `header.claims` part of the ES256 provider token. */
export function providerTokenSigningInput(config: ApnsConfig, issuedAtS: number): string {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "ES256", kid: config.keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: config.teamId, iat: issuedAtS })));
  return `${header}.${claims}`;
}

export function base64Url(bytes: Uint8Array): string {
  return b64url(bytes);
}
