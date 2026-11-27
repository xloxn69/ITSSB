import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import authConfig, { clerkProviders, readIssuer } from "./auth.config";
import schema from "./schema";
import { UNLINKED_PREFIX } from "./users";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://example-name-00.clerk.accounts.dev";
/** What Convex derives from a verified Clerk token: `issuer|subject`. */
const CLERK_IDENTITY = { issuer: ISSUER, subject: "user_fictional01", tokenIdentifier: `${ISSUER}|user_fictional01` };

describe("auth.config", () => {
  it("trusts Clerk tokens for the `convex` audience from the configured issuer", () => {
    expect(clerkProviders(` ${ISSUER} `)).toEqual([{ domain: ISSUER, applicationID: "convex" }]);
  });

  it("an unset variable that throws on read (as Convex's evaluator does) means no provider, not a failed push", () => {
    const throwing = () => {
      throw new Error("AuthConfigMissingEnvironmentVariable: CLERK_JWT_ISSUER_DOMAIN");
    };
    expect(readIssuer(throwing)).toBeUndefined();
    expect(clerkProviders(readIssuer(throwing))).toEqual([]);
    expect(readIssuer(() => ISSUER)).toBe(ISSUER);
  });

  it("the exported config loads with the variable unset", () => {
    expect(authConfig.providers).toEqual([]);
  });

  it("has no provider (nobody can sign in) when the issuer is unset", () => {
    expect(clerkProviders(undefined)).toEqual([]);
    expect(clerkProviders("  ")).toEqual([]);
  });
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    approved: await ctx.db.insert("users", {
      tokenIdentifier: `${UNLINKED_PREFIX}guardian`,
      role: "family",
      displayName: "Pat Example",
    }),
    other: await ctx.db.insert("users", {
      tokenIdentifier: `${UNLINKED_PREFIX}other`,
      role: "family",
      displayName: "Lee Example",
    }),
  }));
  return { t, ...ids };
}

describe("users.linkIdentity", () => {
  it("a signed-in Clerk identity is signed out to the app until an approved account is linked", async () => {
    const { t, approved } = await setup();
    const asClerkUser = t.withIdentity(CLERK_IDENTITY);
    expect(await asClerkUser.query(api.tracking.myAssignments, {})).toMatchObject({
      status: "access_unavailable",
      reason: "unauthenticated",
    });
    await t.mutation(internal.users.linkIdentity, {
      userId: approved,
      tokenIdentifier: CLERK_IDENTITY.tokenIdentifier,
    });
    expect(await asClerkUser.query(api.tracking.myAssignments, {})).toMatchObject({
      status: "ready",
      assignments: [],
    });
  });

  it("is idempotent for the same identity", async () => {
    const { t, approved } = await setup();
    const args = { userId: approved, tokenIdentifier: CLERK_IDENTITY.tokenIdentifier };
    expect(await t.mutation(internal.users.linkIdentity, args)).toEqual({ userId: approved, changed: true });
    expect(await t.mutation(internal.users.linkIdentity, args)).toEqual({ userId: approved, changed: false });
  });

  it("refuses to give one identity to two people", async () => {
    const { t, approved, other } = await setup();
    await t.mutation(internal.users.linkIdentity, {
      userId: approved,
      tokenIdentifier: CLERK_IDENTITY.tokenIdentifier,
    });
    await expect(
      t.mutation(internal.users.linkIdentity, { userId: other, tokenIdentifier: CLERK_IDENTITY.tokenIdentifier }),
    ).rejects.toThrow(/IDENTITY_ALREADY_LINKED/);
  });

  it("never re-points an account that is already linked", async () => {
    const { t, approved } = await setup();
    await t.mutation(internal.users.linkIdentity, {
      userId: approved,
      tokenIdentifier: CLERK_IDENTITY.tokenIdentifier,
    });
    await expect(
      t.mutation(internal.users.linkIdentity, {
        userId: approved,
        tokenIdentifier: `${ISSUER}|user_someone_else`,
      }),
    ).rejects.toThrow(/USER_ALREADY_LINKED/);
  });

  it("rejects a value that is not a Convex identity", async () => {
    const { t, approved } = await setup();
    await expect(
      t.mutation(internal.users.linkIdentity, { userId: approved, tokenIdentifier: "user_fictional01" }),
    ).rejects.toThrow(/INVALID_TOKEN_IDENTIFIER/);
  });
});
