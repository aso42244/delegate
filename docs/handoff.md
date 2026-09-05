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

**`main` is at `v0.54.0`, and the NAS is running `v0.53.0`** — deployed
2026-09-05.

`v0.54.0` was tagged first and its publish workflow hung, so `v0.53.0` was
deployed while that was still building. The only thing `v0.54.0` adds is the
stored pair refusal (`pair_dismissals`) and its migration.

**Assume a version you handed over is deployed.** The owner's instruction, given
the same day: once the deploy command has been handed to him, treat the NAS as
being on that version unless he says otherwise. He will say if he has not. Do not
ask, and do not leave this paragraph carrying a stale figure with a question
attached to it — which is exactly what it was doing when he corrected it.

Should it ever genuinely need checking, there is no version anywhere in the
application to read it from: `/health` is deliberately quiet about it and nothing in the UI shows
it, so the two ways to answer the question are the running image
(`docker ps` on the NAS, which reports the digest `deploy.sh` pinned) and a
feature that only exists in one of the two candidates — `Rules` in the sidebar
means `v0.51.0` or later. Worth a column one day; not worth guessing meanwhile.

Note that **`v0.46.0` has no published image**. Its workflow run never produced
one, so a deploy must name `v0.47.0` or later; everything `v0.46.0` contained is
in the releases after it.

The pattern is worth keeping. Each of the last three releases came from the owner
using the previous one against real data and sending screenshots — the thrift shop
listed as a fortnightly bill, "Every Monthly" in a column header, home insurance
that needed two dates a year. None of it was visible from a test fixture, and all
of it was obvious within a minute of real use. One thing to know about `v0.41.2`: the `deploy.sh` fix
in it ships _inside the file being replaced_, so a `--unpack` deploy still runs
`v0.41.1`'s copy and the one after that gets the fix. The registry route is
unaffected, and that is the ordinary deploy now.

**Delegate installs anywhere in one line now**
([ADR 042](decisions/042-delegate-installs-anywhere-in-one-line.md)):
`docker compose up -d` with nothing configured. Secrets are generated on first
boot, the first account is claimed with a token from the logs, HTTPS is one flag,
and the image is published multi-arch on version tags. The NAS is one deployment
of many rather than the deployment, and it keeps working — it adopts the secrets
already in its `.env`.

318 unit, 735 integration and 217 end-to-end tests. There is no CI: GitHub stores the code and nothing else
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
- **A rolling session has a ceiling it cannot roll past** — 90 days from
  `created_at`, never extended. Without it, a session that keeps being used never
  expires at all, which is precisely the session somebody else might be holding
- **The routes that decide _where_ this server sends a request** are
  administrator-only. The line is choosing a destination, not making one: syncing
  and checking the node use what is already stored and stay open to everybody
- **A record of what happened to credentials, with the screen that reads it**
  ([ADR 041](decisions/041-an-audit-log-ships-with-the-screen-that-reads-it.md)).
  Refused twice before, and built the third time only because the owner asked for
  the screen with it — a table nobody queries is the dead-backup trap. It is also
  the one table here that is **pruned**, at 90 days, because it is the only one an
  unauthenticated stranger can cause writes to
- **A failed sign-in never writes down what was typed** unless it names a real
  account. The login form has two fields, and a password in the top one used to
  reach the logs verbatim

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

**Since v0.34.0 — the phone, and what it found**

Almost all of this came from the owner using Delegate on a phone and sending
screenshots. Nothing here was visible on a desktop, and none of it was caught by
a test until it was written to be.

- **A dialog is measured against the visual viewport, never the window**
  ([ADR 038](decisions/038-a-dialog-is-measured-against-the-visual-viewport.md)).
  A software keyboard is composited _over_ the page on iOS: the layout viewport
  keeps its full height while the visible rectangle shrinks, so a sheet anchored
  to `bottom: 0` is anchored behind the keys. Measured at 390×844 the
  categorization sheet ran to y=844 with 430 on screen — one option above the
  fold and Cancel 361px below it. `Modal` reads `window.visualViewport`, and a
  dialog is now a column: header, scrolling body, and a `footer` for whatever
  must stay reachable from anywhere in the body. **Nothing inside a dialog
  scrolls itself**; one scroll container, and an inner cap in `vh` is a cap
  against the viewport the keyboard just invalidated
- **Every notification is a pill in the page header**
  ([ADR 039](decisions/039-a-bar-is-for-what-costs-data.md),
  [ADR 040](decisions/040-every-notification-is-a-pill.md)). There is no banner
  and nothing renders above the page — `NotificationPills` is rendered by
  `PageHeader`, so they reach every screen. Two or three words on the face
  (`pill` on the DTO), the whole message on hover or focus, and a press goes
  where the condition is dealt with. **Red is a pill too**: severity is carried
  by the colour and by the words, the way every other state here carries it, and
  floor space was saying it a third time. Snoozing went with the bar, so nothing
  can be hidden for a day any more
- **The backlog pill opens the queue**, `/transactions?uncategorized=true`. That
  filter lives in the URL rather than in component state, which is what lets the
  sidebar mean "the register" and the pill mean "the ones I have not dealt with"
- **Everything on a control row is 28px** — buttons, `.field` inputs and selects,
  the segmented control. It is written down in `ui-system.md` and nowhere else
- **Insights reorders without dragging.** HTML5 drag fires no events under a
  thumb and is not reachable by keyboard, so the grid's order was fixed on a
  phone while a `⠿` handle was drawn over it. Move earlier / Move later replace
  it
