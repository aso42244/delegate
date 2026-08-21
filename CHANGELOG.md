# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are tagged per
phase (`v0.1.0-phase1`, and so on).

## [Unreleased]

Nothing yet.

## [0.22.0] — 2026-08-20

### Changed

- **The Delegate button becomes Undo Delegation** while the run can still be
  undone, in red, and goes back to Delegate when the window closes. One slot,
  because while a run is still undoable there is nothing sensible to delegate —
  offering both would be offering the wrong one first.
- **What was delegated is said beside the cycle date** rather than in a bar of
  its own, and it disappears with the offer. The cycle date stays: the cycle did
  not end when the chance to undo it did.

### Fixed

- **The undo offer never expired.** `previewUndoLatestDelegate` computed the
  expiry and handed the run back regardless, so the interface kept offering an
  undo that `undoDelegateRun` would refuse with `undo_window_expired`. The money
  was never at risk — that refusal is real and always was — but a button that
  cannot do what it says is worse than no button.

## [0.21.0] — 2026-08-19

### Added

- **Delegations can be put in an order**, and it is stored on the budget rather
  than in a browser — the same for everyone who signs in. Alphabetical was the
  only order this application had, which is why a household ends up naming its
  groupings "3 - Food" and "5 - Home": numbering by hand to buy back an ordering
  the software would not give them.
- **Drop a row onto another row** to put it in that row's place, in that row's
  grouping. Dropping onto a grouping still sends it to the end, as before.
- **Move up** and **Move down** in the row menu, beside the existing Move to
  grouping. Dragging is the fast route and it is not a keyboard one, so this is
  not a lesser alternative — it is the one that always works, including under a
  thumb.

Positions are backfilled to the order the budget already showed, so nothing
moves on upgrade.

## [0.20.0] — 2026-08-19

Interface work asked for by the owner, and a second factor that is no longer
optional.

### Added

- **Display names.** The username is an email address and reads as one wherever
  it appears. A name is not a credential and nothing is looked up by it, so
  anybody can set their own whatever role they hold — `PATCH /api/auth/me` sits
  outside user management for that reason.
- **Resetting somebody's second factor**, for an administrator. The way back
  when the phone is gone and the recovery codes went with it. Sign-in demands
  the second factor whenever one is confirmed, so before this the only route was
  a database prompt.
- **Add transaction on the Budget page**, beside Add grouping.

### Changed

- **A second factor is required of every account, always**, including the first
  Super Admin. The `requireTotp` setting is gone with its toggle. It never did
  what its name suggested: sign-in demanded the second factor whenever one was
  confirmed whatever it said, so it could not rescue a locked-out account, and
  its only real effect was to permit accounts with none at all.
- **Settings → Users is a table**, with creating and editing in a dialog. It was
  a permanent form at the bottom of the page and inline fields on every row,
  which made the common case — reading who has an account — the hardest thing on
  the screen.
- **The Transactions register opens unfiltered**, and its columns are stated
  rather than left to the browser. A bank description is unbounded and took 728
  of 1112 pixels, leaving the delegation picker 87.
- **Transfer mirrors the Budget page**: grouped dropdowns in the same order, each
  option carrying the balance it holds.
- **To delegate lines up with Assets and Debts.** A single `pr-3` those cells do
  not carry had it 12 pixels out.
- **New outstanding check** is **New check**.
- Less prose on Utilities and Insights, and **Add from catalog** is a button in
  the header rather than a dashed tile at the end of the grid.

### Fixed

- `PATCH /api/settings` refused unknown fields rather than stripping them. A
  request still carrying `requireTotp` answered 200 with the field discarded —
  which reads to the caller as having turned two-factor off, successfully.

## [0.19.0] — 2026-08-19

The budget no longer assumes the household is paid every two weeks.

### Added

- **Pay cadence**, on Settings → Budget: weekly (52 a year), every two weeks
  (26), twice a month (24), or monthly (12). The count is part of each label
  because "biweekly" is genuinely ambiguous in English, and picking the wrong
  one would put the suggestion out by a factor of four with nothing on screen to
  reveal it.
- **Twice a month covers both patterns.** The 1st-and-15th and the
  15th-and-last-day are the same 24 payments a year, and naming it by a pair of
  dates would make half the households it fits think it did not.

