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

Images are built by CI on x86_64 runners rather than locally, because a Mac would
produce an arm64 image the NAS cannot run
([ADR 005](docs/decisions/005-container-images-built-on-x86-64-ci.md)). They are
published from `main` and version tags only — never from a pull request — and are
deployed **by digest with verified provenance**
([ADR 012](docs/decisions/012-images-are-deployed-by-digest-with-verified-provenance.md)).

The target is a DS220+ (Intel Celeron J4025, 2 cores, 6 GB) running DSM 7.3.2,
sharing that hardware with DSM itself and the existing Sure container. Postgres
memory settings are pinned explicitly in the Compose file rather than left at
defaults, which assume a much larger machine.

**This stays on the LAN until Phase 3 ships in full.** No port forward, no DSM
reverse proxy, no QuickConnect. Rate limiting, two-factor authentication and CSRF
protection are in place; **TLS is not**, so passwords and codes still cross the
network in clear text. Passkeys have been dropped
([ADR 016](docs/decisions/016-passkeys-are-out-of-scope.md)). See
[ADR 007](docs/decisions/007-argon2id-parameters-and-password-policy.md).

### First deploy

1. **Install Container Manager** from Package Center if it is not present.
2. **Create two folders** — for example `/volume1/docker/delegate` for the
   project and `/volume1/backups/delegate` for database dumps.
3. **Copy `docker-compose.yml`, the `scripts/` directory and a `.env`** into the
   project folder. Set in `.env`:
   - `POSTGRES_PASSWORD` — a long random value
   - `SESSION_SECRET` — `openssl rand -base64 48`. It also encrypts the stored
     SimpleFIN credential, so changing it later means reconnecting SimpleFIN.
   - `HOST_PORT` — defaults to `8088`. The container's own port is 3000, private
     to the compose network, so it cannot collide with another container.
   - `BACKUP_DIR` — the dump folder from step 2
   - `APP_NAME` — whatever you want in the sidebar
4. **Lock that file down.** It holds the database password and the key the
   SimpleFIN credential is encrypted with:
   ```bash
   chmod 600 .env
   ```
   `deploy.sh` refuses to run if this is wrong.
5. **Install `cosign`** — one static binary, used to check that an image was
   signed by this repository's workflow before it is started:
   ```bash
   sudo curl -fsSL -o /usr/local/bin/cosign \
     https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
   sudo chmod +x /usr/local/bin/cosign
   ```