- **A utility's chart starts where its history does.** Leading empty months and
  an incomplete trailing one are dropped; an empty month _between_ two bills
  stays, because compressing it out would redraw the history as though the bills
  were consecutive (`pages/utility-months.ts`)
- **The row `⋯` is gone on a touchscreen** in favour of a long press, with the
  trigger kept visually hidden rather than `display: none` — VoiceOver cannot
  perform a long press, so it still needs something in the accessibility tree
- **A figure is inset 12px from the right**, mirroring the name column's `pl-3`.
  This reversed part of v0.34.0 and both were right in turn: the earlier change
  removed a _ragged_ gap between a figure and the rule, which is what exposed the
  real asymmetry underneath
- **The register no longer counts itself.** "494 transactions" is a fact about
  how long the household has been running, not about the list somebody came to
  work through; it is on Settings → Sync beside the connection that produced it

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

**Since v0.41.2 — the queue teaches the rules (`v0.42.0`)**

Two halves of one idea, and the reason they shipped together is that they share a
normalization neither can drift from.

- **An uncategorized row says where that merchant went before**, with the count
  behind it — `2 of 2 before went to Grocery` — and one press files it
  ([ADR 044](decisions/044-the-queue-teaches-the-rules.md)). It writes nothing
  until pressed, needs two prior decisions and a **majority** of them, and
  ignores splits and archived delegations. A merchant is recognised through the
  store number that changes on every visit, which is the whole trick: grouping on
  the description itself finds no history at all.

- **"Always categorize like this"** on the row menu turns that decision into a
  rule. `POST /api/rules/from-transaction` had existed for months and was **called
  by nothing** — no interface, no test — and reading it explained why nobody
  missed it: it built the rule from the _whole_ raw description, so a rule from
  `AMAZON MKTPL*RT4G93` would have matched exactly the transaction it was built
  from and nothing else, for ever, silently. The needle is the merchant part now,
  and it is offered **in a field the reader can edit** because where a merchant's
  name ends is a guess

- **A rule can say what a transaction _is_**, not only which envelope it belongs
  in ([ADR 043](decisions/043-a-rule-does-one-of-two-things.md)). The paycheck
  arrives from the same payer on the same fortnight and was the one thing no rule
  could ever touch: it lands as ordinary spending and somebody marked it income
  by hand, every fortnight, for ever. A rule carries an **action** rather than a
  destination — a delegation, or a label — and exactly one of the two, held by a
  check constraint rather than by convention. A labelling rule never touches a
  categorized row even under `includeCategorized`, because `updateTransaction`
  refuses that for one row and a bulk action must not do what the single action
  refuses

- Two things deliberately **not** built, both recorded in ADR 044: a bulk "accept
  every suggestion", and a preview of what a new rule would match. The second is
  the one worth revisiting — Settings → Rules previews the bulk apply and this
  dialog previews nothing, so a needle that is too broad shows up only after the
  next sync

**Since v0.42.0 — Bills, and the way out (`v0.43.0`)**

- **Bills is a page of its own**, sixth in the sidebar
  ([ADR 045](decisions/045-a-bill-is-inferred-not-entered.md)). Everything on it
  is worked out from the register and **stored nowhere** — there is no bills
  table and nothing to maintain, because a hand-kept list of bills is a second
  copy of what the transactions already say and is wrong within a month, in the
  direction nobody notices.

  It answers the one question nothing else here can: **the bill that did not
  arrive.** Every other condition this application raises is about something that
  happened; a failed autopay leaves no trace and looks exactly like a quiet
  month. Typical and last sit beside each other on the row, so a subscription
  that renewed higher shows up too.

  The bound that does the real work is **nothing faster than a fortnight**.
  Groceries and coffee recur in the plain sense and their gaps are regular enough
  that a tolerant check would call the weekly shop a weekly bill. A bill that has
  plainly stopped reads `Stopped?` and raises nothing — a warning nobody can act
  on teaches people to stop reading warnings

- **The overdue pill has a switch**, on Settings → Budget, and it is the first
  notification here that does. It is the right one to have it: every other
  condition is a fact the application knows, while this is a reading of a
  schedule it inferred. **The page stays either way** — hiding the list as well
  would make "I turned the noise off" and "there are no bills" indistinguishable

- **Export**, on Settings → Sync: the register, the delegation ledger and the
  nightly snapshots, as three CSVs
  ([ADR 046](decisions/046-the-export-is-three-files.md)). Three rather than one
  because a split has one amount and two envelope movements, so one wide file
  would either double-count the amount or lose the split. Money is a **decimal**
  rather than cents — ADR 002 is a rule about JSON, and a spreadsheet column of
  `-4210` is one somebody sums and acts on — and a description that a spreadsheet
  would otherwise _run_ is defused on the way out. **It is not a backup**: no
  ids, no credentials, and it cannot restore anything

- `merchantKey` is now load-bearing in three places — suggestions, the rule
  dialog, and what counts as one bill. That is why it lives in `@budget/shared`,
  and why a change to it now moves three features at once

**Since v0.43.0 — targets, and the promise around them (`v0.44.0`)**

- **A delegation can carry a target**: what it is saving towards, and by when
  ([ADR 047](decisions/047-a-target-never-moves-an-amount.md)). This is the
  migration `architecture.md` had been anticipating beside `notes` — the owner
  was writing `"$2200, Dec 27"` there and doing the per-paycheck arithmetic in
  his head.

