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

**Phase 1 is complete and tagged `v0.1.0-phase1`.** Phase 2 is in progress,
split into **2a** (buildable without real data) and **2b** (blocked on it).
413 unit and integration tests, 92 end-to-end tests in a real browser.

**Phase 2 is complete.** Every item in §12's Phase 2 list has shipped, including
transaction pairing. What remains needs the owner's real data or his judgement
against a populated page — see Phase 2b.

**Phase 2a was complete first.** Everything that could be built and verified without
real household data is done: Bitcoin, property and equity, notification banners,
grouping colours and drag-to-move, Utilities, and Insights with all twelve
widgets. **Phase 2b is blocked on real data** — see below.

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
  including manual entry and the split editor, and Settings → Sync, Accounts,
  Delegations, Groupings, Rules, Budget, Users, Reconcile to Actual and Archived
  — every section §9.5 asks for
- Docker image, Compose for the NAS, nightly `pg_dump`, and a restore path proven
  by destroying data and recovering it

### Known gaps to fix

1. **An account's type cannot be changed from the UI.** `PATCH /api/accounts/:id`
   accepts `type` and an integration test covers it, but neither Settings →
   Accounts nor the asset/debt row menu offers a control. §6.1 says the owner can
   override a guessed type and §9.5 lists "asset or debt" among the Accounts
   settings, so this is an omission rather than a decision. Found by the owner on
   his first real sync, 9 Aug 2026. Nothing was mistyped, so it was not urgent.
2. **The README told the owner to use a fine-grained GitHub token for `ghcr.io`.**
   It does not work: GitHub's documentation states that Packages only supports a
   **classic** token, and login fails with `denied: denied`. Corrected wording is
   needed in the deployment section — a classic token with `read:packages` only,
   and an expiry.

### Phase 2b — waiting on real data

Nothing further can be built honestly until the owner has deployed, synced and
reconciled:

1. **Transaction pairing.** §12 is explicit that the matching heuristics need a
   real corpus and that tuning them on synthetic data is guesswork. The mechanism
   could be written; the thresholds cannot be chosen.
2. **Judging Utilities, Insights and the grouping tints against a populated
   page.** §12 anticipated this too. All three are correct and largely empty.
3. **The NAS deploy**, which is what produces the data. The owner deferred it to
   the end of Phase 2 and wants to run it at a keyboard.

### What is left in Phase 1

1. **Deploy to the NAS.** The image has never run on the DS220+. That is the one
   remaining unknown; CI proves it boots on x86_64 Linux against real Postgres.

   The mechanism is now built and documented — CI publishes to GHCR from `main`
   and tags, `scripts/deploy.sh` resolves a tag to a digest, verifies its build
   provenance with `cosign`, pins it in `.env` and waits for health. See
   [ADR 012](decisions/012-images-are-deployed-by-digest-with-verified-provenance.md).
   **None of it has been run against the NAS.** The owner is away for a week and
   is deliberately not doing this over a remote session; it wants a keyboard, and
   the DSM-side work (firewall rule confining the port to the LAN) is his.

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
- **Anything that races a write eventually fails on a slower machine.** Three
  separate tests have now been fixed for this: navigating away before a write
  landed, clicking a second control before the first one's PATCH returned, and
  asserting on text before an async query had rendered the _other_ element that
  matched it. Each passed locally for weeks and failed on a CI runner. There is
  no helper for this — `networkidle` fights the notification poll and a test
  hook does not belong in production code. The convention is: **after any action
  that triggers a write, assert on the resulting UI state before the next
  action.** That is what web-first assertions are for.
- **A banner's copy can collide with a page's own copy.** The uncategorized
  notification and the Transactions subtitle both contain "waiting to be
  categorized", so a substring `getByText` resolved to two elements — but only
  once the notification query landed, which made it intermittent. Prefer exact
  text where two parts of the interface describe the same thing.
- **Navigating straight after a mutation makes an end-to-end test lie.** Two
  specs pressed a key that fired a write and immediately went to another page.
  The Main Budget reads its balances once on load, so arriving mid-write
  snapshots a number that never updates — and `toContainText` then polls a static
  DOM for its whole timeout. It passed for months and failed only on the slow
  first run after a cold server start, which is exactly the run that looks like a
  real bug. Wait for a UI signal that the write landed (the row leaving the
  queue, the dialog closing) before navigating.
- **A query string carries text, so a flag in one must be parsed, not coerced.**
  `GET /api/rules/preview` read its `includeCategorized` flag with `Boolean(...)`,
  and `Boolean("false")` is `true` — so asking for the safe preview returned the
  count for the mode that overwrites categorizations made by hand. Nothing
  called it with the flag until Settings → Rules did, which is why it survived.
  It is now an explicit `z.enum(['true','false'])`.
- **`npm run typecheck` did not cover the web app.** The root `tsconfig.json`
  referenced only `packages/shared` and `apps/api`, so type errors in
  `apps/web` surfaced only at `npm run build` — the same shape of hole as the
  two boot crashes above. `apps/web` is now in the references, and a real error
  (`row.inBudget` on a type that did not have it) was sitting there when it was
  added.
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
