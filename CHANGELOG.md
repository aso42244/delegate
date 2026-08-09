# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are tagged per
phase (`v0.1.0-phase1`, and so on).

## [Unreleased]

Nothing yet. Phase 3 begins here: TLS first, then TOTP, passkeys, rate limiting,
CSRF and Cloudflare Access. **Nothing is exposed to the internet until all of it
ships.**

## [0.2.0-phase2] — 2026-08-09

Phase 2: everything §12 asks for, built and tested. The pages that need
categorized history are correct but sparse until go-live fills them.

### Added

- **Bitcoin** held as a quantity in satoshis, valued at the price on the date
  being shown. Hourly fetch from CoinGecko with Coinbase as a fallback, both
  keyless, behind a `PriceProvider` interface. A daily close is cached so the net
  worth chart uses the price that actually applied on each date.
- Closes settle on the following day's fetch rather than at midnight, so a
  container stopped overnight leaves no permanent hole in the chart.
- **Property values** recorded against an as-of date and kept as history, with
  equity computed on read from a linked mortgage. Manual entry only — §8 rules
  out Zillow — behind a `ValuationProvider` interface.
- **In-app notification banners**: a failing sync, balances nobody has confirmed
  lately, accounts a sync guessed the type of, the uncategorized backlog, and a
  stale Bitcoin price. Computed on read and not dismissible.
- **Grouping colours** from a curated palette, enforced server-side, expressed as
  a soft tint that keeps near-black text above 10:1 contrast.
- **Dragging a delegation between groupings**, as an addition to the row menu
  rather than a replacement — dragging is not a keyboard route.
- **The Utilities page**: twelve months per utility, the monthly average, the
  suggested per-cycle amount, and what the line is actually funded at.
- **The Insights page** and all twelve catalog widgets, with the chosen layout
  persisted per user.
- **Balance history reconstructed from the ledger** rather than stored, so the
  time-series widgets cover history that arrived before the feature existed. See
  [ADR 013](docs/decisions/013-historical-balances-are-reconstructed-from-the-ledger.md).
- **Transaction pairing**: §7's heuristic exactly, suggested and confirmed, never
  applied silently. Confirming clears any categorization, since a transfer
  allocates to nothing.
- An account's type can be corrected from Settings → Accounts and from the row
  menu — the API always accepted it and no screen offered it.
- Container images published to GHCR from `main` and version tags, signed through
  Sigstore, and deployed **by digest with the signature verified before start**.
  See [ADR 012](docs/decisions/012-images-are-deployed-by-digest-with-verified-provenance.md).
- `scripts/deploy.sh`: one SSH command that resolves a tag to a digest, verifies
  it, pins it, and waits for the health endpoint.
- 110 further tests, and end-to-end coverage of every page added.

### Fixed

- `GET /api/rules/preview` read its `includeCategorized` flag with `Boolean()`,
  and `Boolean("false")` is `true` — so asking for the safe preview returned the
  count for the mode that overwrites categorizations made by hand.
- Reconcile never stamped the go-live date: the domain accepted one and the route
  never passed it.
- `npm run typecheck` did not cover the web application at all.
- Equity over time zipped two series positionally when each is truncated at its
  own earliest history, subtracting a mortgage balance from the wrong date.
- Unpairing did not refresh the suggestion list, so a reversed pair did not
  reappear until a reload.
- The container image was built by CI and never published, while the Compose file
  pointed at it. The first deploy would have failed at the pull.
- `actions/attest-build-provenance` cannot run on a user-owned private
  repository; images are signed directly through Sigstore instead.
- The README told the owner to authenticate to `ghcr.io` with a fine-grained
  token. GitHub Packages only supports a classic one, and `docker login` fails
  with `denied: denied`.
- Several end-to-end tests raced a write and passed only on a fast machine.

## [0.1.0-phase1] — 2026-08-09

Phase 1: everything needed to stop using the spreadsheet, on the LAN.

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
- Transactions API with search across description, account, delegation and
  amount; filters for date, account, delegation, kind, uncategorized and pending;
  splits with exact amounts or an even division; and bulk categorize.