- **It never moves the amount to delegate, and that is the whole feature.** That
  figure is multiplied by every line on the next Delegate press, so an
  application that rewrote it on its own would be moving real money for a reason
  nobody asked for. A target only judges it: the dialog shows what each remaining
  paycheck would have to carry beside what the line is set to, and offers to
  apply the figure behind **a switch that is off unless somebody turns it on**.
  Afterwards it is an ordinary amount — typed over, cleared, left alone. The
  owner asked for exactly this: optional, overridable by hand, and unmistakable
  about what setting one does

- **The chip says a target exists; the amount to delegate says whether it is
  being met.** `tg` beside the name, and the figure itself turns warning with the
  sentence on hover and through `aria-describedby`. A yellow letter beside a name
  says something is wrong without saying which number to change

- **The pill has no switch**, unlike the overdue bill from ADR 045, and the
  difference is worth keeping straight: a bill is a schedule this application
  _inferred_, while a target is a number the household typed. Turning off
  arithmetic on their own figures is hiding the answer to the question they asked

- `notes` is a note again. Existing notes are untouched, including the ones that
  say `"$2200, Dec 27"` — a text field somebody wrote by hand is not something to
  parse and overwrite

**Since v0.44.0 — the first real run of Bills, and what it asked for (`v0.45.0`)**

- **A bill can be taken off the list, or given a name of its own.** Thirteen
  bills came out of the owner's real register and one of them was **SAVERS**, a
  thrift shop visited every fortnight. The detection was not wrong in a way any
  threshold could fix — that spending genuinely has the shape of a fortnightly
  bill — so the fix is that a person can say otherwise. Amendment on
  [ADR 045](decisions/045-a-bill-is-inferred-not-entered.md).

- **"Stored nowhere" still holds for bills.** `bill_overrides` contains no bills,
  no dates and no amounts; every figure is still derived on every request. It
  holds the one class of fact that cannot be derived — what somebody said back.
  Hidden rather than deleted, listed under a fold with `Put back`, and a rename
  **labels** rather than replaces: the bank's text stays under the name and stays
  searchable, because reconciling against a statement needs the words the
  statement uses

- **Two corrections and no more.** Every other figure on the row is arithmetic
  over transactions and would be a lie if it were editable. If the cadence looks
  wrong the answer is that this is not a bill, never that the number should be
  overwritten

- Lapsed bills sort to the bottom now. A lapsed bill's expected date is in the
  past by definition, so a plain date sort put the least actionable row at the
  very top — which is exactly where the first real run put that thrift shop

**Since v0.45.0 — the first targets and bills entered for real (`v0.46.0`)**

Everything here came from the owner using the two features against his own data
and sending screenshots. None of it was visible from a test fixture.

- **A target can repeat**, and its date is an **anchor** rather than a deadline
  ([ADR 047](decisions/047-a-target-never-moves-an-amount.md), amended). The
  first one entered was home insurance: $2,200 on the last day of April and again
  on the last day of October. A single date recorded the April one and went stale
  the moment it passed, leaving the same target to be retyped twice a year —
  which is the by-hand arithmetic the feature exists to stop.

  **Months, not days**, because the last day of April recurs on the last day of
  October and no number of days says that. `addMonthsToDayKey` keeps the end of
  the month and clamps a day the next month does not have

- **The amount the dialog offers is editable.** The switch reveals a money field
  holding the calculated figure, and what is written is whatever is in it.
  $274.38 a paycheck is more likely to be funded at $300, and that decision
  belongs in the moment it is being made rather than on the row afterwards

- **`updateDelegation` resolves the target's three fields once** and validates and
  writes from that. Doing it any other way went wrong twice in one afternoon —
  the fields constrain each other and a request usually mentions one of them

- **Bills, from the same review**: the column is `Cadence` rather than "Every"
  ("Every Monthly" is not a sentence); a renamed bill shows its name alone with
  the bank's text moved into the row menu, where it stays searchable; and nothing
  says "fortnightly" any more — Settings → Budget already calls that cadence
  "Every two weeks"

**And the shell, from the same review (`v0.46.0`)**

- **Settings is eight sections rather than twelve**, grouped by the question
  somebody came to answer. Half of the twelve held a single card. **Every old
  route redirects** — a section that moves is a bookmark that breaks and a test
  that fails for a reason unrelated to what it tests
- **Settings cards are a three-column grid**, and a card declares its `span`,
  defaulting to the whole row. Display was three radio groups stacked down a
  1,200px page, each using a fifth of its own row
- **Where the section list sits is a per-device preference** — a row on top or a
  rail down the side. The rail lives inside the Settings page rather than in the
  shell: it belongs to Settings and disappears with it
- **The sidebar is `w-fit`**, as wide as "Transactions" needs and no wider. It
  was a flat 232px. The two things that make intrinsic sizing safe are written
  down in `ui-system.md` §12: labels hold their line, and anything of
  uncontrolled length is capped, because `w-fit` takes the widest child and an
  email address is wider than anything anybody navigates to

**And the second pass over the shell (`v0.47.0`)**

- **Assets, Debts and their headings can be dragged into an order.** Delegations
  have had a position since v0.24; the same argument applies one level up and one
  level across, and the owner asked for it the day he first used the page.
  Nothing moves until it is moved — every row starts at zero and a tie falls
  through to the name — so an untouched budget still reads alphabetically. The
  account row menu and Settings → Budget's arrows are the routes that work
  without a mouse
- **Settings cards on one line end level**, and the grid counts in **sixths** so
  a card can be a half. Three columns could not express "two side by side"
