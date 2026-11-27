# apps/backend — Convex

Shared database, authorization, and device ingestion. Spec:
[docs/07](../../docs/07_BACKEND_AND_DATABASE.md) and
[docs/08](../../docs/08_DATA_CONTRACTS_AND_API.md).

## What's here now

| File | Does |
|---|---|
| `convex/schema.ts` | Users, devices, runs, telemetry history, live state, audit log |
| `convex/http.ts` | `POST /device/v1/telemetry` and `POST /device/v1/trip-events` with bearer auth, size/version checks |
| `convex/tripEvents.ts` | Idempotent online run start/end, driver grant and scope checks, one active run per device and route |
| `convex/driverGrants.ts` | Issue/revoke driver operating grants (hash stored, scoped, expiring) |
| `convex/telemetry.ts` | Idempotent per-event ingestion; late data kept as history only, including bounded history after a run ends |
| `convex/runs.ts` | `runs.live` query (staff, the assigned student, or an approved guardian); returns null for unknown *and* forbidden runs |
| `convex/tracking.ts` | Family queries `myAssignments`, `myRun`, `myRoute` (docs/08 §8), checked against the shared fixtures |
| `convex/lib/authz.ts` | `getUser` / `requireUser` / `canViewRun`, the one place access rules live |
| `convex/lib/deviceAuth.ts` | Device secrets are stored only as SHA-256 hashes |
| `convex/auth.config.ts` | Clerk sign-in; issuer from `CLERK_JWT_ISSUER_DOMAIN` |
| `convex/users.ts` | `linkIdentity`: attach a verified identity to an approved person |

Still to build: driver sign-in on the Pi (`/device/v1/driver-session`), health,
enrollment (creating assignments and guardian links), route progress, ETA, alerts.

## Develop

```sh
bunx convex dev     # first run: log in (or run locally) and create your own dev deployment
bun run test        # convex-test, no deployment needed
```

`convex/_generated/` is committed (as Convex recommends) so CI and fresh
clones can typecheck without a deployment. `convex dev` regenerates it.

## Sign-in (Clerk)

People sign in with Clerk (decision in docs/17 §8). Convex verifies Clerk's
token; `convex/auth.config.ts` reads the issuer from the deployment variable
`CLERK_JWT_ISSUER_DOMAIN`. Until it is set, nobody can sign in and every
person-facing query answers as signed out.

Signing in grants nothing by itself. A person sees data only after their
verified identity is linked to an approved `users` row
(`users:linkIdentity`), and then only what their assignments and guardian
links allow.

### Owner steps (one time per deployment)

1. **Dev deployment.** In this folder run `bunx convex dev` and pick or create
   a *development* deployment. It writes `.env.local` (gitignored). Never
   point these steps at production.
2. **Clerk application.** In the Clerk dashboard create an application with
   *Email code* sign-in. Under *Configure → JWT templates* add the **Convex**
   template and keep its name `convex`. Copy the **Issuer** (the Frontend API
   URL, `https://<name>.clerk.accounts.dev`).
3. **Issuer on Convex.** `bunx convex env set CLERK_JWT_ISSUER_DOMAIN <issuer>`.
   `bunx convex dev` then pushes the auth config.
4. **Client keys.** The Clerk *publishable* key goes into the iOS and web app
   configuration (owned by those apps). The Clerk *secret* key is not needed
   by this backend; never commit it or put it in an app.
5. **Link an account.** Sign in once from a client, read the user ID from the
   Clerk dashboard, then link it to an approved person:
   `bunx convex run users:linkIdentity '{"userId":"<users id>","tokenIdentifier":"<issuer>|<Clerk user id>"}'`.