- Main Budget API: the read model with groupings and totals, inline creation and
  editing, and Delegate with preview and 12-hour undo, Transfer, manual
  adjustment and Reconcile to Actual.
- The web application: app shell with a collapsible sidebar, authentication
  screens, first-run Super Admin creation, and the design tokens from
  `docs/design.md`.
- The Main Budget page — three sections, inline creation, click-to-edit money
  cells, the identity banner, Delegate with its confirmation and undo bar, and
  Transfer.
- The Transactions page: the uncategorized queue, a keyboard-driven delegation
  type-ahead, search, filters and bulk categorize.
- SimpleFIN connection from Settings, with the access URL encrypted at rest
  (AES-256-GCM) and taking precedence over the environment variable.
- Manual transaction entry, and a split editor that shows the remainder as
  amounts are typed and refuses to save until the parts sum to the whole.
- `GET /api/accounts`, since the Main Budget read model deliberately carries only
  in-budget accounts and a manual transaction may belong to an off-budget one.
- The per-row menu on the Main Budget: rename, the utility toggle, a note,
  manual adjustment, per-line history, move to grouping, and archive. A blocked
  archive offers Adjust and Transfer inline.
- Per-delegation history — the only place `adjust` events are ever visible,
  since the transaction journal exists for categorization rather than auditing.
- Inline grouping creation on the Main Budget.
- Settings, one section per page: Sync, Accounts, Delegations, Groupings, Rules,
  Budget, Users, Reconcile and Archived.
- **Reconcile to Actual** — every delegation with its computed balance and an
  editable actual, committed in one batch. A line left blank is not touched, so
  it can be done in several sittings. The first commit is recorded as the go-live
  date.
- Settings → Budget: the identity tolerance and the undo window, both bounded,
  with the derived warning and danger thresholds stated on screen.
- Account management: create a manual account, edit it, and archive or restore
  it. A balance is editable only on a manual account, and an in-budget account
  holding money refuses to archive.
- The asset and debt row menu, sharing its mechanics with the delegation menu.
- Settings → Archived, backed by a new `GET /api/archived`.
- Settings → Rules with reordering, and apply-to-existing behind its preview.
- Settings → Users: create, change role, reset password, archive and restore,
  mirroring the server's Super Admin immunity rather than reimplementing it.
- Container images published to GHCR from `main` and version tags, with SLSA
  build provenance attested through Sigstore.
- `scripts/deploy.sh` — one SSH command that resolves a tag to a digest, verifies
  its provenance, pins it, and waits for the health endpoint.
- 70 end-to-end tests in a real browser covering the budget, transactions, manual
  entry and splits, both row menus, reconciliation, accounts, settings and rules.

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
- A missing hashed asset returned `index.html` with a 200 and `text/html`,
  producing a blank page and a MIME error that pointed nowhere near the cause.
  End-to-end tests now assert content type rather than status.
- `GET /api/rules/preview` read its `includeCategorized` flag with `Boolean()`,
  and `Boolean("false")` is `true` — so asking for the safe preview returned the
  count for the mode that overwrites categorizations made by hand. That number is
  read immediately before deciding whether to rewrite a year of history.
- Reconcile never stamped the go-live date: the domain accepted one and the route
  never passed it, so `budget_settings.go_live_at` could not be set by any path
  through the application.
- `npm run typecheck` did not cover the web application at all — the root
  TypeScript project referenced only `packages/shared` and `apps/api`, so type
  errors in `apps/web` surfaced only at build time. Adding it found two real
  ones, including a query function receiving TanStack Query's context object as
  its first argument.
- A `<label>` wrapping its textarea took its accessible text from everything it
  contained, so a filled-in note field could no longer be found by its own label.
  Replaced with a `TextArea` primitive wiring label and control by `htmlFor`.
- Two end-to-end tests fired a mutation and immediately navigated away, so the
  next page rendered mid-write and the assertion then polled a static DOM. They
  passed for months and failed only on a slow first run after a cold start.
- The container image was built by CI and never published, while the Compose file
  pointed at `ghcr.io/aso42244/delegate:latest`. The documented first deploy
  would have failed at the pull.