- **Holdings is Bitcoin beside Properties**, with the node folded into the
  Bitcoin card: where address data comes from is a property of those holdings
  rather than a subject at the same weight. **Access is three across then two**
- The card prop is `span`, not `width` — a field's `width` is its own scale, and
  two vocabularies under one name is a trap
- **A drop lands on the edge the pointer is nearest.** Dropping onto a row always
  inserted _before_ it, so nothing could be placed last — found by the owner in
  the first minute of using it. A heading dragged over another grouping's rows
  means "past that grouping", which is how the bottom of a long section is
  reached; what is being dragged is kept in state because `dataTransfer` is empty
  during `dragover` in every browser
- **The sidebar's toggle is a drawn icon** rather than `«`/`»`, and joins the
  icon column when collapsed. Same mistake the nav icons were fixed for

**Since v0.47.0 — three themes, and duplicates found rather than stumbled on (`v0.48.0`)**

- **Six palettes now**: Light, Dark, System, plus **Ledger** (monospace on warm
  paper), **Reading light** (dim parchment, for late on) and **High contrast**
  ([ADR 048](decisions/048-a-theme-is-a-palette-that-is-measured.md)). A theme is
  a token swap and nothing else — colours, `--font-sans`, `--tracking-label`

- **`theme-contrast.test.ts` measures every palette** against WCAG AA on the
  pairs that actually appear on screen. **It found six pairs in the shipped
  Light palette under 4.5:1**, the worst being positive green on its own green
  fill at **2.76:1**. They are recorded at today's values rather than changed:
  `design.md` §2 is the owner's settled specification, so tightening them is his
  call — and they can no longer get worse without the gate failing. **This is an
  open question for him, not a closed one**

- **Possible duplicates are read out** on the Transactions page
  ([ADR 049](decisions/049-a-duplicate-is-proposed-never-archived.md)): same
  account, same amount to the cent, within two days. It writes nothing. The
  re-import case is the one from `handoff.md` — reconnecting an institution
  brings a card's whole history back, and until now that was found by noticing a
  balance was wrong

- **No pill for duplicates**, and the reason is worth keeping: one was built and
  taken out within the hour, because it is computed on the server and went on
  saying "1 possible duplicate" after the panel had been waved off. ADR 030 is
  why it was not fixed by storing the refusal. The uncategorized-backlog pill
  already leads to that page

**Since v0.48.0 — a card's content stays inside the card (`v0.49.0`)**

- **A settings card is a query container.** The backups table drew its columns
  out past the card's border and under the card beside it: it sized itself with
  `sm:`, which asks how wide the _window_ is. That was the right question while a
  card was always the whole row and the wrong one from the moment cards started
  taking a third of it — on a 1440px screen that card is 345px across and was
  being handed the 640px layout. **Content inside a card uses `@sm:`/`@md:`/`@lg:`
  now, never `sm:`**, and an e2e test measures the boxes rather than reading the
  text, because this failure was invisible to every test that only looked for
  words

- **Delegations and Groupings share a row** on Settings → Budget. Groupings paid
  for the width with its Section column, which repeated one identical word down
  every row — a heading above each section now, and no heading over an empty one

- **The three export links read on one line each**

- **The Light palette's contrast exceptions are settled, not outstanding.** Asked
  whether to tighten the six sub-AA pairs, the owner kept the palette as designed;
  High contrast is the answer for anyone who needs more. ADR 048 and the test say
  so, so this does not come back as a question

- **A GUI deploy button was scoped and then dropped**, deliberately. A container
  cannot replace itself with a different image, so the only two routes are a
  root-owned watcher script on the NAS or mounting `/var/run/docker.sock` into
  this container. The second hands root on the NAS to the process that holds the
  bank credential and faces the tunnel, and is not on the table. The owner chose
  to keep the one-line deploy as the only way in. **Do not build this without
  asking him again**

**Since v0.49.0 — the duplicate panel was wrong twice (`v0.50.0`)**

Both of these were mistakes in **ADR 049 itself**, not in the code that
implemented it, and both were found the first time a person used the feature
against real data. Worth reading as a pair.

- **The match ignored the description.** `ACH Payment Strike (Zap Solu` and
  `ACH Payment City of Sioux Fa`, both $60.00, two days apart on one account,
  were offered as one charge twice — a household paying two bills in a week.
  ADR 049 argued a different description is still a duplicate, because a feed
  rewords its own text between pending and posted. **That reasoning bought a
  speculative case and paid in false positives:** a re-import, the case the
  feature exists for, replays the feed's own rows, so the descriptions come back
  identical and never needed the looseness. `merchantKey` is in the bucket now

- **"Not a duplicate" lasted a session.** So the same wrong pair returned on
  every page load — and because two settled transactions never change, it
  returned for ever. **ADR 030 was the wrong authority to borrow.** A cleared
  check's proposal expires by itself once the check clears; there is nothing to
  remember. Two settled rows are permanent, so the proposal is permanent, so the
  refusal has to be too. `duplicate_dismissals` stores it, **keyed on the pair
  rather than on a row**, so both rows stay eligible against anything else

- The general lesson, which is the one to carry: **a proposal that cannot be
  refused permanently is one somebody stops reading.** `bill_overrides` learned
  it about the thrift shop; this learned it again. Before citing ADR 030 for a
  new proposal, check whether the thing being proposed about can expire on its
  own. If it cannot, the refusal has to be storable

**Since v0.50.0 — the page contradicted the register (`v0.51.0`)**

