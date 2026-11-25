# Contributing to ITSSB

Thanks for helping! This is a student project, so clear questions and small
pull requests are very welcome.

## Ground rules

- Be kind. See the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Never include real student data** (names, addresses, locations, photos) in
  issues, pull requests, fixtures, or screenshots. Use fictional data.
- Report security or privacy problems privately. See [SECURITY.md](SECURITY.md).

## Workflow

1. Open or pick an issue so work isn't duplicated.
2. Create a branch: `feat/short-name`, `fix/short-name`, `docs/short-name`.
3. Make a focused change and run the checks for the areas you touched
   (table in [AGENTS.md](AGENTS.md#checks-by-area)).
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(device): persist observation and outbox row together`.
5. Open a pull request and fill in the template.

## Changing a shared field

Wire fields (anything the Pi, backend, and apps exchange) are defined in
[docs/08_DATA_CONTRACTS_AND_API.md](docs/08_DATA_CONTRACTS_AND_API.md).
A change there must update the contracts package, backend validators, device
models, and Swift DTOs in the same PR.

## Development setup

See the [README](README.md#getting-started).
