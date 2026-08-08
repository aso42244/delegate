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
- SimpleFIN sync: hourly `node-cron` job and a manual sync endpoint, 12-month
  backfill on first run, idempotent re-runs keyed on the feed's transaction id,
  automatic discovery of new accounts flagged for review, and the full pending
  lifecycle — settling under the same or a new id, and reversal when a pending
  transaction vanishes.
- `simplefin:claim` CLI, exchanging a one-time setup token for the access URL.
- Sync run history with counts and errors, exposed at `/api/sync/status` to drive
  a persistent failure banner.
- Protocol parsing that accepts both SimpleFIN protocol versions, rejects
  sub-cent precision rather than rounding it, and refuses non-USD accounts with a
  visible reason.
- 34 further tests covering idempotency, the pending lifecycle, the request
  window, and the guarantee that the access URL never leaves the server.
- Auto-categorization rules: matching on description (contains, starts-with,
  regular expression), amount range, account and direction; priority ordering
  with first match winning; applied automatically to transactions a sync
  imports; reorder, enable, archive, and "always categorize like this" from a
  transaction.
- Apply-to-existing bulk action with a read-only preview, which is what makes
  categorizing months of backlog before go-live reconciliation tractable.
- 28 further tests covering ordering, the refusal to overwrite a categorization
  made by hand, regular-expression safety, and cache-versus-ledger agreement
  after a bulk apply.

### Fixed

- Backfill requests are split into 45-day windows. The bridge silently caps a
  longer range and reports it as a note rather than an error, so a twelve-month
  request returned three months while appearing to succeed — measured against
  real accounts, 275 transactions instead of 423.
- Account type is guessed from the institution and account name together. A real
  feed returns institution "Discover Credit Card" with account name "A Person
  (7169)", and reading the account name alone classified a credit card as an
  asset, which adds to the budget identity instead of subtracting from it.
- The Prisma CLI could not find the repository-root `.env`, so `npm run db:deploy`
  failed on a clean machine.
- `npm run simplefin:claim` failed with `ERR_MODULE_NOT_FOUND` and could never
  have run.
- The SimpleFIN response schema defaulted `accounts` to an empty array, so
  unrelated JSON parsed as zero accounts and recorded a successful sync.
- Integration test files ran concurrently against one database despite
  `fileParallelism: false`, which is a root-level Vitest option and is ignored
  inside a project. Replaced with a single fork for that project.