- **A bill whose charge was still pending read as Overdue.** A $30.96 life
  insurance payment sat in the register while the Bills page said **Overdue ·
  5d**. Pending charges are excluded from bill detection because a pending date
  moves when it settles — **a sound reason about arithmetic, applied to the whole
  row**, so the charge that answers "has this arrived?" was excluded from
  answering it. Pending charges are separated now: the schedule is still fitted
  from settled ones only, and a pending charge newer than the last settled one
  reads **Paid, pending** and announces nothing.

  The shape of this mistake is worth carrying: _a filter justified by one
  question was applied to every question._ Worth checking wherever a `where`
  clause carries a comment explaining why

- **A bill can be told its charge arrived**
  ([ADR 051](decisions/051-a-bill-can-be-told-a-charge-arrived.md)). The general
  case no threshold reaches: a merchant that renames itself gets a new merchant
  key, so its old bill goes overdue for ever while the new one needs three months
  to be detected at all. **A link moves the last-seen date and never the
  cadence** — fitting one would put a gap in the history that fails the tolerance
  test, and the bill would vanish from the page, which is a spectacularly
  unhelpful answer to "this did arrive"

- **A suggested categorization asks before it files.** The evidence behind the
  guess lived on a `title` — invisible to anybody not hovering — and the press
  was immediate and silent. Three answers now, and the third, **Confirm and
  always**, writes the rule. That route existed but was buried in a row menu and
  reachable only _after_ the row was filed, which is not the moment somebody
  knows the decision repeats

- **Rules left Settings for the sidebar.** Seven settings sections;
  `/settings/rules` redirects. A rule is written while categorizing and read when
  a charge lands somewhere surprising — the register's rhythm, not a thing
  configured once

- **The sidebar is 180px**, up from the ~145px `w-fit` gave it and short of the
  232px it started at, and the gutter beside it is back to the 32px `design.md`
  §4 asks for. Both from the owner looking at it: the first width was right
  arithmetic and read as cramped

**Since v0.51.0 — the feed broke, and two things about that were wrong (`v0.52.0`)**

Both were found by the owner using Delegate through a real SimpleFIN outage on
two of his institutions, entering by hand the charges his bank showed and this
did not. Neither was visible from a test fixture and neither had a test.

- **The request window was measured from the last successful run**, and a run
  succeeds while one institution is dark — the bridge answers, lists the account,
  and reports the problem in `errlist`, which is correctly not a failed sync. So
  `last_success` advanced every hour through the outage and the window stayed at
  seven days however long it ran. On the day the connection came back, a ten-day
  gap was asked about for eight days and the rest was never requested again: the
  bridge still held those transactions, and nothing ever asked.

  It is read from the evidence now — per account, the newest transaction the feed
  delivered or the balance date it stamped, whichever is later — and a backfill
  button was scoped first and dropped, because it only works if somebody
  remembers to press it on a day they may not know an outage happened.
  [ADR 009](decisions/009-simplefin-sync-cadence-and-window.md) amended.

  Two guards the shape needs. **A dormant account is not a broken one** — a
  savings account with no activity for two months still gets a fresh balance
  date, and judging on transactions alone would pin the window at its 90-day
  ceiling for ever; `feed_balance_as_of` is the second time ADR 032's column has
  paid for itself. And **manual rows are not evidence**, or entering the missing
  charges by hand would silently close the window the recovery depends on.

- **Standby mode**, which is the rest of it. A hand-entered row on a synced
  account used to increment `accounts.balance_cents`, and `upsertAccount`
  assigns that column from the feed on every run, so the entry worked and then
  silently did not, up to an hour later. **758 integration tests passed before
  and after the behaviour changed** — nothing had ever covered it.

  The stored column is the institution's alone now, and the adjustment is
  applied on read: the figure somebody sees is the bank's plus what has been
  typed in since its feed went quiet. **There is no tag and nothing to switch
  on** — a manual row on a synced account is a standby row by construction,
  while one on a manual account is the ordinary case and still moves the balance
  directly. New chip `a`, and the identity uses the adjusted balances too,
  because a reconciliation computed from figures nobody can see is a reading
  that cannot be checked.

  **Coming out of standby is announced**, because nothing else would say the
  outage was over — the balances read correctly either way. The existing
  duplicate panel could not find these pairs: it matches on `merchantKey`, and
  `manual pirate ship` against `ach payment pirate` is not a near miss. So a
  second rule matches a hand-entered row against a feed row on the same account
  by amount and date alone. **Safe there and nowhere else** — ADR 049's false
  positive was two _feed_ rows at one amount in a week, which is a household
  paying two bills, whereas a hand-entered row on a synced account exists only
  because somebody was standing in for the feed.

  The pill for it clears itself once the rows are archived, which is exactly the
  objection that removed the v0.48 duplicates pill. Before reaching for that
  precedent again, check whether the proposal's own action makes it go away.

**Since v0.52.0 — the budget boundary, and a lesson that had already been written down (`v0.53.0`, `v0.54.0`)**

Both releases came out of one screenshot: a $200 Roth contribution, the four ETF
purchases it paid for, and a transfer suggestion offering to undo a correct
categorization.