### Changed

- `suggestedPerCycleCents` takes the number of cycles rather than assuming 26.
  Still integer throughout and still rounded half away from zero; the doubling
  in the new form is what keeps that exact for an odd divisor as well as an even
  one.
- The Utilities page names the divisor it actually used, and the server sends it
  alongside the figures rather than leaving the interface to look it up — a page
  saying "over 26" beside a number computed from 24 is worse than either alone.
- Two comments that described biweekly pay as though the code depended on it.
  One of them, on `partial` in the cycle summaries, had never matched what the
  code did.

### Unchanged, deliberately

- **Nothing runs on a schedule.** A cycle is still one Delegate press to the
  next, pressed by hand when the money lands. The cadence is a divisor, not a
  timetable.
- **No amount to delegate is rewritten.** Those are applied once per press, so
  changing cadence changes what they come to over a year. That is the
  household's decision and the interface says so rather than acting on it.
- **An existing budget reads identically after the upgrade.** The column
  defaults to `biweekly`, which is what the arithmetic assumed before it was a
  setting.

## [0.17.0] — 2026-08-19

Model Context Protocol support, added in 0.15.0 and 0.16.0, is removed at the
owner's direction. Settings → Connections, the API token model, the connector
bundle and the `apps/mcp` workspace are all gone, along with their
documentation and ADRs 030 and 031.

The two fixes found while that work was being done are **kept**. Neither had
anything to do with it beyond being noticed at the same time.

### Removed

- API tokens, the token scope allowlist, Settings → Connections, the
  `apps/mcp` server and the Claude Desktop connector bundle.
- `api_tokens` is dropped by a new migration rather than by deleting the one
  that created it. Migrations are forward-only (ADR 003) and the deployment had
  already applied it; removing the file would leave `migrate deploy` reporting
  drift. Dropping rather than archiving is right here for once — the rows were
  credentials, not a record of anything the household did.

### Fixed

- **A flag in a query string is text, not a truthy value.**
  `z.coerce.boolean()` is `Boolean(value)`, and `Boolean("false")` is `true`, so
  `GET /api/transactions?uncategorized=false` returned the uncategorized queue —
  the Transactions page's Categorized filter had been showing the wrong list.
  `pending` and `includeArchived` had the same fault, on transactions and on
  accounts. The parse now lives in `http/serialize.ts` as `booleanQuery`.
- **`.dockerignore` was anchored at the root**, so
  `packages/shared/tsconfig.tsbuildinfo` was copied into the build context. A
  stale one is a lie `tsc --build` believes: it concludes the project is already
  built, emits nothing, and every workspace importing `@budget/shared` then
  fails to resolve it. Only ever visible locally — the NAS builds from a
  `git archive` tarball, which carries no ignored file at all.

### Changed

- **The container image step starts the image** and asks it for `/health`.
  Building alone was half of what the step's name claimed, and a container that
  builds and then exits on boot is a failure this project has had twice.

## [0.3.0-phase3] — 2026-08-10

Phase 3 as re-scoped, plus outstanding checks and the first pass of Phase 4.
Passkeys were dropped from the plan and Cloudflare Access deferred, both
recorded rather than quietly skipped.

### Added

- **Two-factor authentication.** TOTP with ten recovery codes, and a
  household-wide requirement that refuses to turn on while any active account
  would be locked out by it. The secret is stored encrypted and the recovery
  codes as argon2id hashes, for the same reason the SimpleFIN credential is: the
  nightly `pg_dump` is the copy most likely to leave the device. The
  second-factor step uses a signed challenge rather than a half-authenticated
  session — [ADR 014](docs/decisions/014-the-second-factor-step-uses-a-signed-challenge-not-a-session.md).
- **Rate limiting** on every route that verifies a credential, and security
  headers via helmet with a same-origin content security policy.
- **CSRF protection** as an origin check on every state-changing request, on top
  of the `SameSite=Lax` cookie — [ADR 015](docs/decisions/015-csrf-is-an-origin-check-not-a-token.md).
- **Session rotation on role change.** The guards already re-read the role every
  request, but the session id itself was minted under different privileges.
