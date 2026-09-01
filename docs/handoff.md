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

**`main` and the NAS are both at `v0.35.0`.** 241 unit, 607 integration and 181
end-to-end tests. There is no CI: GitHub stores the code and nothing else
([ADR 022](decisions/022-the-checks-run-here-not-on-github.md)), and every gate
runs locally through `npm run verify`.

Phases 1–3 of the original plan are complete. What has been built since is
recorded in the ADRs, and the short version is:

**Accounts and access**

- **A second factor is required of every account, always.** There is no setting
  and no toggle; `requireTotp` is gone. It never worked the way its name read —
  sign-in demanded the factor whenever one was confirmed regardless — so its
  only effect was to permit accounts without one
- An administrator can **reset somebody's second factor**, which is the only
  route back from a lost phone plus lost recovery codes that is not a database
  prompt. Done to yourself it leaves you signed in and routed to enrolment: the
  request that deletes the sessions writes its own back on the way out
- Display names, settable by anyone for themselves at any role

**The budget itself**

- Delegations carry a `position` and can be reordered — by dragging a row onto
  another row, or from the row menu. Stored on the budget, not per browser.
  Dragging _between_ groupings already existed; what was missing was ordering,
  which is why the owner's groupings are named "3 - Food" and "5 - Home"

- Pay cadence is a setting — weekly, every two weeks, twice a month, monthly —
  and the Utilities suggestion divides by it. It is a **divisor, not a
  schedule**: a cycle is still one Delegate press to the next, and no amount to
  delegate is ever rewritten when it changes. Defaults to biweekly so an
  existing budget reads identically on upgrade

- **The reading at the top is closed against a line from the line itself.**
  Hover a delegation while it is not zero: "Move surplus here", or "Fix deficit
  from here". Three choices, an unavailable one shown disabled with its reason.
  It writes the ordinary `adjust` event — it _is_ a manual adjustment, with the
  amount computed — so history, undo and the ledger check work on it for free.
  The difference is recomputed **on the server**, because "all of it" has to
  mean all of it when the request lands
- **Delegate becomes Undo Delegation** while the run is still undoable, and back
  again when the window closes. The offer used never to expire: the preview
  computed `expiresAt` and returned the run regardless, so it kept offering an
  undo the server would refuse
- **A transaction can be archived** from its row menu — the API always could,
  the interface never offered it. Reverses any envelope movement; only touches
  the account balance for a manual row
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

**Since v0.24.1**, in the order it shipped:

- **Settings → Accounts is one line per account**, split into Assets and Debts.
  The split deleted the Type column outright — the section a row sits in _is_ its
  type. Bitcoin and property left the page entirely
  ([ADR 021](decisions/021-bitcoin-and-property-are-managed-where-they-live.md)
  is amended twice: first to a one-line footer, then to nothing)
- **The balance reading is a chip beside the page title**, not a bar across it.
  `Balanced`, `To delegate $1,000.00`, `Over delegated $212.00` — state first,
  figure second, with the equation on hover _and_ on focus. The wording lives in
  `formatIdentityLabel`, which already existed and which the page used to
  duplicate
- **A cleared check is confirmed, never settled unasked**
  ([ADR 030](decisions/030-a-cleared-check-is-confirmed-not-assumed.md)). A sync
  proposes; a person settles. Purple is the fourth banner colour, for something
  worked out and not yet acted on
- **Every chip is one letter** — `p i t c sp m s r btc h u n`. One letter, one
  meaning application-wide, enforced by a unit test; the full word is always
  carried for a screen reader and on hover. See `components/chips.ts`
- **Settings is quieter tab by tab.** Every list obeys Settings → Display, every
  "add" is a header button and a dialog, two-factor moved to Users, and Security
  became Tor
- **Reconcile to Actual is removed**
  ([ADR 031](decisions/031-reconcile-to-actual-is-removed.md)). No data went with
  it: every event it wrote is an ordinary manual adjustment. Correcting a
  backfill now happens on the Budget row menu or Settings → Delegations
- **The nightly backup runs**, and says so when it does not. See below — it had
  never run once

**Since v0.29.2:**

