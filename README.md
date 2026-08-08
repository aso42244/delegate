# Delegate

A self-hosted envelope budgeting application for a single household. It replaces a
hand-maintained spreadsheet and a self-hosted Sure instance.

The name is the verb the whole system is built around: money sits in real
accounts, and every dollar is _delegated_ to a named envelope.
The health of the budget is one subtraction, shown at the bottom of the Main Budget
page and recomputed on every view:

```
SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)
```

A positive reading is money that has landed and not been distributed yet — the
"available to delegate" figure. Near zero is `Balanced`. Negative is
over-delegated. See [docs/architecture.md](docs/architecture.md) for the domain
model, [docs/design.md](docs/design.md) for the visual language, and
[docs/handoff.md](docs/handoff.md) for the current state of play.

> **LAN only.** This application has no internet exposure and must not be given
> any until the Phase 3 security work ships in full. See
> [docs/architecture.md](docs/architecture.md) and the phase plan below.

## Status

Phase 1 (MVP) in progress. Landed so far:

- Money primitives, the budget identity, and the domain vocabulary shared between
  API and UI
- The full PostgreSQL schema with integrity constraints the database enforces
  itself
- The delegation event ledger: Delegate with 12-hour undo, envelope transfers,
  manual adjustment, categorization and splits, pending reconciliation and
  reversal, archiving rules, go-live reconciliation
- `recompute-balances`, which rebuilds cached balances from the ledger
- Authentication: argon2id, sessions in PostgreSQL, first-run Super Admin, three
  roles, and Admin-only user management
- SimpleFIN sync: hourly, windowed backfill, idempotent re-runs, the full pending
  lifecycle, and run history surfaced to the UI
- Auto-categorization rules, including the apply-to-existing bulk action
- The API behind the Transactions page and the Main Budget page, including
  Delegate with undo, Transfer, manual adjustment and Reconcile to Actual
- The interface: app shell, authentication, the Main Budget page, the
  Transactions page, and SimpleFIN connection in Settings
- 289 tests plus 19 end-to-end tests in a real browser, including integration
  tests asserting the identity behaves correctly after every mutating operation

Not yet built: the per-row menu on the Main Budget, and the Docker deployment
with nightly backups.

## Requirements

- Node.js 22 LTS
- PostgreSQL 16
- Docker and Docker Compose, for deployment only — not needed to develop

## Local development

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at least `DATABASE_URL`, `TEST_DATABASE_URL` and
`SESSION_SECRET`. Generate the secret with:

```bash
openssl rand -base64 48
```

`.env` is git-ignored and must never be committed. Create the two databases,
apply migrations, and seed:

```bash
createdb household_budget_dev && createdb household_budget_test
npm run db:deploy
npm run db:seed
```

The seed data is entirely invented — no real balances, institutions or personal
details appear anywhere in this repository.

### Commands

| Command                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `npm run dev`              | Run the API in watch mode                             |
| `npm run typecheck`        | Typecheck every workspace, tests included             |
| `npm run lint`             | ESLint, type-aware                                    |
| `npm run format`           | Prettier, write                                       |
| `npm test`                 | Unit tests only — no database needed                  |
| `npm run test:integration` | Integration tests against `TEST_DATABASE_URL`         |
| `npm run test:all`         | Both projects                                         |
| `npm run test:e2e`         | End-to-end tests in a real browser                    |
| `npm run db:migrate`       | Create and apply a new migration in development       |
| `npm run db:deploy`        | Apply existing migrations (used in CI and production) |
| `npm run db:reset`         | Drop, re-migrate and re-seed the development database |
| `npm run simplefin:claim`  | Exchange a SimpleFIN setup token for an access URL    |

Integration tests **truncate every table** in `TEST_DATABASE_URL`, and refuse to
run unless the database name ends in `_test`. The end-to-end tests use the same
database, so do not run both at once.

End-to-end tests drive a real browser against the **built** server serving the
**built** UI — the same artefact the NAS runs. They exist because typechecking
and a full green suite both said nothing when the server once failed to boot:
nothing had started the process with a UI build present. They need the browser
once:

```bash
npx playwright install chromium
npm run build
npm run test:e2e
```

### Connecting SimpleFIN

