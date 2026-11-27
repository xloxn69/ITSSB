import type { AuthConfig } from "convex/server";

// The Convex runtime provides `process.env`; declared here instead of pulling
// in all of @types/node for one read.
declare const process: { env: Record<string, string | undefined> };

/**
 * Human sign-in through Clerk (docs/17 §3).
 *
 * `CLERK_JWT_ISSUER_DOMAIN` is a Convex deployment environment variable, set
 * per deployment with `bunx convex env set` (see apps/backend/README.md). It is
 * the Clerk "Frontend API" URL, e.g. https://example-name-00.clerk.accounts.dev.
 * Tokens come from a Clerk JWT template named `convex`, whose audience is
 * `applicationID`.
 *
 * Unset means no provider: nobody can sign in and every person-facing query
 * answers as signed out. That fails closed instead of breaking `convex dev`
 * on a fresh deployment.
 */
export function clerkProviders(issuerDomain: string | undefined): AuthConfig["providers"] {
  const domain = issuerDomain?.trim();
  return domain ? [{ domain, applicationID: "convex" }] : [];
}

/**
 * Reads the issuer without failing the push. Convex's auth-config evaluator
 * throws `AuthConfigMissingEnvironmentVariable` when an unset variable is
 * read, which would stop `convex dev` on a fresh deployment.
 */
export function readIssuer(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export default {
  providers: clerkProviders(readIssuer(() => process.env.CLERK_JWT_ISSUER_DOMAIN)),
} satisfies AuthConfig;