- **A synced account shows how old the feed's own answer is.**
  `accounts.feed_balance_as_of` records what the bridge said about its own
  freshness and is **null when it said nothing** — `balanceAsOf` could not tell a
  fresh answer from an absent one, because it falls back to the time of the
  request. Found chasing ten charges that stayed pending for days while the
  bridge reported itself healthy; nothing about the pending lifecycle was wrong
  ([ADR 032](decisions/032-a-feed-date-is-kept-apart-from-the-one-we-stamp.md))
- **Scheduled jobs run in the household's zone**, an IANA name defaulting to
  UTC. Since [ADR 037](decisions/037-a-day-is-the-households-day.md) it also
  decides **which day an instant falls in** — the process clock is still
  untouched; this is a stored setting the domain consults
- **The two-factor setup key is offered behind "Can't scan this?"**, grouped and
  copyable, for enrolling in a password manager on the machine already showing
  the screen. The Copy button works on a plain-http origin, where
  `navigator.clipboard` does not exist
- **One UI system across every screen**
  ([ADR 033](decisions/033-one-ui-system-with-a-test-that-holds-it.md)). A
  four-value spacing scale, field widths chosen by content, `New <noun>` at every
  create entry point, and a text budget. **`docs/ui-system.md` is the
  measurements and `ui-system.test.ts` enforces them** — read it before any
  interface change
- **Dark mode**, on Settings → Display beside row height
  ([ADR 034](decisions/034-dark-mode-is-a-second-palette-not-an-inversion.md))

**Insights, and the nightly snapshot**

- **The financial picture is recorded every night** at 03:10 in the household's
  zone, labelled for the previous day
  ([ADR 035](decisions/035-the-financial-picture-is-snapshotted-nightly.md)).
  Three tables, each row carrying its own provenance. **ADR 035 supersedes
  ADR 013**, which rejected exactly this in August for a reason that expired when
  the backfill happened
- **There is no initial backfill, by decision.** History starts at the first run,
  so Insights resets on deploy and gains a day a night. The gap-filler exists
  only for outages going forward, and every row it writes is marked derived
- **`domain/history.ts` is gone** with the reconstruction it held. Its
  ledger-walking survives inside the gap-filler
- **The schedule time zone is a setting**
  ([ADR 036](decisions/036-the-schedule-timezone-is-a-setting.md)), picked on
  Settings → Budget. Null means follow `SCHEDULE_TIMEZONE`, so an existing
  deployment fires exactly where it did. Saving rebuilds the cron tasks —
  node-cron fixes a task's zone at creation
- **A day is the household's day**
  ([ADR 037](decisions/037-a-day-is-the-households-day.md)), which narrows
  ADR 036's "when jobs fire and nothing else". `domain/calendar.ts` is the only
  place that turns an instant into a day, and it keeps two ideas apart by name:
  an **instant** (`posted_at`, `occurred_at` on a delegation event, `now`,
  `created_at`) needs a zone to place in a day; a **date key** (`as_of`,
  `price_date`, `snapshot_date`) is a day already decided and needs none.
  Conflating them is how an 8pm charge landed in next month's average. **If you
  are adding a zone parameter to a function that does not convert an instant,
  you have the distinction backwards** — see `revalueBitcoinHoldings`, which
  deliberately has none
- **A manual balance typed on Settings → Accounts writes a dated valuation.**
  Before this, only properties had a history and cash, River and Strike had none

**How to tell the snapshot job actually ran.** This is the question the nightly
backup taught us to ask from the other end — not "did the attempt throw", which
was answered correctly into a log nobody read, but "is the evidence on disk".

`GET /api/snapshots/status` answers it from the rows: `days` is how many are
stored, `latestDate` the newest, `stale` true when that is over two days old.
Two days rather than one because a run is always for the _previous_ day, so the
newest date is a day behind even when everything is working.

- **Ran and wrote rows:** `days` ≥ 1, `latestDate` is yesterday, `stale` false.
  The log line is `nightly snapshot written` with counts and a duration
- **Ran and wrote nothing:** `days` stays 0. The job logs
  `nightly snapshot wrote nothing` at **warn**, never an info line that reads
  like success

### Known gaps to fix

None outstanding.

### Waiting on the owner

Everything on the old version of this list is done: the accounts are corrected,
both people are enrolled in two-factor, go-live has happened, and the budget has
been corrected to actual and run on real data for weeks.