- **The budget boundary is a wall now, not a description**
  ([ADR 050](decisions/050-the-budget-boundary-is-a-wall.md)). `in_budget`
  decides which accounts the identity sums, and nothing else knew that. Three
  places crossed it. **Categorizing an off-budget row was permitted** and moved a
  delegation while no summed balance moved with it — measured at exactly $200.00
  of drift from a reading of zero. **A transfer was suggested across it**, and
  `confirmPair` clears both sides' allocations, so confirming would have taken
  the money back out of the envelope it was correctly spent from. **The queue
  held rows that could never leave it** — the same case income and confirmed
  transfers were excluded for, missed when that filter was written.

  The judgement worth keeping: **money leaving the budget for a retirement
  account is spending, not a transfer.** The envelope budget's subject is not net
  worth but what is left to allocate, and money in an IRA is not. The envelope it
  came out of is the record; the arrival is the same money seen from outside, and
  counting that too would double it.

- **A refused pair stays refused.** "Not a pair" was a `Set` in component state,
  so it lasted until the page reloaded and the same wrong suggestion came back
  for ever. `pair_dismissals` stores it now, keyed on the pair.

  **This is the lesson to actually carry from these two releases.** It is the
  identical defect `duplicate_dismissals` was created for in v0.50.0, in the
  sibling panel — and the rule that catches it was already written in this
  document, in the v0.50.0 section: _before treating a refusal as not worth
  keeping, check whether the thing being proposed about can expire on its own._
  Nobody applied it to pairing. A lesson recorded against the feature it came
  from is a lesson that only fixes that feature. **When one of these rules is
  written down, go and check every sibling it could apply to the same day** —
  this application proposes in at least five places (duplicates, pairs, cleared
  checks, categorization suggestions, inferred bills) and they do not share an
  implementation.

- Smaller, from the same review: an off-budget row reads `—` in the Delegation
  column rather than an empty cell, because empty reads as "not loaded" and the
  em-dash reads as "deliberately nothing". Caught by reading the render path
  after the owner asked what those rows would look like — no test distinguishes
  an empty cell from an em-dash one.

### Known gaps to fix

None outstanding. The September security review is closed — see
[docs/security-review-2026-09.md](security-review-2026-09.md).

**The four operational items are down to one, and it is deferred.**

- **`secrets:rekey`** — no longer needed. [ADR 042](decisions/042-delegate-installs-anywhere-in-one-line.md)
  makes the first boot write the at-rest key into the secrets volume, seeded from
  `SESSION_SECRET` on a deployment that already had one. The value does not
  change and nothing is re-encrypted, so the split ADR 029 wanted happens by
  upgrading.
- **The `delegate_app` role** — still opt-in, two steps in the README. Nothing
  can tell a fresh install from an upgrade at the moment the connection string is
  written, so making it automatic would break existing deployments.
- **The `tor-keys` volume** — **declined by the owner on 2026-09-01.** He does
  not want the onion address preserved and will derive a new one as needed. ADR
  027 carries the amendment; this is a decision, not a gap.
- **Pinning base-image digests** — deferred to the next deliberate base bump, as
  before.

**Nothing is waiting on the owner.** The NAS is deployed and healthy, the
published package is public, and every operational item is closed or decided.

### Where a new session should probably look first

Not a backlog — there is none. These are the things most likely to be worth
doing next, in the order they would pay off:

- **Three ideas are on the table and the owner will pick one.** He was shown
  five on 2026-09-01, chose the two that shipped as ADRs 043 and 044, and asked
  to be reminded of the rest once those are deployed. They are, in the order they
  were argued:

  **All five are built.** The queue suggestions and labelling rules (ADRs 043 and
  044), recurring bills and the export (045 and 046), and targets (047). There is
  no backlog behind them.

  Ask him rather than picking. Phases 1–3 and the deploy work are done and the
  September review is closed, so nothing here is urgent.

- If something does need doing and the end-to-end suite misbehaves, **read
  "Before believing a suite of failures" below before touching the branch.**
  Four different specs failed intermittently across one long session on
  2026-09-01, each passing alone and in clean runs, on a machine at six days
  uptime and a load average of 3.5 at rest.

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
business.

**And on 2026-09-01 he decided it does not need preserving at all.** Losing the
`tor-keys` volume does not lose access, it loses the _name_: it cannot be
recovered, only replaced, and every device holding the old address stops working.
He is content to derive a new one when that happens. So this is a decision rather
than a risk, [ADR 027](decisions/027-remote-access-is-an-onion-service.md)
carries it, and **no future session should reopen it as a gap** — which is what
the earlier version of this paragraph invited.

Open by decision rather than by omission, each with reasoning in
[docs/security-review-2026-08.md](security-review-2026-08.md) and
[docs/security-review-2026-09.md](security-review-2026-09.md):

- **TLS at the origin** — declined. Cloudflare and Tor both encrypt from away;
  what remains is the LAN, and a `Secure` cookie would break plain-http access to
  the LAN address.
- **Encrypted backups** — **decided on 2026-09-01: plaintext, deliberately.** No
  longer deferred. The question was never whether encryption is better in the
  abstract but where the passphrase lives, and a passphrase only in `.env` makes
  a lost `.env` a lost backup — worse in the failure case that actually happens,
  a dead NAS. `/volume1/backups` is covered by the off-NAS backup. If it is ever
  reopened, the only version worth building keeps the passphrase where the onion
  address is kept.
- **CSP violation reporting** — declined on 2026-09-01. An unauthenticated write
  path feeding a log line is the dead-backup shape again, and `script-src 'self'`
  with no inline allowance already means a violation breaks the page visibly.
