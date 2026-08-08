# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are tagged per
phase (`v0.1.0-phase1`, and so on).

## [Unreleased]

### Added

- Repository scaffold: npm workspaces, TypeScript project references, type-aware
  ESLint, Prettier, Vitest with separate unit and integration projects, and CI.
- `@budget/shared`: integer-cent money primitives (parsing, formatting, even and
  weighted distribution, JSON serialization), the budget identity and its
  labelling, and the domain vocabulary shared with the UI.
- PostgreSQL schema covering accounts, groupings, delegations, the delegation
  event ledger, delegate runs, envelope transfers, transactions and allocations,
  auto-categorization rules, users and sessions, sync runs, valuations, Bitcoin
  price history and settings.
- Hand-written integrity migration: case-insensitive partial unique indexes on
  live names, and check constraints the database enforces itself.
- Domain services: the event ledger with transactional cached balances, Delegate
  with preview and 12-hour undo, envelope transfers, manual adjustment,
  categorization and splits, pending reconciliation and reversal, archiving rules,
  and go-live reconciliation.
- `recompute-balances` CLI, with a read-only `--check` mode used by CI.
- 116 tests, including integration tests against a real PostgreSQL asserting the
  identity behaves correctly after delegate, undo, transfer, adjust, categorize,
  split, pending appearing, pending vanishing and archiving.
- Documentation: architecture, eight ADRs, phase-gated open questions.
- CI check rejecting the forbidden terminology for the Bitcoin asset class.
- Fastify application: validated environment configuration, structured logging
  with a correlation id per request and redaction of credentials, a domain-to-HTTP
  error mapping, a health check, and graceful shutdown on SIGTERM.
- Authentication: argon2id password hashing, PostgreSQL-backed sessions, first-run
  Super Admin creation, login and logout, forced password change on first login,
  and session id rotation on login and password change.
- User management for Admins: create, rename, change role, reset password,
  archive and restore, with Super Admin immunity enforced in the domain layer.
- 43 further integration tests covering session fixation, user enumeration, the
  temporary-password lockout, Super Admin immunity, and session revocation on
  archive and password reset.

### Fixed

- Integration test files ran concurrently against one database despite
  `fileParallelism: false`, which is a root-level Vitest option and is ignored
  inside a project. Replaced with a single fork for that project.