**Backups were closed on 2026-08-24**, on the owner's instruction, and the last
item from the original go-live list went with them. What was found on the way is
worth keeping: the nightly dump had **never once run**. The directory is created
by `deploy.sh` under `sudo` and so owned by root, the container runs as uid 1000,
and every `pg_dump` since go-live failed with "Permission denied" — logged at
error level each time, into a log nothing read. Dumps land in
`/volume1/backups/delegate`, set by `BACKUP_DIR` in `.env` on the NAS; this
document named the wrong path for months, which is part of why the item stayed
untickable.

Two things now stop it recurring. `deploy.sh` chowns the directory and **proves
the container can write to it** before reporting success. And Settings → Sync
shows the newest dump, with a red banner when none has landed in 48 hours — the
check asks whether a dump is on disk, never whether the last attempt threw.

**Closed on 2026-08-26.** Both halves, and each is recorded here as what it is —
because this item festered for months behind a document asserting something
nobody had looked at, and a confirmation nobody can audit is the same trap set
again.

**Checked.** Settings → Sync showed `delegate-20260825-023000.dump`, 199 KB,
written 2026-08-24 at 21:30 Central — which is 02:30 UTC on the 25th, the
scheduled time. That is the **nightly job firing on its own**, not a forced run:
the forced repair of the 24th is the other row, `delegate-20260824-231646.dump`
at 18:16. Two dumps, both counted, so both carry their `.sha256` — the card only
counts a dump with its checksum beside it. Green, no banner. The first
unattended dump this deployment has ever produced.

**Reported, not checked.** `/volume1/backups` being included in whatever backs
up **off** the NAS. The owner confirmed it on 2026-08-25. It is DSM
configuration and invisible from here — no SSH, no DSM API — so this line is his
word, and a future session should treat it as reported rather than verified. If
it ever matters enough to be sure, the check is Hyper Backup → the task → Backup
Source, and whether the `backups` shared folder is ticked with a destination
that is not on `/volume1`.

**Reported, and the last piece.** On 2026-08-26, after `v0.32.0` and the
`SCHEDULE_TIMEZONE` line went onto the NAS, the owner confirmed the nightly dump
ran at **02:30 Central** and landed in `/volume1/backups/delegate`. That closes
the item: it runs unattended, at a civil hour, in the directory the off-device
backup covers.

His word again rather than an inspection, for the same reason as above — but the
evidence is now on a screen either of us can read. Settings → Sync names the
schedule and the zone it is actually configured with, and names the directory as
**the host** knows it. Until `v0.30.0` that card said "nightly at 02:30 UTC"
whatever the deployment was set to, and showed `/backups` — the path inside the
container, which is true and useless to somebody standing on the NAS looking for
the file. Both were assertions nothing checked, which is how this item stayed
untickable for months in the first place.

**Nothing is outstanding.** The onion address was recorded by the owner on
2026-08-31, which was the last item — reported rather than inspected, like the
off-NAS backup above it, because where he keeps it is not this project's
business. Worth keeping the reason: the address lives in a Docker volume, and
losing the volume does not lose access, it loses the _name_ — it cannot be
recovered, only replaced, and every device that had the old one stops working.

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
makes them **and chowns the backup directory to uid 1000**, which the container
runs as; and the `tor` service builds from source, so the first deploy after it
landed takes noticeably longer.

A successful deploy now ends with `Backups: the container can write to the backup
directory.` If it instead prints a warning, the nightly dump will fail silently
until the chown it names is run — that is the one failure this project cannot
catch anywhere but on the NAS.

`sudo docker …` does not work on DSM: `sudo` resolves the command against
`secure_path`, which does not include `/usr/local/bin`. Use `sudo -i sh -c '…'`,
which runs root's login shell and gets a full `PATH`.

Exposure is through a **Cloudflare Tunnel**, working, with two-factor in front.
Cloudflare Access was declined. A Tor onion service is the alternative path and
is off until switched on from the LAN — see ADR 027, and note that running both
means the weaker door sets the security level.

