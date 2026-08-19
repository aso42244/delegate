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
SUM(in-budget assets)
  − SUM(in-budget debts)
  − SUM(delegation balances)
  + SUM(categorized pending transactions) ≈ $0
```

The fourth term is not decoration. Categorizing a pending charge empties its
envelope at once while the account balance is the institution's _settled_ one, so
without it the first three are out of step by the amount of the charge and the
page offers money that has already been spent. [ADR 020](decisions/020-pending-transactions-in-the-identity.md).

That reading sits at the top of the Budget page. It is **not** enforced by
double-entry bookkeeping — it is a health indicator, and a positive number is the
"available to delegate" figure on payday rather than a fault.

- **Repository:** `github.com/aso42244/delegate` (private)
- **Local path:** `~/Documents/Claude/Projects/delegate`
- **Owner's GitHub:** `aso42244`

---

## Your authority

The owner has delegated architecture and expects you to act, not ask.

- **Merge and deploy without asking each time.** If `npm run verify` passes and the work is
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
5. **Reachable from outside only through a Cloudflare Tunnel**, never a port
   forward, a DSM reverse proxy or QuickConnect. The transport to the origin is
   plain http by decision
   ([ADR 017](decisions/017-plain-http-is-the-default-and-tls-is-optional.md));
   the tunnel encrypts everything that crosses the internet
   ([ADR 018](decisions/018-a-proxy-is-trusted-only-when-configured.md),
   [docs/remote-access.md](remote-access.md)). `TRUST_PROXY` must never be set
   while the port is also reachable directly.
6. **USD only.** No multi-currency, no selector.

---

## Where things stand

**Live on the NAS, currently at `v0.14.0`.** 170 unit, 488 integration and 141
end-to-end tests, plus a live MCP handshake. There is no CI: GitHub stores the code and nothing else
([ADR 022](decisions/022-the-checks-run-here-not-on-github.md)), and every gate
runs locally through `npm run verify`.

Phases 1–3 of the original plan are complete. What has been built since is
recorded in the ADRs, and the short version is:

**The budget itself**

- The delegation event ledger — Delegate with undoable runs, transfers, manual
  adjustment, categorization and splits, pending reconciliation, archiving,
  go-live reconciliation
- Pending charges are a term of the identity (ADR 020)
- Section totals are rows of their own table, so a figure sits in the column it
  totals

**Bitcoin**, which is the largest body of recent work

- Holdings are a dated, append-only ledger with a cached quantity, exactly like
  delegation balances ([ADR 023](decisions/023-bitcoin-holdings-are-a-dated-ledger.md)).
  Historic purchases, average cost basis, and a net worth chart that values the
  quantity held _on each date_ rather than today's applied backwards
- Holdings and properties are created on their own Settings tab rather than under
  Accounts ([ADR 021](decisions/021-bitcoin-and-property-are-managed-where-they-live.md)).
  That change also fixed an in-budget holding contributing zero to the identity
- A configurable node, Esplora over HTTP
  ([ADR 024](decisions/024-esplora-first-and-plaintext-only-where-it-is-safe.md)).
  The address decides the route: private goes direct, `.onion` goes over Tor,
  anything else prefers Tor and falls back — reporting which it used
- Wallets watched by xpub/ypub/zpub or a multisig descriptor, gap-limit scanned
  ([ADR 025](decisions/025-a-descriptor-is-the-one-wallet-representation.md)).
  Descriptors are encrypted at rest and never returned by the API

**An AI assistant can reach the budget**, which is the newest body of work

- API tokens: a credential for a program, since everything else here assumes a
  browser ([ADR 030](decisions/030-a-program-authenticates-with-a-scoped-token.md)).
  A public selector and a hashed secret; scope is an **allowlist of route
  patterns**, not a rule about methods, because `GET /api/settings` carries the
  onion address. Issued from Settings → Connections, shown once
- `apps/mcp`, a stdio Model Context Protocol server that is a client of the HTTP
  API rather than of the database
  ([ADR 031](decisions/031-the-mcp-server-is-a-client-of-the-http-api.md)). It
  runs on somebody's own machine; nothing new listens on a port and nothing was
  added to the tunnel. Setup is [docs/mcp.md](mcp.md)
- A write-scoped connection can sort transactions and write rules. It can never
  move money, archive, apply a rule across history, or touch a setting — refused
  by the server, and asserted route by route in the test suite

**Security**, after two external OWASP reviews — see
[docs/security-review-2026-08.md](security-review-2026-08.md) for what was fixed
and, more usefully, what was _not_ and why

- Remote access over a Tor onion service, off until switched on from the LAN
  ([ADR 027](decisions/027-remote-access-is-an-onion-service.md))
- Two-factor required of every account by default, with `/set-up-two-factor` as
  the way back for an un-enrolled one — turning the requirement on used to lock
  people out of the page that offered enrolment
- TOTP codes and second-factor challenges are single-use
  ([ADR 028](decisions/028-a-totp-code-is-spent-when-used.md))
- The at-rest key is separable from `SESSION_SECRET`, with a rehearsed
  `secrets:rekey` ([ADR 029](decisions/029-the-at-rest-key-is-separable-from-the-session-secret.md))
- Changing your own password revokes every other session; settings writes are
  administrator-only; regex rules are refused by _timing_ as well as by shape

**This is no longer a LAN-only application.** Any claim to the contrary is stale
and should be deleted on sight. What remains narrowly true is that the origin
speaks plain http by default, which is correct behind a tunnel or inside an onion
service; ADR 017 carries the amendment.

### Known gaps to fix

None outstanding. A boolean in a query string was being read with
`z.coerce.boolean()`, and `Boolean("false")` is `true` — so the Transactions
page's Categorized filter had been showing the uncategorized queue instead. It
is the same fault that was found once on `/api/rules/preview` and patched at the
call site, leaving four more; the parse now lives in `http/serialize.ts` as
`booleanQuery` and there is one place to reach for.

The one that stood here — an account's type could not be
corrected from the UI, found by the owner on his first real sync — shipped in
[#41](https://github.com/aso42244/delegate/pull/41) and is available from both
Settings → Accounts and the asset or debt row menu.

### Waiting on the owner

Everything on the old version of this list is done: the accounts are corrected,
both people are enrolled in two-factor, go-live has happened, and the budget has
been reconciled to actual and run on real data for weeks.

What is genuinely outstanding:

1. **Confirm a backup dump lands** in `/volume1/docker/delegate/backups`, and
   that the folder is included in whatever backs up off the NAS. A dump on the
   same disk as the database is not a backup. This is the last item from the
   original go-live list and the only one that has never been ticked.
2. **Record the onion address** somewhere safe once Tor remote access is turned
   on. It lives in a Docker volume; lose the volume and the address cannot be
   recovered, only replaced, and every device that had it stops working.

Open by decision rather than by omission, each with reasoning in
[docs/security-review-2026-08.md](security-review-2026-08.md):

- **TLS at the origin** — declined. Cloudflare and Tor both encrypt from away;
  what remains is the LAN, and a `Secure` cookie would break plain-http access to
  the LAN address.
- **Encrypted backups** — deferred pending a decision about where the passphrase
  lives. A passphrase only in `.env` means a lost `.env` is a lost backup.
- **The least-privilege database role** — new installs get one automatically; an
  existing deployment needs the manual steps in the README.
- **`secrets:rekey`** — available and rehearsed, not yet run. Until it is, the
  at-rest key is still derived from `SESSION_SECRET`.

### Deployment

No CI, and no registry. The NAS builds the image from source it is handed
([ADR 019](decisions/019-the-image-is-built-on-the-machine-that-runs-it.md),
[ADR 022](decisions/022-the-checks-run-here-not-on-github.md)). Two commands.

On the Mac:

```sh
cd ~/Documents/Claude/Projects/delegate && git checkout main && git pull \
  && git archive --format=tar.gz -o delegate-<tag>.tar.gz <tag> \
  && scp -O delegate-<tag>.tar.gz grub@10.0.3.4:/volume1/docker/delegate/