- **Optional TLS**, terminated by the application, with plain http as the
  documented default for a trusted LAN — [ADR 017](docs/decisions/017-plain-http-is-the-default-and-tls-is-optional.md).
  `scripts/make-tls-cert.sh` generates a certificate with the right subject
  alternative names, including bare IP addresses.
- **Cloudflare Tunnel support.** `TRUST_PROXY` makes the sign-in rate limit count
  the real client rather than `cloudflared` — without it the whole internet
  shares one bucket. Opt-in, because trusting an unvetted `X-Forwarded-For` does
  not weaken the limit, it removes it —
  [ADR 018](docs/decisions/018-a-proxy-is-trusted-only-when-configured.md).
- **Outstanding checks.** A check written and not yet cashed is modelled as a
  delegation, so the budget identity holds through its whole life. Matched to the
  payment that cashes it by exact amount _and_ check number as a whole token;
  what cannot be resolved automatically is matched by hand. The spending lands on
  the delegation the check was drawn on, never on the check line.
- **Dependency audit in CI**, failing on a high or critical advisory in anything
  that ships. Policy and update process in [docs/dependencies.md](docs/dependencies.md).
- **Phase 4, first pass:** a row-height setting (40px, or 32px compact), the
  budget showing one amount at a time on a phone with a swipe between them, and
  `j`/`k` plus arrow-key navigation of the transaction queue.
- **A per-row menu on Transactions**, holding Split and Match to a check. One way
  in per device: hover, keyboard focus, or touch and hold.

### Fixed

- **Signing out could be undone by a request already in flight.** The session row
  was deleted, then a poll that had been running since before the logout re-saved
  its session — sessions are rolling — and the upsert re-created the row. Signed
  out everywhere visible, still signed in as far as the cookie was concerned,
  about one time in three.
- **Sign-out left the browser rendering the budget.** The server destroyed the
  session; the client kept drawing from a cache that was never emptied.
- **The container could not read its own TLS key.** It runs as uid 1000, and a
  key generated by whoever ran the script is mode 600 and owned by them. Caught
  by CI on the first run of the TLS smoke test.
- **Compose silently ignored `TRUSTED_ORIGINS`, `AUTH_RATE_LIMIT_*` and
  `BITCOIN_PRICE_*`.** They were never passed through, so setting them in `.env`
  did nothing.

### Changed

- **Passkeys are out of scope** — [ADR 016](docs/decisions/016-passkeys-are-out-of-scope.md).
  TOTP covers the stolen-password threat; what passkeys add is phishing
  resistance, which is narrow for a two-person application with no public URL to
  impersonate. The trade is recorded: Delegate remains phishable.
- **Cloudflare Access deferred** to a future request. Without it the sign-in page
  will be on the public internet once the tunnel is up, and the rate limit, the
  second factor and argon2id are what stand in its place.

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
- Budget API: the read model with groupings and totals, inline creation and
  editing, and Delegate with preview and 12-hour undo, Transfer, manual
  adjustment and Reconcile to Actual.
- The web application: app shell with a collapsible sidebar, authentication
  screens, first-run Super Admin creation, and the design tokens from
  `docs/design.md`.
- The Budget page — three sections, inline creation, click-to-edit money
  cells, the identity banner, Delegate with its confirmation and undo bar, and
  Transfer.
- The Transactions page: the uncategorized queue, a keyboard-driven delegation
  type-ahead, search, filters and bulk categorize.
- SimpleFIN connection from Settings, with the access URL encrypted at rest
  (AES-256-GCM) and taking precedence over the environment variable.
- Manual transaction entry, and a split editor that shows the remainder as
  amounts are typed and refuses to save until the parts sum to the whole.
- `GET /api/accounts`, since the Budget page read model deliberately carries only
  in-budget accounts and a manual transaction may belong to an off-budget one.
- The per-row menu on the Budget page: rename, the utility toggle, a note,
  manual adjustment, per-line history, move to grouping, and archive. A blocked
  archive offers Adjust and Transfer inline.
- Per-delegation history — the only place `adjust` events are ever visible,
  since the transaction journal exists for categorization rather than auditing.
- Inline grouping creation on the Budget page.
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
