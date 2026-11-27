import { type Infer, v } from "convex/values";

/**
 * The push-provider seam. The outbox worker only knows this result shape;
 * APNs (lib/apns.ts, pushDelivery.ts) is one implementation behind it.
 */
export const pushResult = v.union(
  v.object({ kind: v.literal("accepted") }),
  /** Transient: throttling, provider outage, network error, or an ambiguous timeout. */
  v.object({ kind: v.literal("retryable"), reason: v.string() }),
  /** The token is no longer valid for this app; disable it. */
  v.object({ kind: v.literal("permanent_token"), reason: v.string() }),
  /** Will never succeed as sent (bad payload, bad configuration). */
  v.object({ kind: v.literal("permanent"), reason: v.string() }),
);
export type PushResult = Infer<typeof pushResult>;

export interface PushMessage {
  token: string;
  environment: "sandbox" | "production";
  title: string;
  body: string;
  /** UTC epoch milliseconds; converted to APNs seconds at the adapter boundary. */
  expiresAtMs: number;
  collapseId: string;
  assignmentId: string;
}

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}
