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
| `convex/driverGrants.ts` | Driver operating grants (hash stored, scoped, expiring): staff issue, list and revoke them in the console; internal `issue`/`revoke` for the command line |
| `convex/telemetry.ts` | Idempotent per-event ingestion; late data kept as history only, including bounded history after a run ends |
| `convex/runs.ts` | `runs.live` query (staff, the assigned student, or an approved guardian); returns null for unknown *and* forbidden runs |
| `convex/tracking.ts` | Family queries `myAssignments`, `myRun`, `myRoute` (docs/08 §8), checked against the shared fixtures |
| `convex/routes.ts` | Staff route library and draft review: `list`, `listDrafts`, `getDraft`, `approveDraft`, `rejectDraft`; internal `recordDraft` (docs/08 §11) |
| `convex/fleet.ts` | Staff device and driver pages: `listDevices`, `setBusLabel`, `revokeDevice`, `listDrivers`, `addDriver` |
| `convex/staffInvitations.ts` | Staff invitations: staff create, list and revoke single-use codes; a new person redeems one to join as staff |
| `convex/lib/staff.ts` | `staffCaller`: the staff-role check every staff function runs first |
| `convex/lib/routeVersions.ts` | `approvedVersionForNewRun`: the approved version a new run pins |
| `convex/lib/authz.ts` | `getUser` / `requireUser` / `canViewRun`, the one place access rules live |
| `convex/lib/deviceAuth.ts` | Device secrets are stored only as SHA-256 hashes |
| `convex/auth.config.ts` | Clerk sign-in; issuer from `CLERK_JWT_ISSUER_DOMAIN` |
| `convex/seed.ts` | `seed:dev`: fictional route, driver, bus/device, student, guardian; dev deployments only |
| `convex/users.ts` | `bootstrapStaff`: the first staff account; `linkIdentity`: attach a verified identity to a person created ahead of sign-in |

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
verified identity is linked to an approved `users` row, and then only what
their role, assignments and guardian links allow. Families get that row when
staff approve their request; staff join with a staff invitation; the first
staff account comes from the one command-line step below.

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
5. **First staff account (the one command-line step).** Sign in once on the
   web app, read your user ID from the Clerk dashboard, then create the first
   staff account linked to it:
   `bunx convex run users:bootstrapStaff '{"tokenIdentifier":"<issuer>|<Clerk user id>","displayName":"<your name>"}'`.
   It refuses an identity that already has an account, and refuses once any
   staff account exists (a development deployment with `ITSSB_ALLOW_DEV_SEED`
   set may add one more, because its seeded staff row cannot sign in). Everything after that
   happens in the staff console (`#/staff/…`): invite other staff
   (`#/staff/team`; they redeem the code under "Join as staff"), add drivers
   and issue their grants (`#/staff/drivers`), and add devices.
6. **People created ahead of sign-in** (the dev seed's guardian or student):
   `bunx convex run users:linkIdentity '{"userId":"<users id>","tokenIdentifier":"<issuer>|<Clerk user id>"}'`.

## Dev seed (fictional data, development deployment only)

`seed:dev` creates one fictional route version with two stops, a driver, a
bus/device, a student with an approved assignment, and a guardian with an
approved link, and issues a 16-hour driver grant. It refuses to run unless
the deployment has `ITSSB_ALLOW_DEV_SEED=true`, and refuses a database that
already has data.

```sh
bunx convex env set ITSSB_ALLOW_DEV_SEED true   # dev deployment only
bunx convex run seed:dev
```

It prints the device secret and the driver grant **once** (only hashes are
stored). Put the secret in the Pi's `/etc/itssb/device.env` as
`ITSSB_DEVICE_TOKEN`, with `ITSSB_DEVICE_API_ORIGIN` set to the deployment's
`.convex.site` URL. Then link your Clerk sign-in to the seeded guardian or
student with `users:linkIdentity` (see "Owner steps" above, step 6). Issue a
fresh grant later in the staff console under Drivers.

### Rotate a device credential

The seed prints the device secret once. If it is lost, or a Pi needs a new
one, issue a replacement (the old secret stops working immediately; a revoked
device stays revoked):

```sh
bunx convex run devices:rotateCredential '{"deviceId":"<devices id>"}'
```

Put the printed secret in the Pi's `/etc/itssb/device.env` as
`ITSSB_DEVICE_TOKEN` and restart the service.
