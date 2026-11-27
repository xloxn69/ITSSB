import { describe, expect, it } from "vitest";
import {
  apnsConfigFromEnv,
  apnsExpirationSeconds,
  buildApnsRequest,
  classifyApnsResponse,
  providerTokenSigningInput,
} from "./lib/apns";

const config = { teamId: "TEAMID0000", keyId: "KEYID00000", privateKey: "fake", bundleId: "org.example.itssb" };
const message = {
  token: "a1".repeat(32),
  environment: "sandbox" as const,
  title: "School bus approaching",
  body: "Open ITSSB for the current estimate.",
  expiresAtMs: 1_795_609_145_999,
  collapseId: "alert_1",
  assignmentId: "assignment_1",
};

const decode = (x: string) => JSON.parse(atob(x.replaceAll("-", "+").replaceAll("_", "/")));

describe("APNs adapter (pure parts)", () => {
  it("sends nothing without full configuration", () => {
    expect(apnsConfigFromEnv({ APNS_TEAM_ID: "x", APNS_KEY_ID: "y", APNS_BUNDLE_ID: "z" })).toBeNull();
    expect(
      apnsConfigFromEnv({ APNS_TEAM_ID: "x", APNS_KEY_ID: "y", APNS_BUNDLE_ID: "z", APNS_PRIVATE_KEY: "k" }),
    ).not.toBeNull();
  });

  it("converts the expiry to epoch seconds at the boundary", () => {
    expect(apnsExpirationSeconds(1_795_609_145_999)).toBe(1_795_609_145);
    const r = buildApnsRequest(config, message, "jwt");
    expect(r.headers["apns-expiration"]).toBe("1795609145");
  });

  it("builds an alert request for the token's environment with a stable collapse ID", () => {
    const r = buildApnsRequest(config, message, "jwt");
    expect(r.origin).toBe("https://api.sandbox.push.apple.com");
    expect(buildApnsRequest(config, { ...message, environment: "production" }, "jwt").origin).toBe(
      "https://api.push.apple.com",
    );
    expect(r.path).toBe(`/3/device/${message.token}`);
    expect(r.headers).toMatchObject({
      authorization: "bearer jwt",
      "apns-topic": "org.example.itssb",
      "apns-push-type": "alert",
      "apns-collapse-id": "alert_1",
    });
    expect(JSON.parse(r.body)).toEqual({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      itssb: { type: "approaching", assignmentId: "assignment_1" },
    });
  });

  it("classifies responses into accepted, token, retryable, and permanent failures", () => {
    expect(classifyApnsResponse(200, null)).toEqual({ kind: "accepted" });
    expect(classifyApnsResponse(410, "Unregistered").kind).toBe("permanent_token");
    expect(classifyApnsResponse(400, "BadDeviceToken").kind).toBe("permanent_token");
    expect(classifyApnsResponse(429, "TooManyRequests").kind).toBe("retryable");
    expect(classifyApnsResponse(503, "ServiceUnavailable").kind).toBe("retryable");
    expect(classifyApnsResponse(403, "ExpiredProviderToken").kind).toBe("retryable");
    expect(classifyApnsResponse(400, "PayloadTooLarge").kind).toBe("permanent");
    expect(classifyApnsResponse(403, "InvalidProviderToken").kind).toBe("permanent");
  });

  it("encodes the provider token header and claims as base64url JSON", () => {
    const [h, c] = providerTokenSigningInput(config, 1_795_609_000).split(".");
    expect(decode(h!)).toEqual({ alg: "ES256", kid: "KEYID00000" });
    expect(decode(c!)).toEqual({ iss: "TEAMID0000", iat: 1_795_609_000 });
  });
});