- **The least-privilege database role** — **opt-in everywhere**, including on a
  fresh install. The init script creates `delegate_app`, and `APP_DATABASE_URL`
  is what connects as it; both halves are needed, and for a long time only the
  first existed, so the role was created and then never used. It is not the
  default because nothing can tell a fresh install from an upgrade at the moment
  the connection string is written — the secrets volume is empty on the first
  boot of both — and pointing an existing deployment at a role its database has
  never heard of would break it. Two steps in the README.
- **`secrets:rekey`** — **gone, done by upgrading on 2026-09-01.** The first boot
  writes the at-rest key into the secrets volume, seeded from `SESSION_SECRET`
  where one already exists, so the value does not change and nothing is
  re-encrypted. From then on the two are recorded separately, which is the whole
  of ADR 029's split. There is no command left to run.

**The September review is closed.** All eight of its findings were reproduced;
six were fixed, two accepted above, and two more of the same kind were found
while checking it. `auth_events` was built with the screen that reads it
([ADR 041](decisions/041-an-audit-log-ships-with-the-screen-that-reads-it.md)).
Nothing from it is outstanding.

### Deployment

**Since [ADR 042](decisions/042-delegate-installs-anywhere-in-one-line.md) there
is a published image**, multi-arch and signed, built by a workflow that fires on
version tags and runs no tests.

**Two things about a registry deploy.** It verifies the signature, so `cosign`
has to be on the NAS — the README has the one command. And **`COMPOSE_PROFILES`
must name `tor`** in `.env` if the onion service is wanted: it moved behind a
profile in `v0.41.0`, and a deploy that does not name it will not bring it back
up.

**The package is public, done on 2026-09-01 and verified** — an anonymous token
is issued and the manifest lists `linux/amd64` and `linux/arm64`.

Worth keeping the reason it needed doing at all: GitHub publishes a workflow's
package as **private** by default, whatever the repository's visibility. Until
that was changed, `docker compose up -d` answered `unauthorized` for everybody
who had not run `docker login ghcr.io` — which is the entire one-line install,
for everybody who is not the owner. It is a property of the package rather than
of each version, so every later push inherits it; only deleting the package or
renaming the image would reset it.

So the ordinary deploy is now:

```sh
cd /volume1/docker/delegate && sudo ./scripts/deploy.sh --tag <version>
```

Both `0.41.0` and `v0.41.0` are published, so either form works — the semver
pattern strips the `v` and a raw tag puts it back, because a release the git tag
calls `v0.41.0` and the registry calls `0.41.0` is a 404 waiting at the end of a
deploy.

which pulls the image, verifies it was built by this repository's workflow, and
restarts. That is a smaller and more honest loop than the source route below: it
deploys the artefact `npm run verify` was run against rather than recompiling it
on a machine that has never run the tests.

**A tag is not deployable the moment it is pushed, and there are _two_ ready
signals rather than one.** The publish workflow takes about fifteen minutes — the
arm64 half is emulated — and it pushes the image before it signs it, as separate
steps. So a version passes through two states on the way to deployable:

1. **Not in the registry.** The pull fails with `manifest unknown`, which is true
   and reads like a typo.
2. **Pushed but not signed.** The pull succeeds and resolves a digest, then
   `cosign verify` fails — which, worded carelessly, reads like a supply-chain
   attack on a release cut four minutes ago.

Both happened on `v0.50.0`, in that order, and the second is the worse failure
because the obvious way past it looks like `--skip-verify`. `deploy.sh` now names
each one and says the image may still be building; an unsigned image and a
_wrongly_ signed one no longer share a message, and an unrecognized cosign
failure is treated as the alarming kind rather than the benign one.

**The rule: do not hand over a deploy command until the workflow run has
completed** — not until the tag resolves, until the run is green. Check with:

```sh
gh run list --workflow publish.yml --limit 1
```

**The source route still works** and is what every deploy before `v0.41.0` used.
Keep it for an unreleased commit, or when the registry is not reachable. Two
commands.

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

**`npm run verify` is still the only gate** — the publish workflow builds an
artefact and decides nothing (ADR 022 is amended, not reversed). Nothing on
GitHub runs a test, and nothing is watching a branch.

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
- **Docker Desktop was uninstalled and left two things pointing at it**, both
  found on 2026-09-01 and both fixed. They are listed together because they have
  one cause and the next stale reference will too.

  `~/.docker/cli-plugins/docker-compose` was a dangling symlink into
  `/Applications/Docker.app`, so `docker compose` had silently never run here.
  And `credsStore` in `~/.docker/config.json` still named `desktop`, so every
  `docker pull` of an image not already cached failed with
  `docker-credential-desktop: executable file not found` — a latent gate failure,
  invisible only because the base images happened to be cached.

  Fixed with `brew install docker-compose docker-credential-helper`, the plugin
  directory registered through `cliPluginsExtraDirs`, and `credsStore` set to
  `osxkeychain` so credentials still go to the keychain rather than into
  `config.json` in the clear.

- **`docker compose` is installed and the gate uses it**, since 2026-09-01
  (`brew install docker-compose`, registered through `cliPluginsExtraDirs` in
  `~/.docker/config.json`). The symlink that was there pointed at Docker Desktop,
  which is not installed, so compose had silently never worked here.

  **That is why `docker-compose.yml` was "reasoned about, not executed" for
  months, and it stopped being a documented limitation and started being a
  documented cost** when three defects reached the NAS in one deploy — all three
  in compose or `deploy.sh`. `npm run verify` now parses the compose file with an
  empty environment and again with every profile on. Twenty-three seconds to the
  failure, against nearly four minutes to be told by the person deploying.

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

