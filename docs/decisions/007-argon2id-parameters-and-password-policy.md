# 007 — argon2id parameters and password policy

**Status:** accepted
**Date:** 2026-08-08

## Context

Phase 1 authenticates with a username and a password and nothing else. That is
acceptable because a password is no longer the only factor — Phase 3 shipped TOTP and
passkeys in full. Until then the password hash is the single thing standing
between anyone already on the network and the household's complete financial
position, so its parameters are worth stating explicitly rather than leaving to a
library default.

## Decision

**argon2id**, with the OWASP Password Storage Cheat Sheet's baseline: 19 MiB of
memory, two passes, one lane.

Memory cost is what makes GPU cracking expensive, and it is the parameter worth
spending on. 19 MiB per verification is comfortable on a 6 GB NAS that
authenticates two people a handful of times a day, and it stays comfortable
alongside Postgres and the existing Sure container.

**Length is the only password rule**: at least 12 characters, at most 128.

Composition rules — an uppercase, a digit, a symbol — push people towards
predictable substitutions like `P@ssw0rd!` and are explicitly discouraged by NIST
SP 800-63B. A long passphrase is stronger and easier to type. The upper bound is
not a security limit but a denial-of-service one: argon2 hashes the entire input,
so an unbounded password on an unauthenticated route is unbounded work for the
server, and the bound is applied before argon2 ever sees the string.

## Consequences

- A stolen database is expensive to attack offline, which is the threat that
  matters most for a self-hosted application whose backups leave the device.
- Login costs roughly 50 ms of CPU. That is deliberate and is what makes the
  timing defence below necessary rather than optional.
- **User enumeration is defended at the same time.** A missing username returns
  in microseconds while a real one pays the full 50 ms, and that difference alone
  reveals which usernames exist. Every failed lookup therefore verifies against a
  real argon2id hash of a value nobody knows, so both paths cost the same.
- Rate limiting is _not_ in place. It is a Phase 3 deliverable, and until then
  nothing throttles password guessing beyond the cost of a hash. This is
  survivable only while access requires being on the LAN, and it is the single
  strongest reason not to expose this application before Phase 3 completes.
