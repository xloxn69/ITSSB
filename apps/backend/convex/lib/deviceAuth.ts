/**
 * Device credential helpers.
 *
 * A Pi authenticates with `Authorization: Bearer <secret>`. Only the SHA-256
 * hash of the secret is stored. The device identity always comes from this
 * credential, never from a `deviceId` field in the request body (docs/08 §4).
 */

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extracts the bearer secret, or null if the header is missing or malformed. */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,512})$/.exec(header.trim());
  return match?.[1] ?? null;
}

/** Generates a new device secret. Shown once at enrollment, then only hashed. */
export function generateDeviceSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
