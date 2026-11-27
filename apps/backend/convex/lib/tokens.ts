import { normalizeToken, TOKEN_ALPHABET, TOKEN_LENGTH, type TokenProblem, type TokenPurpose } from "@itssb/contracts";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./deviceAuth";

/**
 * Scoped opaque tokens (docs/09 §2–§3): enrollment invitations, guardian
 * invitations, and trip check-in challenges share one table and one
 * resolution path, so a token is always checked for its own purpose.
 */

/**
 * A new token: 20 Crockford base32 characters, 100 random bits. Call only
 * from an action or HTTP action, where `crypto.getRandomValues` is real
 * randomness rather than a mutation's deterministic seed.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so `% 32` is unbiased.
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % 32]).join("");
}

/** Hash of the canonical form, or null if the text cannot be a token. */
export async function tokenHash(raw: string): Promise<string | null> {
  const token = normalizeToken(raw);
  return token ? await sha256Hex(token) : null;
}

export type TokenResolution =
  | { ok: true; token: Doc<"scopedTokens"> }
  | { ok: false; problem: TokenProblem };

/**
 * Finds a token by hash, then checks purpose, revocation, and expiry, in
 * that order. Unknown, malformed, and revoked tokens all answer `invalid`.
 * Single-use is checked by the caller, which knows who is using it.
 */
export async function resolveToken(
  ctx: QueryCtx | MutationCtx,
  raw: string,
  purpose: TokenPurpose,
  nowMs: number,
): Promise<TokenResolution> {
  const hash = await tokenHash(raw);
  if (!hash) return { ok: false, problem: "invalid" };
  const token = await ctx.db
    .query("scopedTokens")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", hash))
    .unique();
  if (!token || token.revoked) return { ok: false, problem: "invalid" };
  if (token.purpose !== purpose) return { ok: false, problem: "wrong_purpose" };
  if (token.expiresAtMs <= nowMs) return { ok: false, problem: "expired" };
  return { ok: true, token };
}
