# Runbook: cut and identify a release

Owner-run steps for [docs/14 §1, §2, §6 and §7](../14_DEPLOYMENT_AND_OPERATIONS.md).
A release is one commit on `main`, built and deployed with the same name
everywhere, so any screen, Pi or log line can be traced to exact source.

## 1. Name and manifest

From a clean checkout of the commit on `main`:

```sh
git checkout main && git pull
node scripts/release-manifest.mjs --environment development --out /tmp/release.json
```

The manifest refuses an uncommitted tree. It records the release name
(`<UTC date>-<7-char commit>`, for example `2026.11.27-b0dad42`), the full
commit, the contract `schemaVersion`, the device database schema version,
every component version, and SHA-256 hashes of `bun.lock` and
`apps/device/uv.lock`. Attach it to the GitHub release (step 5); do not commit
it.

## 2. Configuration per environment

| Part | Development | Staging | Production |
|---|---|---|---|
| Convex | the dev deployment (`bunx convex dev`) | a separate deployment | the production deployment (`bunx convex deploy`, owner only) |
| Backend variables | `ITSSB_ENVIRONMENT=development`, `ITSSB_ALLOW_DEV_SEED=true` | `ITSSB_ENVIRONMENT=staging` | `ITSSB_ENVIRONMENT=production`, never `ITSSB_ALLOW_DEV_SEED` |
| Clerk | development instance | development instance | production instance |
| Web build | `VITE_ITSSB_ENVIRONMENT=development` | `staging` | `production` |
| Pi | `/etc/itssb/device.env` points at the dev `.convex.site` | its own credential | its own credential |

A device credential, Clerk key, or Convex URL is never shared between
environments. The web app shows a **Development** or **Staging** badge unless
built with `production`; a missing or unknown value counts as development.

## 3. Build and stamp each part

```sh
REL=$(node -p 'require("/tmp/release.json").release')
REV=$(git rev-parse HEAD)
```

- **Backend:** record the release on the target deployment, then push code.
  Development: `bunx convex env set ITSSB_RELEASE "$REL"` then `bunx convex dev --once`.
  Production is owner-only and follows §6 below.
- **Web:** `VITE_ITSSB_ENVIRONMENT=<env> VITE_ITSSB_RELEASE=$REL VITE_ITSSB_REVISION=$REV bun run --cwd apps/web build`.
  Hover the environment badge to see the release and commit.
- **iOS:** bump `CURRENT_PROJECT_VERSION` (and `MARKETING_VERSION` for a
  user-visible change) in `apps/ios/project.yml` in the release PR. The app
  does not yet carry its environment and commit; until it does, record the
  commit in the TestFlight build notes.
- **Pi:** `itssb_release.py stage . --version "$REL" --revision "$REV"`
  ([Pi runbook](pi-update-and-rollback.md)). Health then reports
  `process.release.version`.

## 4. Backend release checklist

Before pushing backend code to any shared deployment:

- [ ] `bun run check` passes on the commit.
- [ ] Schema changes are additive: new fields optional, no field an existing
      document lacks is required ([docs/14 §6](../14_DEPLOYMENT_AND_OPERATIONS.md)).
- [ ] Authorization tests, telemetry replay, null/stale GPS, start/end
      idempotence, and access denial tests are in the passing suite.
- [ ] A backup of the target was taken ([Convex backup runbook](convex-backup-restore.md)).
- [ ] Older Pis and installed iOS builds still decode every response
      (`docs/08` additive-only rule).

## 5. Tag and release notes

```sh
git tag -a "release/$REL" -m "Release $REL" "$REV"
git push origin "release/$REL"
gh release create "release/$REL" /tmp/release.json --title "$REL" --notes-file notes.md
```

`notes.md` follows this template; keep every heading and write "None" where
nothing applies:

```markdown
## Release <name>

Commit: <full sha>. Contract schemaVersion: <n>. Device DB schema: <n>.

### What changed
- <one line per user-visible change, with PR number>

### Compatibility
- Oldest Pi release that keeps working: <name>
- Oldest iOS build that keeps working: <version (build)>
- Device database migrations in this release: <none | additive | not readable by older code>

### Known limitations
- <offline behaviour, notification behaviour, anything not yet supported>

### Rollback
- Pi: `itssb_release.py rollback` to <previous name>.
- Backend: redeploy <previous name>; data restore only by the Convex runbook.
```

## 6. Production (owner only)

Agents never run `convex deploy` and never touch production. The owner
deploys with the production deploy key after the checklist in §4, sets
`ITSSB_RELEASE` and `ITSSB_ENVIRONMENT=production` on the production
deployment, and records the release in the GitHub release notes.
