# Handoff

Everything a new session needs to pick this up. Read this, then
`docs/architecture.md`, `docs/design.md`, and the ADRs in `docs/decisions/`.

The authoritative specification is the owner's build prompt at
`~/Desktop/budget-app-build-prompt.md`. Where this document and that one
disagree, that one wins — except where a decision has been explicitly overridden,
and every such override is recorded in an ADR.

---

## What this is

**Delegate** — a self-hosted envelope budgeting application for one household. It
replaces a hand-maintained spreadsheet and a self-hosted Sure instance running on
a Synology NAS.

The defining idea is an envelope budget that reconciles to zero as a
point-in-time calculation:

```
SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances) ≈ $0
```

That reading sits at the top of the Main Budget page. It is **not** enforced by
double-entry bookkeeping — it is a health indicator, and a positive number is the
"available to delegate" figure on payday rather than a fault.

- **Repository:** `github.com/aso42244/delegate` (private)
- **Local path:** `~/Documents/Claude/Projects/delegate`
- **Owner's GitHub:** `aso42244`

---

## Your authority

The owner has delegated architecture and expects you to act, not ask.

- **Merge and deploy without asking each time.** If CI passes and the work is
  complete, merge it. Do not ask "shall I merge this?"
- **You own the repository**: branches, PRs, merges, tags, via `gh` and `git`.
- **You may work on the local machine** — build, run, test, restart the server.
- **Ask only when genuinely blocked**, not for reassurance. A question you could
  answer by reading the spec or making a reasonable engineering call is not a
  blocker.
- **Push back when the spec is wrong.** This has happened several times and the
  owner has agreed each time. Say so, propose an alternative, then build.

Things that still need the owner: anything destructive to real data (Prisma
guards `migrate reset` for AI agents by design), and creating his account.

---

## Hard constraints

These are non-negotiable. Violating one is a build failure.

1. **The asset class term is banned; the asset is Bitcoin (or BTC).** Narrowed by
   [ADR 010](decisions/010-terminology-ban-covers-the-asset-class-only.md):
   cryptography, `node:crypto` and friends are fine. CI enforces the rest.
2. **All money is integer cents in `BIGINT`.** Never floats, never JavaScript
   `number` in arithmetic or persistence. Over HTTP cents travel as **decimal
   strings** — [ADR 002](decisions/002-money-as-integer-cents.md).
3. **Nothing is ever hard-deleted.** `archived_at` everywhere; archived rows stay
   resolvable so old transactions render `Grocery (archived)`.
4. **No personal data or secrets in the repository.** `.env` is git-ignored;
   `APP_NAME` exists so a family name never lands in committed UI copy.
5. **LAN only until Phase 3 completes in full.** No Cloudflare Tunnel, no
   internet exposure, and do not document any.
6. **USD only.** No multi-currency, no selector.

---

## Where things stand

**Phase 1 is essentially complete.** 23 PRs merged. 294 unit and integration
tests, 40 end-to-end tests in a real browser, all green.

Built and working:

- Money primitives, the budget identity, shared domain vocabulary
- Full PostgreSQL schema with integrity constraints the database enforces itself
- The delegation event ledger — Delegate with 12-hour undo, envelope transfers,
  manual adjustment, categorization and splits, pending reconciliation and
  reversal, archiving rules, go-live reconciliation
- `recompute-balances` CLI, run by CI with `--check`
- Auth: argon2id, sessions in PostgreSQL, first-run Super Admin, three roles,
  Admin-only user management
- SimpleFIN sync: hourly, windowed backfill, idempotent, full pending lifecycle,
  run history; connect in-app from Settings with the credential encrypted at rest
- Auto-categorization rules with apply-to-existing
- The API behind Transactions and Main Budget, including Delegate/Transfer/
  Adjust/Reconcile
- The UI: app shell with collapsible sidebar, auth screens, the Main Budget page
  with the per-row menu and inline grouping creation, the Transactions page
  including manual entry and the split editor, Settings → Sync
- Docker image, Compose for the NAS, nightly `pg_dump`, and a restore path proven
  by destroying data and recovering it

### What is left in Phase 1

1. **Settings sections beyond Sync** — accounts, delegations, groupings, rules,
   budget, users, archived, and the **Reconcile to Actual** screen. Reconcile
   matters: it is how go-live corrects sixty delegation balances in one commit.
   Accounts brings the write routes with it (`PATCH /api/accounts/:id`, archive),
   and the **asset and debt row menu on Main Budget** belongs with them — the
   delegation row menu ships without it deliberately, rather than being built
   twice against routes that do not exist yet.
2. **Deploy to the NAS.** The image has never run on the DS220+. That is the one
   remaining unknown; CI proves it boots on x86_64 Linux against real Postgres.

Then Phases 2 (Utilities, Insights, Bitcoin, property, pairing, colours,
notifications), 3 (security hardening — TLS first, then TOTP, passkeys, rate
limiting, CSRF, Cloudflare Access; **nothing exposed until all of it ships**),
and 4 (mobile, keyboard shortcuts, empty/loading/error states, accessibility).

