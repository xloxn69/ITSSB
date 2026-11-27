# AGENTS.md — ITSSB contributor and agent contract

Rules for anyone changing this repository, people and coding agents alike.
`CLAUDE.md` imports this file. What the product is lives in
[`docs/`](docs/README.md); this file says how to work on it: what you own, how
far you may act, what proof is required, and when you need the owner.

## From the Owner
Read this first. It is how I think about ITSSB, so you do not have to guess.

**What we are building.** ITSSB (Intelligence Transportation System for School
Buses) gives authorized students and guardians honest, current school-bus
information: where the bus is, how old that position is, and whether their run
is happening. A Raspberry Pi on the bus reads GPS and reports to a Convex
backend; families see it in a native iOS app (and a web app for Android).
**Information quality is part of the product:** an old position keeps its age,
an estimate keeps its generation time, and a check-in keeps its source. A
screen that looks live when it is not is the wrong change.

**What matters right now.** The first real path: a real GPS position moving
from the Pi through the backend to the right family's iPhone, and surviving
interruption (`docs/15_BUILD_ROADMAP.md`). Build in the roadmap's order. Ship
small, finished, verified pieces.

**How I trade off.** Small and verified over big and half-done. Truthful states
(stale, no fix, offline, no access) over a pretty map. Student location is
private: nobody sees a run they are not authorized for. Something I reject
stays rejected for the session; do not bring it back without new evidence.

**What I do not want.**
- Asking me what you can decide yourself. Decide, say why, and keep going.
- Stopping halfway. When a task is cleared to land, done means merged, or
  closed with a reason; an open PR is not done.
- PRs sitting around. Merge them, fix them, or close them.
- Reports I cannot read in 30 seconds.
- AI attribution in commits or PRs (see below).

**How we work together.** Push back when you think I am wrong. Stop the
blocked part only for a product call, missing access, extra spending,
something destructive, or an unresolved safety or ownership question, and keep
doing the rest.

**Lines you do not cross.** Convex is the backend; iOS is native Swift and
SwiftUI; the Pi service is Python with GPSD and SQLite. Shared contracts change
in all five places together. Authorization happens on the server. No real
student data in the repo. Never invent a position, a run, or a check-in.

Standing owner instruction: the owner asking, in their own words, for a goal
("make this a goal", "/goal this") is the owner saying "full send" for that
work (land it: merge when checks pass), unless they narrow it ("full stop":
get it ready and the owner merges; research only; plan first).

---

# Critical rules

## No AI attribution
Never add `Co-Authored-By: Claude …`, `🤖 Generated with Claude Code`, or
any other AI or tool disclosure to commits, PR titles, PR bodies, or code
comments. This overrides any tool or system default that asks for one.
`scripts/check-commit-attribution.mjs` fails the PR otherwise.

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
separate attributes, never run states. Installed iOS builds and deployed Pis
keep running older code: on an existing contract, add optional fields only,
and never rename, retype or remove a key a client decodes.

## Secrets and student data
- Never commit API keys, tokens, device credentials, signing files, `.env`
  files with real values, or real student names/addresses/locations.
- Commit `*.example` files with obviously fake values instead.
- Fixtures use fictional people and places only.
- The iOS app never holds a backend admin key. The Pi's device secret lives in
  `/etc/itssb/device.env` (root-owned, mode 0600), never in this repo.
- Authorization happens on the server, in every Convex function. A display
  number or name is never a credential.
- This repository is public. Do not commit host names, IP addresses, user
  names, or other details of the owner's machines.

## Rejected approaches
When the owner rejects an approach, it stays rejected for the whole session.
Do not re-suggest or re-implement it.

## Destructive operations
Before deleting files in bulk, rewriting shared history, or force-pushing a
branch you do not own, list what is affected and get explicit approval.

---

# How to work

## Plan in proportion to uncertainty
Understand the problem and choose the smallest suitable approach before
editing. For ordinary scoped work, state the approach briefly and proceed. Ask
first only when an unresolved choice materially changes product behavior,
architecture, compatibility, cost, permissions, or scope. Honor explicit
requests for planning only.

