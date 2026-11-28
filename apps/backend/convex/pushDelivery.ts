"use node";

/**
 * Sends one outbox job through APNs (docs/10 §9). Node runtime, because
 * APNs needs HTTP/2. Claim and record are separate mutations, so the send
 * happens outside any transaction and a crash mid-send leaves a lease the
 * recovery sweep can reclaim.
 *
 * With no APNs configuration the action sends nothing and leaves jobs
 * untouched; the sweep expires them and the in-app inbox still has the alert.
 * Not yet run against Apple: needs the owner's APNs key and a signed device.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  type ApnsConfig,
  apnsConfigFromEnv,
  base64Url,
  buildApnsRequest,
  providerTokenSigningInput,
} from "./lib/apns";
import { sendOverHttp2 } from "./lib/apnsTransport";
import type { PushMessage, PushResult, PushSender } from "./lib/push";

/** Apple allows refreshing the provider token at most every 20 minutes and requires it under an hour. */
const PROVIDER_TOKEN_TTL_MS = 40 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
let cachedProviderToken: { token: string; issuedAtMs: number } | null = null;

async function providerToken(config: ApnsConfig): Promise<string> {
  const now = Date.now();
  if (cachedProviderToken && now - cachedProviderToken.issuedAtMs < PROVIDER_TOKEN_TTL_MS) {
    return cachedProviderToken.token;
  }
  const { createPrivateKey, sign } = await import("node:crypto");
  const input = providerTokenSigningInput(config, Math.floor(now / 1000));
  const key = createPrivateKey(config.privateKey);
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  const token = `${input}.${base64Url(new Uint8Array(signature))}`;
  cachedProviderToken = { token, issuedAtMs: now };
  return token;
}

class ApnsSender implements PushSender {
  constructor(private readonly config: ApnsConfig) {}

  async send(message: PushMessage): Promise<PushResult> {
    const http2 = await import("node:http2");
    const request = buildApnsRequest(this.config, message, await providerToken(this.config));
    return await sendOverHttp2((origin) => http2.connect(origin), request, SEND_TIMEOUT_MS);
  }
}

export const deliver = internalAction({
  args: { jobId: v.id("notificationJobs") },
  handler: async (ctx, { jobId }): Promise<string> => {
    const config = apnsConfigFromEnv(typeof process === "undefined" ? {} : process.env);
    if (!config) return "provider_not_configured";
    const leaseId = crypto.randomUUID();
    const message = await ctx.runMutation(internal.notificationJobs.claim, { jobId, leaseId, nowMs: Date.now() });
    if (!message) return "not_claimed";
    const result = await new ApnsSender(config).send(message);
    await ctx.runMutation(internal.notificationJobs.record, { jobId, leaseId, result, nowMs: Date.now() });
    return result.kind;
  },
});