---

## The environment

- macOS, Apple Silicon. Node 25 locally; the image pins Node 22.
- **Homebrew PostgreSQL 16.** `household_budget_dev` and `household_budget_test`
  (names predate the rename; harmless).
- `gh` is installed and authenticated as `aso42244`.
- **Docker is not installed locally** and is not needed — CI builds the image on
  x86_64, which is the point (ADR 005: a Mac would produce an arm64 image the
  Celeron cannot start).
- Playwright with Chromium is installed.
- Put `/opt/homebrew/opt/postgresql@16/bin` and `/opt/homebrew/bin` on `PATH` in
  shell commands; they are not there by default.

### The NAS

Synology **DS220+**, Intel Celeron J4025 (x86_64), 2 cores, 6 GB, DSM 7.3.2, at
`10.0.3.4`. It also runs the old Sure container, so `HOST_PORT` defaults to
`8088`. The container's own port 3000 is private to the compose network and
cannot collide.

### Commands

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test:all          # 289 unit + integration
npm run test:e2e          # 23 end-to-end, needs a build first
npm run build
./scripts/verify-restore.sh   # needs TEST_DATABASE_URL exported
```

Integration and end-to-end tests share `TEST_DATABASE_URL` and truncate it, so
never run both at once. A schema change must be applied to the **test** database
too, or ~190 tests fail in a way that looks like a code fault.

`prisma migrate dev` is interactive and will hang. Write the migration SQL by
hand and apply it with `migrate deploy`.

---

## Workflow

- `main` is always deployable. Never commit to it directly. GitHub branch
  protection is unavailable on a private repo without a paid plan, so this is
  discipline rather than enforcement.
- Branch names: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` + kebab.
- Conventional Commits. Squash-merge. Delete the branch.
- **CI must actually pass before merging.** Poll until no check reports
  `pending` — a previous session merged on a pending check by accident.
- PR descriptions state what changed, why, how it was tested, and any deferrals.
- Commit messages and PR bodies end with the co-author trailer and the Claude
  Code footer respectively.

---

## Things learned the hard way

Each of these cost real time. They are the reason the test suite looks the way it
does.

- **Tests that import modules never exercise the thing that boots.** The server
  crashed on startup twice — once from two not-found handlers, once from a broken
  CLI entrypoint — with typechecking and hundreds of tests green. CI now builds
  the web app, smoke-tests CLI entrypoints, and starts the container image.
- **A 200 status does not mean a correct body.** A missing hashed asset returned
  `index.html` with a 200 and `text/html`, producing a blank page and a MIME
  error that pointed nowhere near the cause. End-to-end tests assert **content
  type**, not status.
- **The SimpleFIN bridge silently caps a long date range** at 90 days and reports
  it as a note, not an error. A twelve-month request returned three months while
  looking entirely successful. Requests are split into 45-day windows, which is
  what the bridge recommends. Real accounts hold roughly **six months** of
  history, whatever the window.
- **Only run against real data finds real bugs.** The first live sync classified
  a credit card as an asset because the signal was in the institution name, not
  the account name — which would have thrown the identity off by twice the
  balance in the wrong direction.
- **Navigating straight after a mutation makes an end-to-end test lie.** Two
  specs pressed a key that fired a write and immediately went to another page.
  The Main Budget reads its balances once on load, so arriving mid-write
  snapshots a number that never updates — and `toContainText` then polls a static
  DOM for its whole timeout. It passed for months and failed only on the slow
  first run after a cold server start, which is exactly the run that looks like a
  real bug. Wait for a UI signal that the write landed (the row leaving the
  queue, the dialog closing) before navigating.
- **Playwright found two genuine accessibility defects on first run**: hint text
  inside a `<label>` polluting the accessible name, and a combobox and its
  listbox sharing one `aria-label`.
- **Routing around the terminology ban produced worse engineering** — a database
  round trip per money transaction, collidable correlation ids, `Math.random()`
  in the auth path. All fixed once the ban was narrowed.

---

## Design

`docs/design.md` is the owner's visual specification and is **settled** — read it
as written. Six conflicts with the build prompt were found and resolved with the
owner; the reasoning is recorded at the bottom of that file. The ones that shape
behaviour:

- The row menu says **Archive**, never Delete, and includes **Manually adjust**
  and **History for this line**.
- A **positive** balance reading is informational (accent blue,
  `$4,890.00 to delegate`), never a warning. Yellow and red are for
  over-delegation only. Thresholds derive from the configured tolerance.
- Grouping colour is a soft row tint plus a chip; contrast must hold at 4.5:1.
- The page is called **Insights**, not Metrics.

UI polish notes from the owner exist but are **deferred to Phase 4** by his
instruction. Do not chase them now.

---

## The owner

Not an experienced programmer — you own the technical architecture. He wants
minimal chat and working code, but he reads and engages with reasoning, asks good
questions about trade-offs, and has accepted every push-back so far when it was
argued from consequences rather than principle.

Explain what a decision costs him in practice. He decides well when you do.
