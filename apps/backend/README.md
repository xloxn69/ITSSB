# apps/backend — Convex

Shared database, authorization, and device ingestion. Spec:
[docs/07](../../docs/07_BACKEND_AND_DATABASE.md) and
[docs/08](../../docs/08_DATA_CONTRACTS_AND_API.md).

## What's here now

| File | Does |
|---|---|
| `convex/schema.ts` | Users, devices, runs, telemetry history, live state, audit log |
| `convex/http.ts` | `POST /device/v1/telemetry` with bearer auth, size/version checks |
| `convex/telemetry.ts` | Idempotent per-event ingestion; late data kept as history only |
| `convex/runs.ts` | `runs.live` query; returns null for unknown *and* forbidden runs |
| `convex/lib/authz.ts` | `getUser` / `requireUser` / `canViewRun`, the one place access rules live |
| `convex/lib/deviceAuth.ts` | Device secrets are stored only as SHA-256 hashes |

Still to build: online run start/end (`/device/v1/trip-events`), health,
family links and assignments, enrollment, alerts.

## Develop

```sh
bunx convex dev     # first run: log in (or run locally) and create your own dev deployment
bun run test        # convex-test, no deployment needed
```

`convex/_generated/` is committed (as Convex recommends) so CI and fresh
clones can typecheck without a deployment. `convex dev` regenerates it.

## Sign-in

No identity provider is configured yet (open decision, docs/17 §5), so no
person can sign in and every user query returns nothing. That is intentional,
since it fails closed. When a provider is chosen, add `convex/auth.config.ts`
reading `AUTH_ISSUER_URL` / `AUTH_APPLICATION_ID`, and set those with
`bunx convex env set`.
