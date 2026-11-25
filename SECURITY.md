# Security policy

ITSSB is designed to handle sensitive information: children's home addresses,
school bus routes, and live vehicle locations. Please treat security and privacy
issues seriously and report them privately.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Include:

- what is affected (device, backend, iOS, web) and the commit or version
- steps to reproduce, using fictional data
- the impact you expect (e.g. "an unlinked account can read a run's position")

You should get an acknowledgement within 7 days.

## Scope

Especially in scope:
- reading a student's, route's, or bus's data without an authorized link
- a device or account writing data for a run it does not own
- credentials or personal data exposed in logs, builds, or the repository
- the Pi's local API being reachable from outside the device

## Supported versions

The project is pre-release. Only the `main` branch receives fixes.

## Deployment note

This software has not been through an independent security review and is not
approved for use with real student data. Anyone deploying it is responsible for
their school's privacy, data-retention, and safety requirements.
