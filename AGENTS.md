# AGENTS.md — ITSSB contributor and agent contract

Rules for anyone changing this repository, people and coding agents alike.
`CLAUDE.md` imports this file.

## Mission

ITSSB (Intelligence Transportation System for School Buses) gives authorized
students and guardians honest, current bus information. The full specification
is in [`docs/`](docs/README.md). **Information quality is part of the product:**
an old position keeps its age, an estimate keeps its generation time, and a
check-in keeps its source. Never hide a failure behind a "live" looking UI.

---

# Critical rules

## Shared contracts change together
[`docs/08_DATA_CONTRACTS_AND_API.md`](docs/08_DATA_CONTRACTS_AND_API.md) is the
authority for every field that crosses a boundary (Pi ↔ backend ↔ iOS/web).
If you change a shared field, update **in the same change**:

1. `docs/08_DATA_CONTRACTS_AND_API.md`
2. `packages/contracts` (TypeScript types and fixtures)
3. `apps/backend` (Convex validators)
4. `apps/device` (Python models)
5. `apps/ios` (Swift DTOs)

Wire conventions: opaque string IDs (`runId`, `eventId`), UTC epoch
milliseconds with an `Ms` suffix (`capturedAtMs`), run states
`scheduled | active | completed | cancelled`. GPS, network and freshness are
separate attributes, never run states.

## Secrets and student data
- Never commit API keys, tokens, device credentials, signing files, `.env`
  files with real values, or real student names/addresses/locations.
- Commit `*.example` files with obviously fake values instead.
- Fixtures use fictional people and places only.
- The iOS app never holds a backend admin key. The Pi's device secret lives in
  `/etc/itssb/device.env` (root-owned, mode 0600), never in this repo.
- Authorization happens on the server, in every Convex function. A display
  number or name is never a credential.

## Git workflow
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
  with an optional scope (`feat(device): ...`).
- **Stage only the paths you changed.** Never `git add .` or `git add -A`;
  another session or contributor may have unfinished work in the tree.
- Work on a branch and open a pull request; `main` is protected by CI.
- Before deleting files in bulk, list them and get approval.

## Verify, don't assume
Do not call a change done because it "should work". Run the checks for every
area you touched (see below) and report what you ran. If you could not run
something (no Pi, no device, no Convex login), say so explicitly.

## Keep changes focused
Change what the task asks for. Don't reshape unrelated UI, rename unrelated
symbols, or reformat files you did not otherwise touch.

---

# Repository map

```
apps/
├── backend/    Convex functions, schema, auth (TypeScript)
├── device/     Raspberry Pi service: GPSD reader, SQLite outbox, local API (Python)
├── driver-ui/  Pi touchscreen UI, built to static files served by the device
├── ios/        SwiftUI + MapKit app (XcodeGen project.yml)
└── web/        Staff + family/Android web
packages/
├── contracts/  Shared wire types and canonical fixtures
└── ui/         Shared web components and design tokens
docs/           Specification (start at docs/README.md)
```

Non-JS apps (`device`, `ios`) have a small `package.json` whose scripts call
their native tools, so `bun run check` drives everything through Turborepo.

# Checks by area

| Area | Command (from repo root unless noted) |
|---|---|
| All TypeScript | `bun run check` (lint + typecheck + test via Turbo, skips iOS) |
| Backend | `bun --filter @itssb/backend test` |
| Device | `cd apps/device && uv run ruff check && uv run pytest` |
| iOS lint | `swiftlint lint` |
| iOS build/test | `cd apps/ios && xcodegen && bun run test` |

# Conventions

## TypeScript
- Strict mode everywhere (`tsconfig.base.json`). No `any` without a comment
  explaining why.
- Import shared types from `@itssb/contracts`; don't redeclare wire shapes.
- Convex: validate every argument with `v.*`, resolve the caller with
  `requireUser`/`requireDevice` before reading protected data.

## Python (device)
- Python ≥ 3.11 (the Pi's OS), `uv` for environments, `ruff` for lint/format,
  `pytest` for tests.
- Persist an outbound observation and its queue entry in one SQLite
  transaction. Generate `eventId` once, before upload; retries reuse it.
- The local API binds to `127.0.0.1` only.

## Swift (iOS)
- SwiftUI + `@Observable` view models, iOS 17+.
- **Never hardcode colors, fonts, spacing, or radii.** Use `AppColors`,
  `AppFonts`, `AppSpacing`, `AppRadius` from the `ITSSBDesignSystem` package.
- Convert epoch milliseconds to `Date` explicitly (`ms / 1000`).
- Secrets go in `Config/Secrets.xcconfig` (gitignored), copied from
  `Secrets.example.xcconfig`.
- Tests must not reach the network. CI points every endpoint at
  `127.0.0.1:1`, so a test that forgets to mock fails fast instead of hanging.

## Checklist before opening a PR
- [ ] Checks for every touched area pass locally
- [ ] Shared-field changes updated all five places listed above
- [ ] No secrets, real student data, or large binaries added
- [ ] Docs updated if behavior changed