**Model Context Protocol support was built and then removed** at the owner's
direction, in v0.15.0 and v0.16.0, and taken out again in v0.17.0. It is not on
the roadmap and should not be reintroduced without him asking for it. The only
trace left in the tree is
`apps/api/prisma/migrations/20260819180000_drop_api_tokens`, which exists
because migrations are forward-only (ADR 003) and the creating migration had
already been applied to the deployment — deleting that file instead would leave
`migrate deploy` reporting drift.

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
- **Docker is installed** — colima, since 2026-08-19. `npm run verify` now
  completes: it builds the image, starts it, and asks it for `/health`.
  `verify:quick` still exists for a fast loop and skips exactly that step. Run
  `colima start` if a build reports no Docker daemon; `colima stop` gives the
  RAM back.

  Two things it still does not prove. It produces an **arm64** image and the
  DS220+ is x86_64, so it shows the Dockerfile is correct rather than that a
  native module has a prebuilt binary for the NAS — which is why the NAS builds
  its own from source (ADR 019). And `docker-compose.yml` is still reasoned about
  rather than executed, so say so plainly when changing it.

  **`tor/` is no longer in that category**, and the cost of it having been there
  is worth remembering. The image and its entrypoint shipped un-run, carrying
  `HiddenServicePort 80 app:3000` — a parse error, because tor does no DNS for
  that directive. The container died at startup and restarted for ever, no onion
  address was ever created, and the only symptom anywhere was Settings reporting
  "No onion address yet", which is also what it says when nothing is wrong.
  Nobody could tell the two apart for two weeks.

  `npm run verify` now runs `tor --verify-config` against the real file. It is
  offline, takes about a second, and would have caught this before it left the
  Mac. The whole service can be exercised locally too — build `./tor`, run it on
  a network with a container aliased `app`, and watch for the address.

  **The first thing this caught was a lie in `.dockerignore`**, on its very first
  run. `*.tsbuildinfo` is anchored at the root, so
  `packages/shared/tsconfig.tsbuildinfo` was copied into the build context — and
  a stale one is a lie `tsc --build` believes: it concludes the project is
  already built, emits nothing, and every workspace importing `@budget/shared`
  then fails to resolve it. The pattern is `**/*.tsbuildinfo` now.

  Worth knowing _why_ nobody had hit it. The NAS builds from a `git archive`
  tarball, which carries no ignored file at all, so the local build context and
  the deployed one were different and only the local one was broken. **If a build
  fails here while the NAS is fine, suspect that difference before suspecting the
  release.**

- **Colima can wedge, and it looks exactly like flaky tests.** It has happened
  once, on 2026-08-20. End-to-end tests began timing out at about 42 seconds
  each, a _different_ one every run, and the suite took 9.2 minutes instead of
  40 seconds. Nothing was wrong with the branch and there were no orphaned
  servers — but `ps aux` itself was taking over two minutes to return and
  `colima status` did not answer at all. `colima stop` took roughly an hour to
  complete; load average dropped from 5.14 to 2.66 the moment it did, and the
  suite came back green in 2.0 minutes.

  So if end-to-end tests start timing out on a different test each run, check
  the machine before the branch: `uptime`, and whether colima answers. **Do not
  raise a Playwright timeout to make it go away** — a timeout raised to paper
  over contention is how the racy tests in this suite got written the first
  time. `colima start` again when the image step is needed.

- **Orphaned servers are the other thing to watch for.** A `verify` run that is
  interrupted can leave `node apps/api/dist/server.js` running against the
  **test** database, still executing the sync, price and backup schedules. It
  answers `/health` perfectly well, so the next run looks broken for reasons that
  have nothing to do with the branch — that cost an afternoon once, with two
  end-to-end failures and an eleven-minute hang on a documentation-only change.
  `ps aux | grep 'apps/api/dist/server.js'` before believing a strange failure.

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