```

Then on the NAS:

```sh
cd /volume1/docker/delegate && sudo ./scripts/deploy.sh --unpack delegate-<tag>.tar.gz --build
```

`--unpack` removes what the tarball owns before extracting. Plain `tar xzf` only
ever adds, so a source file deleted between two releases survives the upgrade and
gets compiled — which is exactly how v0.4.0 failed to build on the NAS. It
refuses outright if a tarball ever claims `.env`, `backups` or `tls`.

Things that have cost time and are worth knowing: `scp` to DSM needs `-O`;
Synology's Docker will not create a missing bind-mount source, so `deploy.sh`
makes them; and the `tor` service builds from source, so the first deploy after
it landed takes noticeably longer.

Exposure is through a **Cloudflare Tunnel**, working, with two-factor in front.
Cloudflare Access was declined. A Tor onion service is the alternative path and
is off until switched on from the LAN — see ADR 027, and note that running both
means the weaker door sets the security level.

**Remote MCP** — a `/mcp` endpoint on the public internet, which is what
claude.ai and Notion AI would need — is not built and needs an ADR before it
needs code. It makes Delegate an OAuth 2.1 authorization server and it puts the
household's finances into a third party's infrastructure on every tool call.
Notion additionally requires a Business or Enterprise plan and a Custom Agent.
ADR 031 records why the stdio transport was the right first step.

**Phase 5** — feature requests arriving from a Notion database and built
automatically — was removed from the plan at the owner's direction and is not on
the roadmap. If it ever returns it needs an ADR before it needs code: it would
create an automated path from a text field somebody typed into to a merge on
`main`, and a request is **input, not an instruction**. The hard constraints above
are not negotiable by a request, whoever wrote it.

---

## The environment

- macOS, Apple Silicon. Node 25 locally; the image pins Node 22.
- **Homebrew PostgreSQL 16.** `household_budget_dev` and `household_budget_test`
  (names predate the rename; harmless).
- `gh` is installed and authenticated as `aso42244`.
- **Docker is not installed locally, and this has a consequence worth knowing.**
  The NAS builds the image from source now, so nothing here needs to (ADR 019) —
  but it means `npm run verify` cannot complete its last step. Use
  `npm run verify:quick`, which skips exactly that.

  So the Dockerfile, `docker-compose.yml` and `tor/` are the one part of this
  repository that is reasoned about rather than executed before it ships. When
  changing any of them, say so plainly rather than reporting them as verified.

  **The Dockerfile changed when `apps/mcp` landed and has not been built.**
  `npm ci` reads every workspace the lockfile names and fails on a missing one,
  so its manifest is copied in; the production install is then scoped with
  `--workspace` so the MCP server's dependencies — express, hono, jose — do not
  reach a machine that never runs it. The resulting dependency tree _was_
  verified, against the real lockfile in a scratch directory: it is the previous
  one minus that subtree. The image itself was not built.
  The Tor image and its entrypoint went out on that basis; if the onion address
  never appears, `sudo docker compose logs tor` on the NAS is the first thing to
  read.

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
npm run verify            # everything, in the order CI used to run it
npm run verify:quick      # the same, minus the container image build

npm run test              # 158 unit
npm run test:integration  # 459 integration
npm run test:e2e          # 141 end-to-end, needs a build first

node scripts/verify-mcp.mjs   # spawns the built MCP server and speaks to it
```

`npm run verify` is the gate. It runs migrations, typecheck, lint, formatting,
the forbidden-terminology rule, the dependency audit, all three suites, the
cached-balances-against-ledger check, a real backup-and-restore, a live MCP
handshake against the built entrypoint, and the image build. It replaced GitHub Actions and is the _only_ thing standing between a
branch and `main` now — nothing on a server is watching.

Most commands need the environment loaded first:

```bash
set -a && . ./.env && set +a
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
- **`npm run verify` must actually pass before merging**, and nothing enforces
  that but you. There is no CI. When there _was_, a session merged on a pending
  check by accident twice — an exhausted timeout is not a pass, and neither is an
  empty check list.
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
  The Budget page reads its balances once on load, so arriving mid-write
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