SimpleFIN issues a one-time **setup token**, which is exchanged once for a
long-lived **access URL**. Get a token from
[bridge.simplefin.org](https://bridge.simplefin.org/) after connecting your
institutions.

**The easiest route is the app itself:** sign in, go to **Settings → Sync**, paste
the token, and press Connect. The claimed credential is stored encrypted in the
database, so reconnecting after a redeployment needs no file editing and no SSH.
Because the encryption key is derived from `SESSION_SECRET`, changing that
variable means reconnecting — see
[ADR 011](docs/decisions/011-simplefin-credential-stored-encrypted.md).

There is also a command-line route, for a configuration-managed deployment:

```bash
npm run simplefin:claim -- <setup-token>
```

That prints a `SIMPLEFIN_ACCESS_URL=...` line to paste into `.env`. Two things
worth knowing:

- **A setup token can only be claimed once.** A second attempt returns 403 and
  you need a fresh token.
- **The access URL is a bearer credential** — it embeds Basic Auth and anyone
  holding it can read your account data. It lives only in `.env`, which is
  git-ignored, and no API route ever returns it.

Sync then runs hourly, backfilling twelve months on its first run. Without the
variable set the application still runs; sync simply reports itself as
unconfigured. River and Strike are not SimpleFIN-supported and are manual
accounts.

### Rebuilding cached balances

`delegations.balance_cents` is a cache; `delegation_events` is the truth.

```bash
npm run build --workspace @budget/api
npm run recompute-balances --workspace @budget/api
```

It prints every balance it had to change and exits non-zero if there were any — a
disagreement is a defect worth investigating, not routine maintenance. Add
`-- --check` to report without writing, which is what CI does.

## Deployment on a Synology NAS

> Written so that someone who is not the owner could follow it.

Container images are built by CI on x86_64 runners rather than locally, because a
Mac would produce an arm64 image the NAS cannot run. See
[ADR 005](docs/decisions/005-container-images-built-on-x86-64-ci.md).

The target is a DS220+ (Intel Celeron J4025, 2 cores, 6 GB) running DSM 7.3.2,
sharing that hardware with DSM itself and the existing Sure container. Postgres
memory settings are pinned explicitly in the Compose file rather than left at
defaults, which assume a much larger machine.

1. **Install Container Manager** from Package Center if it is not present.
2. **Create two folders**, for example `/volume1/docker/delegate` for the project
   and `/volume1/backups/delegate` for database dumps.
3. **Copy `docker-compose.yml` and a `.env`** into the project folder. Set:
   - `POSTGRES_PASSWORD` — a long random value
   - `SESSION_SECRET` — `openssl rand -base64 48`. It also encrypts the stored
     SimpleFIN credential, so changing it later means reconnecting SimpleFIN.
   - `HOST_PORT` — defaults to `8088`. The container's own port is 3000 but that
     is private to the compose network, so it cannot collide with another
     container using 3000.
   - `BACKUP_DIR` — the dump folder from step 2
   - `APP_NAME` — whatever you want in the sidebar
4. **Start it:**
   ```bash
   sudo docker compose up -d
   ```
   Migrations are applied automatically on start.
5. **Check health:** `curl http://<nas-address>:8088/health`
6. **Open it** at `http://<nas-address>:8088` and create the first account, which
   becomes Super Admin.
7. **Connect SimpleFIN** in Settings → Sync by pasting a setup token.

### Backups, and restoring from one

A dump is written nightly to `BACKUP_DIR` and older ones are pruned after
`BACKUP_RETENTION_DAYS`. Retention is applied only after a dump succeeds, so a
run of failures never deletes the last good copy.

**Confirm that folder is inside whatever off-device backup already exists.** A
dump on the same disk as the database is not a backup.

To restore:

```bash
sudo docker compose exec app sh -c \
  'RESTORE_CONFIRM=yes ./scripts/restore.sh /backups/delegate-YYYYMMDD-HHMMSS.dump'
```

It refuses to run without `RESTORE_CONFIRM=yes`, because it replaces the contents
of the database it is pointed at.

**This path is tested rather than assumed.** `./scripts/verify-restore.sh` seeds a
database, dumps it, destroys the contents, restores, and fails unless the row
counts and balances match exactly either side. CI runs it on every change.

## Go-live order of operations

The sequence matters, because balances derived from a categorized backlog are
deliberately wrong until the last step:

1. **Sync** — pulls accounts and backfills as much history as the feed holds. The
   target is 12 months, but the institutions decide: against real accounts the
   bridge returned roughly **six months**. Requests are split into 45-day windows,
   because a single long request is silently capped rather than refused. See
   [ADR 009](docs/decisions/009-simplefin-sync-cadence-and-window.md).
2. **Build rules** — create auto-categorization rules, fastest from a transaction
   via "always categorize like this".
3. **Bulk-apply rules** to the existing backlog.
4. **Categorize the remainder** by hand on the Transactions page.
5. **Reconcile** — Settings → Reconcile. Enter each envelope's true balance. One
   commit corrects every line. **A line left blank is not touched**, so this can
   be done in several sittings. The first commit is also recorded as the go-live
   date; later ones are ordinary maintenance and do not move it.

Steps 1–4 will drive delegation balances deeply negative — Grocery may read
−$9,000 when its true balance is $725. That is expected and deliberate: it buys
full history and accurate day-one numbers. Step 5 corrects all of it at once.

## Phases

| Phase | Scope                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | MVP: auth, accounts, SimpleFIN sync, transactions, rules, delegations, the ledger, Delegate/Transfer/Adjust, Reconcile, Settings, nightly backups, Docker deployment |
| 2     | Utilities, Insights, Bitcoin, property value and equity, transaction pairing, grouping colours, notification banners                                                 |
| 3     | Security hardening: LAN TLS, mandatory TOTP, passkeys, rate limiting, CSRF, Cloudflare Tunnel behind Cloudflare Access, dependency audit, tested restore             |
| 4     | UI polish: mobile, keyboard coverage, empty/loading/error states, accessibility                                                                                      |

**No internet exposure happens until every part of Phase 3 ships.** TLS is
sequenced first within it, because WebAuthn requires a secure context and passkeys
cannot be built at all over plain HTTP.

## Repository conventions

- `main` is always deployable. Work happens on `feat/`, `fix/`, `chore/`, `docs/`
  or `refactor/` branches and lands by squash-merge.
- **`main` is not yet protected by a server-side rule.** GitHub restricts branch
  protection on private repositories to paid plans, so the convention is currently
  enforced by discipline rather than by GitHub refusing the push. Making the repo
  public, or upgrading the plan, would let a rule enforce it — see
  [open questions](docs/open-questions.md).
- Conventional Commits.
- CI must pass before merge: typecheck, lint, formatting, unit and integration
  tests, and a check that cached balances agree with the ledger.
- One PR per coherent unit of work. Schema + API + UI for one feature is one PR.
- Architectural decisions are recorded in `docs/decisions/`.

## Licence

MIT. See [LICENSE](LICENSE).