npm run test              # 173 unit
npm run test:integration  # 510 integration
npm run test:e2e          # 160 end-to-end, needs a build first
```

`npm run verify` is the gate. It runs migrations, typecheck, lint, formatting,
the forbidden-terminology rule, the dependency audit, all three suites, the
cached-balances-against-ledger check, a real backup-and-restore, and the image
build. It replaced GitHub Actions and is the _only_ thing standing between a
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
- **Reconnecting an institution at the bridge changes every account's external
  id.** Delegate matches on that id, so the accounts come back looking new and
  collide with the originals on the partial unique index over `lower(name)` —
  which then repeats every hour forever. `upsertAccount` adopts an account whose
  id the feed no longer mentions. The distinguishing signal is exactly that: an
  institution that is merely erroring still lists its accounts.
- **A failure while ingesting one account used to fail the whole run**, so six
  connections went stale because one had been reconnected. Reported and skipped
  now. Worth remembering as a shape: this sync touches several independent
  things, and a loop over them should not be all-or-nothing.
- **A boolean in a query string is text.** `z.coerce.boolean()` is
  `Boolean(value)`, so `?uncategorized=false` meant `true` and the Transactions
  page's Categorized filter showed the queue. Parse with `booleanQuery` in
  `http/serialize.ts`; there is one place for it now.
- **The SimpleFIN bridge silently caps a long date range** at 90 days and reports
  it as a note, not an error. A twelve-month request returned three months while
  looking entirely successful. Requests are split into 45-day windows, which is
  what the bridge recommends. Real accounts hold roughly **six months** of
  history, whatever the window.
- **Only run against real data finds real bugs.** The first live sync classified
  a credit card as an asset because the signal was in the institution name, not
  the account name — which would have thrown the identity off by twice the
  balance in the wrong direction.
- **Resetting your own second factor may or may not end your session**, and
  nothing decides which. The reset deletes that account's sessions; the request
  that did it then writes its own session back, because `rolling: true`
  refreshes the expiry on every response, and the two are not ordered against
  each other. Both landings are fine — signed out, or sent to enrolment — so the
  end-to-end test accepts either. Worth making deterministic if it ever matters:
  the choice is to destroy the actor's session deliberately, which is arguably
  what removing your own credential should do.
- **`compose up -d` does not rebuild a service it already has an image for.**
  `tor` is the one service built from source here, and its configuration is
  _mounted_ while the entrypoint that reads it is _baked in_. A release changed
  both; the deploy shipped the new file to the old script, which knew nothing
  about the placeholder in it, and tor reported an unparseable port and restarted
  for ever. `deploy.sh` passes `--build` now. **When one half of a pair is
  mounted and the other is in the image, a deploy can ship one without the
  other.**
- **A check that exercises the artefact is not the same as one that exercises
  the thing.** `tor --verify-config` over a hand-substituted torrc passed on the
  very release whose container was crash-looping, because it proved the file was
  valid and never that the entrypoint produced it. `npm run verify` starts the
  real image against a container aliased `app` and asks tor whether it started.
  Twenty seconds, and the only thing that would have caught it.
- **A bind mount replaces the image's directory, ownership and all.** The
  Dockerfile ran `chown -R node:node /backups` and it counted for nothing: at
  runtime the host directory takes that path, and the host's ownership is what
  the process meets. `deploy.sh` created it under `sudo`, so it was root's, and
  the container runs as uid 1000. Every nightly `pg_dump` since go-live failed
  with "Permission denied". Anything done to a mount point at build time is
  decoration — the check that matters runs on the machine that has the mount,
  which is why `deploy.sh` now writes a file there before reporting success.
- **A thing that fails quietly is worse than one that does not run at all,
  because it is trusted.** That sentence was in the comment at the top of
  `backup.sh` while the backup it describes failed every night for weeks. The
  code was right and nobody was reading it. What was missing was the question
  asked from the other end: not "did the attempt throw" — which was answered
  correctly, into a log — but "is there a recent dump on disk", which nothing
  asked until somebody went looking by hand. **When something matters, check for
  the evidence it leaves, not for the absence of an error.**
- **Before believing a suite of failures, look at the machine.** The end-to-end
  suite once took **1.3 hours** instead of two minutes, with seven multi-minute
  timeouts scattered across specs the branch had not touched — each of which
  passed in under a second on its own. The Mac had 41 days of uptime, load
  average near 6 at rest and WindowServer at 45% CPU. A restart fixed all seven.
  Scattered timeouts in unrelated specs are an environment signal, not a code
  one; `uptime` costs nothing to check.
- **After a restart, wait before testing.** Load average was **110** two minutes
  in and took about seven minutes to fall below four. Testing into that
  reproduces exactly the flakes you are trying to rule out.
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
as written. **`docs/ui-system.md` is the measurements**: the spacing scale, field
widths, button rules and the text budget every screen uses. Read it before
touching any interface, and note that `ui-system.test.ts` enforces the mechanical
half by reading the source — a UI change that ignores the scale fails `verify`
rather than merging quietly.
Six conflicts with the build prompt were found and resolved with the
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
