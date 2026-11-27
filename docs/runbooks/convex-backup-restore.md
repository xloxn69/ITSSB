# Runbook: back up and restore Convex data

Owner-run steps for [docs/14 §8](../14_DEPLOYMENT_AND_OPERATIONS.md). Uses the
free CLI snapshot export and import; no paid backup feature is assumed.

A snapshot holds table data only. It does **not** hold code, environment
variables (`CLERK_JWT_ISSUER_DOMAIN`, `ITSSB_*`), scheduled functions, or the
Clerk and Pi configuration. Keep those in the release notes and the secret
inventory.

## Back up

From `apps/backend`, with `.env.local` pointing at the deployment to back up:

```sh
bunx convex export --path ~/itssb-backups/<deployment>-$(date -u +%Y%m%dT%H%M%SZ).zip
python3 -I ../../scripts/convex_snapshot.py counts ~/itssb-backups/<file>.zip
```

For production, add `--prod` (owner only). The zip holds every record,
including student and guardian data in production: keep it on storage you
control, never in this repository or a shared folder, and delete it when the
retention period ends ([docs/11 §9](../11_SECURITY_PRIVACY_AND_ACCESS.md)).

## Rehearse a restore in an isolated target

Never rehearse by importing into a shared deployment: `import --replace-all`
replaces its data. Restore into a local deployment instead:

```sh
W=$(mktemp -d)
git archive HEAD apps/backend packages/contracts package.json bun.lock tsconfig.base.json | tar -x -C "$W"
cd "$W" && bun install --frozen-lockfile && cd apps/backend
CONVEX_AGENT_MODE=anonymous bunx convex dev --once          # local backend, schema + functions
CONVEX_AGENT_MODE=anonymous bunx convex dev &               # keep it running for import
CONVEX_AGENT_MODE=anonymous bunx convex import --replace-all -y <backup>.zip
CONVEX_AGENT_MODE=anonymous bunx convex export --path restored.zip
python3 -I <repo>/scripts/convex_snapshot.py compare <backup>.zip restored.zip   # must print MATCH
```

`compare` checks every table has the same document IDs and contents. Stop the
local backend afterwards and delete `$W`.

### Rehearsal record (development, fictional data)

2026-11-27, dev deployment exported, restored into an isolated local
deployment, exported again:

```text
table                before  after  result
assignments               1      1  same
auditLog                 14     14  same
devices                   1      1  same
driverGrants              2      2  same
guardianLinks             1      1  same
liveState                 3      3  same
routeDrafts               0      0  same
routeVersions             1      1  same
routes                    0      0  same
runs                      4      4  same
stops                     2      2  same
students                  1      1  same
telemetryEvents          20     20  same
users                     3      3  same
MATCH
```

The restored deployment resolved the device's credential hash to the same
device ID, so a restored Pi credential keeps working.

## Restore a real deployment (owner only)

1. Take a fresh backup of the target first; the restore replaces it.
2. `bunx convex import --replace-all <backup>.zip` (add `--prod` for production).
3. Reconcile before reopening access:
   - **Runs:** a run marked `active` in the snapshot may have ended since.
     Compare with each Pi's health and end or cancel it through the staff
     tools, never by editing data.
   - **Credentials and access:** re-apply every device revocation, guardian
     link revocation and role change made after the backup.
   - **Alerts:** once notifications exist, expire pending alerts; never replay
     them because the snapshot says they were pending.
4. Check environment variables are still set (`bunx convex env list`).
5. Telemetry accepted after the backup is gone: Pis only resend events they
   never got an acknowledgment for. Record the gap (backup time to restore
   time) in the incident notes; never invent positions to fill it.