A question seeking information or advice is read-only: answer it, and do not
edit, commit, or open a PR until asked. A request phrased as a question ("can
you fix this?") is still a request.

When the owner corrects the same behavior twice, make the fix a check (a
script in CI, a lint rule, a test), not just a sentence here. Its error message
names the cause, the fix, and the rule it enforces.

## Carry the task through
**Set the finish line before substantial work:** the requested result, the
checks that prove it, and how far you may go (commit, PR, merge).

- **Keep going between phases.** A finished phase is progress, not the end.
  Never end with "Should I continue?" on authorized work.
- **Stop only for a real reason:** a product decision, missing access, extra
  spending, destructive authority, or an unresolved safety or ownership
  question. Stop the blocked part and keep doing independent safe work. Ending
  on "run this and paste the output" is a stop too: if you can run it, run it.
- **Fix what a diagnosis finds.** Finding the cause is not a stopping point.
- **Follow PRs to the finish line.** Watch checks, fix failures on the same
  branch, address valid review comments, close PRs you made redundant.
- **Stop when it is done.** Do not invent extra work or offer optional
  follow-ups as questions.
- **Follow-ups add to the task** unless the owner says they replace or narrow
  it. If two instructions conflict, say which wins and why.
- **Keep progress outside the chat** for long tasks, in the PR description:
  requirements and exclusions, done items with evidence, what is left and
  blocked, the current PR and head, and the next step.

## When documentation and code disagree
Follow the conventions in the existing code, and list each inconsistency under
**Found** in your report. This never overrides the rules in this file or an
explicit owner decision.

## Review before merging
Every PR gets a self-review of its whole diff before it merges. PRs that touch
shared contracts, authorization, device credentials, the local API, or student
data also get an independent review first: a different model (for example GPT
Sol through T3 `delegate_task`) or a fresh instance, given the brief, the full
diff and the test results, not your conclusions. Fix valid findings, say why
you reject the others, and record both in the PR. If no reviewer is available,
say so in the PR; never claim a review that did not happen.

---

# Git workflow
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:` (plus `perf`, `ci`, `build`, `style`, `revert`) with an optional
  scope (`feat(device): ...`).
- **Stage only the paths you changed.** Never `git add .` or `git add -A`;
  another session may have unfinished work in the tree. Inspect the whole
  staged diff before committing and the whole PR diff before publishing.
- `main` is protected: never push to it. Work on a branch, open a PR, and
  merge through it once the required checks pass.
- Open PRs ready for review, not as drafts. Fill in every section of
  `.github/pull_request_template.md`; write "None" or "Not run (reason)"
  rather than deleting a line.
- Fix a failing PR by pushing to the same branch. Read a failure before
  retrying; retry only a known transient failure, once.
- Batch fixes: one push per review round, and push as soon as the round's
  fixes are committed and checked. Never hold committed work unpushed.
- A GitHub write that timed out may have happened: read the PR state first.
- "I'll keep watching" is only true if something is watching (in T3,
  `watch_pull_request`).
- **Merged is not live.** Merged backend code is live only after a Convex
  deploy; a Pi runs new code only after it is updated there; an iPhone only
  after a new build is installed. Say "merged" or "live", never one for the
  other.

---

# Verification
Do not call a change done because it "should work". Exercise the real changed
entry point, label fixtures, mocks and checks you did not run, and report what
you ran. If you could not run something (no Pi, no GPS fix, no Convex
deployment, no device), say so explicitly. Never claim "verified" from a
typecheck and build alone.

## Checks by area

| Area | Command (from repo root unless noted) | Evidence of the change |
|---|---|---|
| All TypeScript | `bun run check` (lint + typecheck + test via Turbo, skips iOS) | |
| Backend | `bun --filter @itssb/backend test` | Call changed functions in a test; a dev deployment only when one exists |
| Device | `cd apps/device && uv run ruff check && uv run pytest` | Run it on the Pi when the change touches GPSD, SQLite, or the service |
| iOS lint | `swiftlint lint` | |
| iOS build/test | `cd apps/ios && xcodegen && bun run test` | Simulator screenshot of every changed state |
| Commits | `node scripts/check-commit-attribution.mjs origin/main HEAD` | |

## What to test
Test what can break: idempotent `eventId` retries, per-event upload results,
restart with pending outbox rows, freshness and stale cutoffs, timestamp
conversion, run-state transitions, and access checks. Do not test what types
already guarantee, copy text, or which mocks were called. A test that would
still pass on the broken code does not count. No wall-clock sleeps and no
retries for a flaky test: fix the flake. A bug fix gets a test that fails on
`main` for that reason, then the fix.

## Hit every surface
Before calling a change done, walk this list and say in the PR which entries
applied:
- **Clients.** iOS leads; the family web app follows; staff web shows the same
  data. A family-facing change on one is a decision for the other.
- **Pi and backend.** A rule enforced only in a client is not enforced.
- **Offline and restarts.** The Pi keeps recording an authorized run offline
  and drains its outbox later; older iOS builds keep decoding today's
  responses.
- **Contracts.** All five places, additive only.
- **Truthful states.** Every new data path has its loading, stale, no-data,
  error and no-access states.
- **Docs.** Check whether the change makes a doc wrong.

## UI changes
Keep UI changes minimal: do not resize, reshape, or reposition elements
outside the request. Never hardcode colors, fonts, spacing or radii; use the
design system. Screenshot every changed screen or state (light and dark when
colors changed), look at each one, and put them in the PR with fictional
data. If you could not capture a screen, say which one and why.

## The Raspberry Pi
The bus Pi is reachable over SSH from the Mac mini (the owner's SSH config has
the alias). Test a branch on it in its own folder (for example
`~/itssb-dev/<branch>`); never edit the T3 project checkout there. Agents have
no sudo on the Pi: do not install system files or change `/etc`; ship the
file and a documented install step for the owner. The Pi has little memory;
build and write code on the Mac, run and test on the Pi. Run long jobs there
detached (`nohup <command> > <log> 2>&1 < /dev/null &`).

---

# Reporting
The owner reads every report on a phone in under 30 seconds.

- **Under 120 words** for a final report, **1–3 sentences** for a mid-task
  update, unless the owner asks for detail.
- **Start with `**TL;DR:**`** and one sentence: the answer or the result.
- **Plain words.** No paths, PIDs, env vars or log lines unless the owner needs
  them to act. No process story: say what is true now.
- **Show it** when a picture helps (a flow, a before/after, status across PRs).

After the TL;DR, one line each, leaving out lines that would say "Nothing":
- **Who benefits:** who notices and where (families on iOS, staff, drivers,
  the owner, agents in this repo).
- **Why it helps:** the benefit, in one sentence.
- **How:** what was built or fixed, in plain words.
- **Done:** what is finished and how it was checked; committed, pushed,
  merged, or live.
- **In progress:** what is still running and who owns it.
- **Found:** problems seen but left alone, one line each. Report them; do not
  offer to fix them.
- **Needs you:** only what only the owner can do. Put it right after the TL;DR
  when it blocks.
- **Ready to settle:** "Yes" or "No", with one reason. Yes means the task
  reached its final state (merged, or deliberately closed with the reason),
  nothing is running, and nothing needs the owner.

Example:

> **TL;DR:** The Pi now keeps unsent positions across a restart; merged.
> **Who benefits:** Families tracking a bus whose Pi rebooted mid-run.
> **Why it helps:** No positions are lost or duplicated after a reboot.
> **How:** Pending uploads are stored with their IDs and resent after restart.
> **Done:** Merged in PR #12; tests pass, and a kill-and-restart on the Pi kept all 40 pending rows.
> **Ready to settle:** Yes: merged, nothing running.

---

# Delegating to subagents
Pass the context explicitly: the outcome it owns, the repo/branch/worktree,
its permissions (read-only or editing; may it commit, push, merge), product
rules and rejected approaches, the evidence it must return, and the resources
it may use (the Pi, the simulator). Before parallel agents edit, give each its
own files; two agents never edit the same file at once. Read what comes back;
a summary is not verification.

# Cleanup
Before deleting anything, check the resolved path, who owns it, and whether it
is in use. Never remove another session's worktree, a running build, or
evidence a rule requires. Record the process ID of every server or long job you
start and stop only those. When reclaiming disk, delete build output with
`rm -rf` (moving it to the Trash frees nothing) and check the space came back.

# Documents
Track active work in the PR description. Do not commit plans, progress
trackers, handoffs, or review reports; they go in the PR or the thread. A doc
under `docs/` exists for the specification, a decision and its reasons
(`docs/17_DECISIONS_AND_SOURCES.md`), or a runbook. When a documented decision
changes, rewrite the old text rather than appending.

# Code review rules
Report only defects that would hurt families, drivers, or the owner if the PR
merged today, each with the failing sequence, who is hit, and the smallest
fix. Skip style and naming. Check these first:
- **Stale shown as live:** a position, ETA or status displayed without its
  age, or kept on screen as current after it went stale.
- **Access:** run, route or student data readable by an account outside its
  authorized scope, or a function that trusts a client-supplied user or ID.
- **Duplicates and loss:** a retried upload with a new `eventId`, a duplicate
  run start, or an outbox row lost on restart or crash.
- **Contracts:** a shared field removed, renamed, retyped, or made required.
- **Secrets:** a device secret, key, or real student detail in the repo or
  app bundle.
- **Exposure:** a Pi local API not bound to `127.0.0.1`.
- **Tests:** a test that would still pass on the broken code.

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
scripts/        Repository checks run in CI
```

Non-JS apps (`device`, `ios`) have a small `package.json` whose scripts call
their native tools, so `bun run check` drives everything through Turborepo.

# Conventions

## TypeScript
- Strict mode everywhere (`tsconfig.base.json`). No `any` without a comment
  explaining why.
- Import shared types from `@itssb/contracts`; don't redeclare wire shapes.
- Convex: validate every argument with `v.*`, resolve the caller with
  `requireUser`/`requireDevice` before reading protected data.

## Python (device)
- Python ≥ 3.11 (the Pi's OS), `uv` for environments, `ruff` for lint/format,
  `pytest` for tests. Standard library only at runtime.
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