- **A 403 `two_factor_required` from a fixture is an enrolment race, not a code
  fault — and it is fixed now.** Both suites enrol by confirming with the
  _previous_ period's code, so a later sign-in still has an unspent one (a code
  is spent when used, ADR 028). "Previous" is worked out when the code is
  generated, so a run that crosses a period boundary between generating and
  validating offers one two steps back, and the server refuses it. Enrolment then
  silently did not happen and every later request answered 403 — surfacing as
  "expected 403 to be 200" in a helper thirty lines away, or as a fixture blowing
  up in an unrelated spec.

  Both **retry once and then assert** now, which removes the flake and makes the
  remaining case a named failure. Seen twice on 2026-09-02, in
  `auth-events.test.ts` and then in `manual-entry.spec.ts`; the second was found
  in one read because `e2e/fixtures.ts` had started reporting the status and body
  of a failed fixture request.

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

npm run test              # 318 unit
npm run test:integration  # 735 integration
npm run test:e2e          # 217 end-to-end, needs a build first
```

`npm run verify` is the gate. It runs migrations, typecheck, lint, formatting,
**the compose file parsed with an empty environment and again with every profile
enabled**, the forbidden-terminology rule, the dependency audit, all three
suites, the cached-balances-against-ledger check, a real backup-and-restore, the
tor image against its real entrypoint, and the container image build.

The compose step is early and cheap on purpose — two seconds, inside `--quick`.
It exists because three defects reached the NAS in one deploy and every one was
in a file this repository had never executed; it reproduces the worst of them in
twenty-three seconds. It replaced GitHub Actions and is the _only_ thing standing between a
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

- `main` is always deployable. Never commit to it directly.

  This used to be discipline rather than enforcement, because branch protection
  needed a paid plan on a private repository. **The repository is public now, so
  a protection rule is available and free** — and worth turning on, because the
  discipline demonstrably failed on 2026-09-01: a changelog commit went straight
  to `main`, and a branch was merged on a gate that had not actually passed.
  Neither was malice or haste; both were a rule with nothing behind it.

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
- **A phone keyboard does not shrink the window.** Every `100vh`, `45vh`,
  `inset-0` and `bottom: 0` in this application means the _layout_ viewport,
  which on iOS keeps its full height while the keyboard is drawn over the page.
  If a thing is anchored to the bottom of the screen and contains a field, it is
  anchored behind the keys. `dvh` does not help — it tracks the browser's
  retracting chrome, not the keyboard — and `interactive-widget=resizes-content`
  is Chrome-on-Android only. `window.visualViewport` is the answer, and
  `useVisualViewport` already wraps it.
- **Chromium has no software keyboard, so the condition cannot be produced —
  only the shape of it.** The regression test stubs `window.visualViewport` to a
  window still 844 tall with 430 on screen. The disagreement between the two
  rectangles _is_ the bug, and that is reproducible exactly. Verify a test like
  this fails without the fix; this one did, at 844 against 430.
- **An `opacity: 0` control still occupies its width.** Adding hover-revealed
  arrows beside the Insights drag handle pushed the card header 26px past its
  own edge with the `×` off-screen. Two more elements then needed `min-w-0`
  before it fit: **a flex item and a grid item both default to their content
  width**, so a header's controls will size the card rather than the column
  unless told not to.
- **Playwright matches an accessible name as a substring.** The backlog pill
  reads "4 new transactions", so `getByRole('link', { name: 'Transactions' })`
  started matching the sidebar _and_ the pill. Reach for `exact: true` on a
  navigation locator once anything else on the page can contain the word.
- **A hidden tooltip is out of the accessibility tree entirely.** `getByRole
('tooltip')` finds nothing until it is revealed, so a test has to hover first —
  which is the behaviour worth asserting anyway.
- **A single fixed width anywhere sets the whole column.** Three rounds went into
  a `⋯` column that would not collapse on a phone, suspecting CSS specificity;
  the cause was one unpatched empty `<td className="w-10 ...">` in the same
  column.
- **A profile does not stop a service, it stops managing it.** Moving `tor`
  behind a compose profile in `v0.41.0` was expected to stop the container on the
  next deploy. What happened is the opposite and worse: `compose up -d` left it
  running and simply stopped tracking it, so it kept working while ageing out of
  every future release — and would have stayed down silently the first time it
  stopped, with Settings reporting "no onion address", which is also what it says
  when nothing is wrong. `COMPOSE_PROFILES` in `.env` is what keeps a profiled
  service part of a deployment that wants it.
- **A compose variable marked required (`:?`) is required everywhere**, including
  inside a service no profile has enabled: interpolation happens before profiles
  are applied. `DELEGATE_DOMAIN` was `:?` inside the bundled Caddy service, and a
  NAS that had never heard of Caddy failed halfway through an upgrade.
- **A deploy script that unpacks a release replaces itself.** `deploy.sh` sets
  its constants at the top, `--unpack` overwrites the file, and execution
  continues from the old copy — so a release that changes the script does not get
  to use the change it shipped. That produced a signature failure against a
  perfectly good signature, because the running script was checking for a
  workflow deleted a month earlier. It re-execs after unpacking now.
- **`npm run verify | tail` reports `tail`'s exit code, not the gate's.** A
  pipeline's status is its last command. That turned a real end-to-end failure
  into an apparently successful run, and a branch was committed and a pull
  request opened on a gate that had not passed. Redirect and check instead:
  `npm run verify > /tmp/v.log 2>&1; echo $?`. The one rule this project has
  about merging is worth more than the convenience of a pipe.
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