6. **Sign in to the registry.** This needs a **classic** personal access token
   with `read:packages` ticked and nothing else, plus an expiry.

   A fine-grained token does not work here, however much one would prefer it:
   GitHub's documentation states that Packages
   [only supports a classic token](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
   and `docker login` fails with `denied: denied`. A classic token is
   account-wide, so keeping it to the single `read:packages` scope is what limits
   the blast radius.

   ```bash
   sudo docker login ghcr.io -u <github-username>
   ```

   Paste the token at the hidden `Password:` prompt — a token pasted on a visible
   line stays in the terminal's scrollback afterwards. `docker login` stores it
   base64-encoded in `~/.docker/config.json`, which is encoding rather than
   encryption, so run `docker logout ghcr.io` afterwards if you would rather not
   leave it on the NAS.

   Two things that cost time the first time round: copy the token value alone —
   a label copied with it makes the login fail for no visible reason — and DSM's
   `scp` may need `-O` to copy files across, because its SSH server does not
   offer the SFTP subsystem that modern `scp` expects.

   _Or skip steps 5 and 6 entirely_ by using the tarball route in step 7, which
   needs no credential on the NAS at all.

7. **Deploy**, over SSH from the project directory:
   ```bash
   sudo ./scripts/deploy.sh
   ```
   or, from a downloaded CI artifact:
   ```bash
   sudo ./scripts/deploy.sh --image-file /volume1/docker/delegate-image.tar.gz
   ```
8. **Open it** at `http://<nas-address>:8088` and create the first account, which
   becomes Super Admin.
9. **Connect SimpleFIN** in Settings → Sync by pasting a setup token.

### What `deploy.sh` does

More than `docker compose up -d`, for three reasons:

- It resolves the tag to a **digest** and runs that, recording it in `.env` as
  `APP_IMAGE`. A tag is a moving pointer; a digest is the artefact. A later bare
  `docker compose up -d` then starts the same image rather than drifting.
- It **verifies the signature** before starting anything, and refuses if it
  cannot. CI signs each published digest through Sigstore, keyed to the workflow
  itself rather than to a key anyone holds. This image is handed the database and
  the bank feed credential, so "did my repository build this?" is worth answering
  properly.
- It waits for the **health endpoint**. A container that is "up" is not
  necessarily one that is serving: migrations run at start, and a failure there
  leaves a process that exits seconds later.

### Later deploys, and rolling back

The same command pulls the current image, re-verifies it, and restarts:

```bash
cd /volume1/docker/delegate && sudo ./scripts/deploy.sh
```

It prints the digest it replaced, and the exact command to go back to it:

```bash
sudo ./scripts/deploy.sh --digest sha256:…
```

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
| —     | Outstanding checks: written but not yet cashed, matched to the payment that clears them                                                                              |
| 3     | Security hardening: mandatory TOTP, rate limiting, CSRF, optional TLS, dependency audit, tested restore                                                              |
| 4     | UI polish: mobile, keyboard coverage, empty/loading/error states, accessibility                                                                                      |
| 5     | Feature and bug requests arrive from a Notion database and are built automatically                                                                                   |

**Passkeys have been dropped** — see
[ADR 016](docs/decisions/016-passkeys-are-out-of-scope.md). TOTP is the second
factor.

**Phase 3 is done.** Rate limiting, TOTP with recovery codes, CSRF protection,
optional TLS and the dependency audit have all shipped.

**Delegate serves plain http by default.** Reaching it from outside the house
goes through a Cloudflare Tunnel — see
[docs/remote-access.md](docs/remote-access.md), which covers what is encrypted on
which leg, and the two things that must be true before turning it on.

[ADR 017](docs/decisions/017-plain-http-is-the-default-and-tls-is-optional.md)
records that as a decision with its trade stated: on a trusted home network the
exposure is other devices on that network, and passwords and two-factor codes
cross it in clear text. TLS is supported for anyone who wants it — see below.

### Optional TLS

```bash
./scripts/make-tls-cert.sh 10.0.3.4 nas.local
```

Give it every address the household will actually type.

The container runs as uid 1000, not root, so the key has to be **owned** by that
uid — the script does it, using `sudo` if it needs to, and tells you the exact
command if it cannot. Do not widen the mode instead: the point of `600` is that
no other account on the NAS can read the private key.

Then in `.env`:

```
TLS_CERT_PATH="/tls/delegate.crt"
TLS_KEY_PATH="/tls/delegate.key"
SESSION_COOKIE_SECURE="true"
```

and `docker compose up -d`. The same image serves either transport; only
configuration decides. Both paths or neither — the application refuses to start
on half a configuration, because that would serve plain http from a deployment
whose settings claim otherwise.

Browsers warn until the certificate is trusted on each device. That warning is
the accurate report that nothing vouches for this identity except the machine
presenting it.

### Phase 5 — requests from Notion

A Notion database holds feature and bug requests. Approved ones are handed to
Claude Code, which builds and merges them.

This crosses a trust boundary the rest of the application does not, so it gets
designed before it gets built: a request written in Notion is **input, not an
instruction**, and an automated path from a text field to a merge on `main` is a
path an attacker would very much like to have. At minimum it needs a recorded ADR
covering who can approve, what an approved request is allowed to touch, and what
CI must prove before anything merges — the hard constraints above are not
negotiable by a request, whoever wrote it.

Dependency policy and the update process are in
[docs/dependencies.md](docs/dependencies.md).

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
