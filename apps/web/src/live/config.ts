/**
 * Public build configuration. Both values are public by design (a Convex
 * deployment URL and a Clerk publishable key); no secret ever goes in a
 * `VITE_` variable. Missing values mean "not set up", which fails closed.
 */
export interface LiveConfig {
  convexUrl: string;
  clerkPublishableKey: string;
}

export function liveConfig(env: Record<string, unknown> = import.meta.env): LiveConfig | null {
  const convexUrl = typeof env.VITE_CONVEX_URL === "string" ? env.VITE_CONVEX_URL.trim() : "";
  const clerkPublishableKey =
    typeof env.VITE_CLERK_PUBLISHABLE_KEY === "string" ? env.VITE_CLERK_PUBLISHABLE_KEY.trim() : "";
  if (!convexUrl.startsWith("https://") || !clerkPublishableKey.startsWith("pk_")) return null;
  return { convexUrl, clerkPublishableKey };
}
