# Architecture

The domain model of **Delegate**, kept current. If this document and the code
disagree, the code is right and this document is a bug.

## The idea in one paragraph

This is an envelope budget. Money sits in real accounts, and every dollar is
_delegated_ to a named envelope. The health of the budget is a single subtraction,
recomputed on every view:

```
SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)
```

A fourth term corrects for pending transactions that have been categorized: the
envelope moves the moment one is categorized, while the account balance is the
institution's settled balance and will not include it for another day or three.
Without it the first three terms are out of step by the amount of the charge. See
ADR 020.

That difference is displayed as a chip beside the Budget page title — `Balanced`,
`To delegate $1,000.00`, `Over delegated $212.00`. It is not enforced by
double-entry bookkeeping and it is not always zero. It is a reading.

## Reading the bottom row

| Difference                        | Meaning                                           | Label                          |
| --------------------------------- | ------------------------------------------------- | ------------------------------ |
| Positive                          | Money has landed and has not been distributed yet | `$4,890.00 to delegate`        |
| Within ±tolerance (default $5.00) | Normal drift                                      | `Balanced`                     |
| Negative                          | Envelopes claim more than the accounts hold       | `$212.00 over-delegated` (red) |

The positive case is why **income needs no special machinery**. A paycheck
increases an account balance and allocates to nothing, so the difference rises by
exactly the deposit. That number _is_ the money available to delegate. There is no
income category tree, no "to be budgeted" account, and no income envelope.

## Conventions that hold everywhere

- **All money is integer cents in `BIGINT` columns.** Never a float, never a
  `Decimal`, never a JavaScript `number` in arithmetic or persistence. Values are
  formatted to a decimal string only at the display edge. Over HTTP they travel as
  decimal _strings_ of cents, because `JSON.stringify` throws on `bigint`.
- **Debt balances are positive magnitudes.** A $500 credit card balance is
  `50000`, not `-50000`. The identity subtracts them.
- **Transaction amounts are signed**, negative meaning money out of the account.
  Those two conventions pull in opposite directions on a debt, so the delta a
  transaction applies to its account lives in exactly one function —
  `accountBalanceDelta` in `apps/api/src/domain/accounts.ts`.
- **Nothing is hard-deleted.** `archived_at` marks a row archived. Archived rows
  stay resolvable, so an eight-month-old transaction renders `Grocery (archived)`
  rather than a dangling id.
- **Alphabetical is the only order.** There is no manual sort ordering anywhere.
- **USD only.** No currency column, no selector.

## Accounts

An account is a real-world balance. Two orthogonal booleans govern it:

- `in_budget` — does it participate in the identity?
- `in_net_worth` — does it appear in the net worth chart?

They are independent, and that independence is what keeps a mortgage from swamping
the budget. The house and the mortgage are `in_net_worth = true, in_budget =
false`. A credit card is both.

`type` is `asset` or `debt`; on SimpleFIN import it is guessed from the account
type and sign and the owner can override it. `source` is `simplefin` or `manual`.

Manual accounts carry `balance_as_of` and a nullable, per-account
`staleness_interval_days`. When `now() − balance_as_of` exceeds the interval, the
account is flagged stale in the UI. **One mechanism serves physical cash, the
hardware wallet and property value alike** — there is deliberately no
property-specific version of it. A null interval means "never goes stale".

A property account may reference a mortgage account. Equity is
`property.balance − mortgage.balance`, computed on read and never stored — a
stored copy would drift on every payment.

## Delegations, and why balances are a ledger

A delegation is an envelope. Its `amount_to_delegate_cents` is **nullable**, and
null is not zero: null means "this line is ad hoc, add nothing when Delegate is
pressed", and the UI shows an empty cell rather than `$0`. Both move nothing at
Delegate time; only the display differs.

`notes` is freeform text with no structure — anything about a line the fields do
not cover. It used to carry the target too: the owner wrote `"$2200, Dec 27"` here
and did the per-cycle arithmetic himself, and the column was kept freeform on the
understanding that structured fields would be a purely additive migration later.
They were, and they are `target_cents` and `target_date`
([ADR 047](decisions/047-a-target-never-moves-an-amount.md)).

**A target is a reading, never a write.** It changes no balance and no amount to
delegate; it works out what each remaining paycheck would have to carry and says
so beside the figure the household controls. Taking that figure is one explicit
switch in the dialog, and afterwards it is an ordinary amount to delegate. The
arithmetic is in `@budget/shared` because the dialog shows it live as somebody
types, and a second copy would be a second answer.

**A target can repeat.** `target_date` is an **anchor** — one occurrence of the
series — and `target_interval_months` says how the rest follow, so a bill due on
the last day of April and again on the last day of October is entered once and
never goes stale. Months rather than days, because that recurrence is not
expressible in days; `addMonthsToDayKey` keeps the end of the month and clamps a
day the next month does not have.

Three check constraints hold the shape: a date without an amount is a deadline for
nothing, a target of zero is not a target — clearing one is what null is for — and
an interval with no date has nothing to repeat from. `target_date` is a `DATE`, a
decided day needing no zone, and crosses the wire as `2026-12-27` rather than as
an instant.

`updateDelegation` resolves those three fields **once**, as the values it will
write, and validates and writes from that. They constrain each other and a request
usually mentions one of them: validating the field that arrived refuses "remove
this target", and writing the field that arrived while validating something else
lets a request past the domain and into a constraint, which then surfaces as a
Prisma error rather than as a sentence.

**A delegation's balance is not a stored, freely-mutable number.** It is the sum
of an append-only event stream:

```
delegation.balance_cents = SUM(delta_cents) WHERE reversed_at IS NULL
```

The reason is not purity, it is two concrete requirements:

1. A **pending transaction that vanishes** must have its exact effect backed out.
2. **Delegate must be undoable for hours** while unrelated work continues.

Both are reversal of specific deltas. You cannot reliably back a delta out of a
bare stored number, because you no longer know what went in. So deltas are what
is stored, and reversal sets `reversed_at` rather than deleting anything.

`delegations.balance_cents` is a **cache**, written inside the same database
transaction as the event insert. The events are the truth. `recompute-balances`
rebuilds every cache from events and exits non-zero if it had to change anything;
CI runs it with `--check`, and an integration test asserts the two agree after a
long mixed sequence of operations.

### Event types

| Type         | Written by                    | Appears on Transactions page |
| ------------ | ----------------------------- | ---------------------------- |
| `delegate`   | The Delegate button           | no                           |
| `categorize` | Allocating a transaction      | yes, as the transaction      |
| `transfer`   | Envelope-to-envelope transfer | no (see ADR 004)             |
| `adjust`     | Manual adjustment, Reconcile  | **never**                    |

`adjust` events are excluded from all spending math and are visible only in
per-line history. The transaction journal exists for categorization, not auditing.

**Manual adjustment records a delta, not an absolute.** Editing Grocery from $650
to $675 writes `+$25`.

## Groupings

Organizational only: a name, a section (`assets` | `debts` | `delegations`), an
optional colour, and a collapsed state. Groupings have **no** balance and no
amount to delegate of their own. Collapsed, the grouping row shows the _sum_ of its
children; expanded, those cells are empty. Groupings are shared system-wide — the
Insights page groups spending by them.

Names are unique per section, case-insensitively, **among live rows only**, via a
partial unique index. Archiving must not permanently reserve a name.

## Transactions

A transaction belongs to one account and has zero or more **allocations** to
delegations. Allocations are a separate table from day one: splits are rare but
must be possible, and retrofitting that would be a migration through live
financial data.

`kind` is one of:

- `normal` — spending or refund; allocations move delegations
- `income` — increases an asset, allocates to nothing
- `transfer` — movement between two owned accounts, allocates to nothing

**An uncategorized transaction is completely inert.** No allocations means no
delegation moved. That is what makes importing a 12-month backlog safe before any
rule exists, and it is what the go-live sequence depends on.

Allocation amounts must sum to exactly the transaction amount. Uneven splits use
`splitEvenly`, which hands the remainder out one cent at a time so the shares
always sum exactly — $100.00 across three lines is 33.34 / 33.33 / 33.33.

Allocation _rows_ are current state; the `categorize` events they produce are the
history. Re-categorizing replaces the rows and reverses the old events, so a
transaction can be re-categorized freely without corrupting a balance.

### Pending

A pending transaction affects delegations immediately once categorized — the owner
wants envelopes to reflect money that is already gone. Two outcomes, both exact:

- **It posted.** Matched to the posted row by account + exact amount + a 5-day
  window. The categorization is carried across and the pending row is archived, so
  the spend is counted once. Amount matching is exact on purpose: a tip added at
  settlement produces a different amount, and silently pairing those would corrupt
  a balance. Those surface as an ordinary uncategorized transaction instead.
- **It vanished.** Every event it caused is reversed and the row is archived.
  Reversal is idempotent, so a retried sync cannot double-credit.

## Delegate, Transfer, Adjust

**Delegate** writes one `delegate_run` and one `delegate` event per line with a
non-null amount, all sharing a `batch_id`. The run's `created_at` defines the
start of "this budget cycle". The owner is paid biweekly (26 cycles a year) and
presses this manually each payday — **there is no automatic cadence**.

**Undo** is available for 12 hours (configurable) and reverses every event in the
batch. Work done in the interim survives untouched, because each of those is its
own event with its own batch. Undo also rolls the cycle boundary back to the
previous run, which is surfaced in the confirmation so it is not a surprise.

**Transfer** moves an amount between two envelopes as paired `transfer` events
that net to zero, so the identity is unchanged — correct, because no account
balance moved. It may take the source negative; that is allowed and intentional.
It writes **no transaction row**; see ADR 004.

## Go-live, and correcting a backfill

Backfilling and categorizing twelve months of history drives balances deeply
negative — Grocery may read −$9,000 when its true balance is $725. That is
deliberate: it buys full history and accurate day-one numbers, and the difference
is corrected afterwards.

**Reconcile to Actual was the screen that did it in one commit, and it is gone**
([ADR 031](decisions/031-reconcile-to-actual-is-removed.md)). It existed for a
single moment in a household's life, that moment has passed here, and correcting
drift now happens where the drift is visible: **Manually adjust** on the Budget
row menu, or Settings → Delegations. Both write the same `adjust` event the
screen wrote, one line at a time.

Every event a reconciliation ever wrote is untouched — they are ordinary manual
adjustments and always were. `budget_settings.go_live_at` still holds the date
the first commit stamped; nothing writes or reads it any more, and it is kept
because the value on a live deployment is a real fact about that household.

Order of operations at go-live: **sync → build rules → run rules → categorize
the remainder → correct the lines that are wrong.**

## Archiving

- A delegation may only be archived at **exactly $0**. Archiving with money in it
  would silently break the identity by that amount. The error carries the balance
  so the UI can offer Transfer and Adjust inline.
- A grouping may only be archived when it holds nothing live.
- Archived entities stay resolvable everywhere history references them, and
  archived delegations still appear in Utilities and Insights historical views.
- Settings → Archived lists archived entities with a restore action.

## Permissions

The entire model is one capability check plus Super Admin immunity:

| Capability                 | User | Admin | Super Admin |
| -------------------------- | :--: | :---: | :---------: |
| Full budget access         |  ✅  |  ✅   |     ✅      |
| Create/modify/delete users |  ❌  |  ✅   |     ✅      |
| Modify the Super Admin     |  ❌  |  ❌   |     ✅      |

Only user management is gated. There is no permission matrix. The first account
created becomes Super Admin.

Every delegation event stamps `actor_id`. Not for auditing — it costs nothing and
answers "when did this line change".

## Auto-categorization rules

Rules are evaluated in priority order and **the first match wins** — no scoring,
no combining. The owner has to be able to look at a wrongly categorized
transaction and know exactly which rule did it, which any "best match" scheme
makes impossible.

**A rule carries an action rather than a destination.** It either assigns a
delegation or it labels — says the transaction is income, or a transfer between
owned accounts, both of which allocate to nothing by definition. Exactly one of
the two, held by a check constraint on `categorization_rules` rather than by
convention: both would categorize a row the domain forbids allocations on, and
neither would match and then change nothing.
[ADR 043](decisions/043-a-rule-does-one-of-two-things.md).

Rules match on the cleaned description _and_ the raw feed text, because feeds
reword a description between the pending and posted versions of the same
purchase, and a rule written against one form would otherwise stop firing.
Amount ranges compare magnitude, since the owner thinks "between $20 and $50"
while spending is stored negative.

Two guarantees are worth stating outright:

- **A bulk apply never overwrites a categorization made by hand.** Only
  uncategorized transactions are touched unless the caller explicitly opts in.
  Bulk actions run over hundreds of rows; silently reversing a human decision at
  that scale would be very hard to notice and worse to unpick.
- **A sync only applies rules to what that sync imported.** A rule written today
  does not silently recategorize months of history the next time the hourly job
  runs. That is what the explicit apply-to-existing action is for.
- **A labelling rule never touches a categorized row**, even under
  `includeCategorized`. Re-labelling one would mean destroying the allocations
  underneath it, which `updateTransaction` refuses for a single row — and a bulk
  action must not do what the same action refuses one at a time.

Regular expressions come from the UI and run against the whole backlog, so a
pattern like `(a+)+$` would backtrack forever and take the single-process server
with it. Patterns are length-bounded, rejected at save time if they nest
unbounded quantifiers or fail to compile, and matched against a truncated
description.

### Where the rules come from

Rules are written by hand, so a merchant only stops arriving in the queue once
somebody sits down and writes one — and the categorizations repeated most often
were exactly the ones nobody stopped mid-queue to automate. Two things close that
loop, and both read the same normalization in `@budget/shared`
([ADR 044](decisions/044-the-queue-teaches-the-rules.md)):

- **A suggestion** on an uncategorized row, drawn from where that merchant went
  before, with the count behind it. It writes nothing, needs two prior decisions
  and a majority of them, and ignores splits and archived delegations.
- **"Always categorize like this"** on a row already filed, which builds a rule
  from the merchant part of the raw description — offered in a field the reader
  can edit, because the guess at where a merchant's name ends is a guess.

`merchantKey` groups history; `suggestedMatchValue` fills the field. They are
shared rather than duplicated because a drift between them would mean a rule
created from a suggestion no longer matched the transactions that produced it,
and nothing would say so.

## Bills are inferred, never entered

A bill is a merchant whose charges have landed at a steady interval, and that is
computed from the transactions on every request and **stored nowhere**
([ADR 045](decisions/045-a-bill-is-inferred-not-entered.md)). There is no bills
table and no `is_recurring` flag: a hand-maintained list is a second copy of what
the register already says, and a second copy goes wrong in the direction nobody
notices — nothing prompts you to delete the row for a service you cancelled.

`domain/recurring.ts` holds the bounds and the reason for each. The one doing the
real work is that nothing faster than a fortnight qualifies: groceries recur in
the plain sense, and a tolerant consistency check would happily call the weekly
shop a weekly bill.

It **proposes and never writes**, like a check match (ADR 030) and a suggested
delegation (ADR 044). `budget_settings.recurring_alerts_enabled` decides whether
an overdue bill raises a pill — the page is there either way.

**One thing is stored: what a person says back.** `bill_overrides` holds no bills,
no dates and no amounts — every figure is still derived on every request. It holds
the two corrections that cannot be derived: _this is not a bill_, and _this is not
what it is called_. The first real run listed a thrift shop visited every
fortnight, and nothing in the register distinguishes that from a utility. Keyed by
merchant, hidden rather than deleted, and a rename labels the row without
replacing the bank's text. See the amendment on
[ADR 045](decisions/045-a-bill-is-inferred-not-entered.md).

Intervals are measured in **days in the household's zone**, not in instants: a
charge posted at eight in the evening and one posted at nine the next morning are
thirteen hours apart and one day apart, and it is the day the schedule is made
of. ADR 037.

## Export

Three CSVs, and three rather than one because a split transaction has one amount
and two envelope movements
([ADR 046](decisions/046-the-export-is-three-files.md)). The register file sums
to what left the accounts; the ledger file sums to what the delegations hold.

Money leaves as a **decimal**, which is the one place in this codebase that is
true. ADR 002 governs JSON, where a float would silently lose a cent; a CSV is
opened in a spreadsheet, and a column of `-4210` where `-42.10` was meant is a
column somebody sums and acts on. It is formatted from the `BIGINT` by hand, so
the value still never passes through a float.

`http/csv.ts` carries the other half: a field this application generated is
marked `raw()` and written as-is, and everything else — anything the feed wrote —
is defended against being read as a formula.

## Duplicates are proposed, never archived

Reconnecting an institution changes every account's external id, so a sync brings
back a card's whole recent history as though it were new — recorded in
`handoff.md` as something that happened. `domain/duplicates.ts` reads the
register for two rows in one account, the same amount to the cent, within two
days, and offers them
([ADR 049](decisions/049-a-duplicate-is-proposed-never-archived.md)).

It writes nothing: archiving reverses whatever a row moved, and picking wrongly
between two identical rows is not something to find out about later. The match is
deliberately narrow — a near amount is a fee, a different account is a transfer,
and a different description is still the same charge, because feeds reword their
own text between the pending and posted versions of one purchase.

## Authentication

A username, an argon2id password hash, a session cookie, and an optional second
factor. The transport is plain http unless TLS is configured, and nothing is
exposed to the internet either way.

What is in place now:

- **argon2id** at OWASP's baseline, and length as the only password rule. See
  [ADR 007](decisions/007-argon2id-parameters-and-password-policy.md).
- **Sessions in PostgreSQL**, so a restart does not sign anyone out and logout
  can genuinely revoke. See [ADR 008](decisions/008-sessions-stored-in-postgres.md).
- **Session id rotation** on login and on password change, so an id captured
  before either cannot be replayed after it. A **role change ends that user's
  sessions** outright — the id was minted under different privileges.
- **Uniform failure**: an unknown username, a wrong password and an archived
  account return the same status and the same body, and a missing user still pays
  the full hash cost, so neither the response nor its timing reveals which
  usernames exist.
- **The user is re-read on every request** rather than trusted from the session,
  so a role change or an archival takes effect at once.
- **Temporary passwords**: an account created by an Admin can reach only its own
  identity and the change-password route until it sets a real one.
- **Rate limiting** on every route that verifies a credential — sign-in,
  first-run setup, changing a password, and the second-factor exchange. Ten
  attempts per address per five minutes by default, and the refusal is identical
  whatever was attempted.
- **TOTP with recovery codes**, off by default and required of everyone through a
  setting that refuses to turn on while any active account would be locked out by
  it. The secret is stored encrypted and the recovery codes as argon2id hashes.
  See [ADR 014](decisions/014-the-second-factor-step-uses-a-signed-challenge-not-a-session.md).
- **CSRF protection** as an origin check on every state-changing request, on top
  of the `SameSite=Lax` session cookie. See
  [ADR 015](decisions/015-csrf-is-an-origin-check-not-a-token.md).
- **Security headers** via helmet, including a content security policy that
  allows scripts and connections from this origin only.

**The transport is plain http by default**, which is a decision rather than a
gap — [ADR 017](decisions/017-plain-http-is-the-default-and-tls-is-optional.md),
which states the trade: passwords, TOTP codes and the session cookie cross the
LAN in clear text, and the exposure is every other device on that network. TLS is
supported behind `TLS_CERT_PATH` and `TLS_KEY_PATH`, both or neither. Internet
exposure stays off the table while the default stands.

**Passkeys are not coming.** TOTP covers the stolen-password threat they were
there for; what they would have added is phishing resistance, which is narrow for
a two-person application with no public URL to impersonate, and expensive to keep
correct. See [ADR 016](decisions/016-passkeys-are-out-of-scope.md), which also
records the trade being accepted: Delegate remains phishable.

## Layout

```
packages/shared    Money primitives, the identity, domain vocabulary.
                   Imported by both the API and the UI. Knows nothing about
                   Prisma or HTTP.
apps/api           Fastify server, Prisma schema and migrations, domain
                   services, CLI commands.
apps/api/tests     Integration tests against a real PostgreSQL.
```

Domain functions take a `Db` — either the Prisma client or a transaction client —
so the **caller** decides the transaction boundary. Anything that writes an event
and a cached balance must run inside one transaction.

## Bitcoin and property are managed where they live

Both are ordinary rows in `accounts` — the identity, the budget read model, the
net worth series and the equity netting all read that table. What is separate is
who owns their lifecycle: `managed_as` marks a row as `bitcoin` or `property`,
and its own Settings tab creates, renames and retires it. Settings → Accounts
lists them read-only.

For a Bitcoin holding the quantity is the fact and the value is derived. The one
exception is a holding marked in-budget: the identity sums `balance_cents`
directly, so that column is written for those, once a day. See ADR 021 for why
daily rather than hourly, and for the bug the whole arrangement closes.

## The financial picture is snapshotted nightly

Delegations have a full history because their balances are a ledger. Account
balances and net worth never did — only current state exists — so Insights could
show today and never a trend, and every day nothing captured state was a day of
history lost.

Three tables fix that, written by a nightly job for the **previous** day:
`account_snapshots`, `delegation_snapshots`, `aggregate_snapshots`. Each row is
keyed by a **date** rather than a timestamp and carries its own provenance:
`observed`, `reconstructed`, `carried` or `interpolated`. An aggregate takes the
**weakest** provenance among its inputs.

[ADR 035](decisions/035-the-financial-picture-is-snapshotted-nightly.md)
supersedes ADR 013, which decided the opposite in August. Two things about the
shape are worth stating here because they are easy to undo by accident:

- **Aggregates are stored, not derived.** Recomputing them from the detail tables
  would mean archiving an account or changing an in-budget flag rewrote history
  that had already been looked at. The same reason each account snapshot carries
  its own `type`, `in_budget` and `in_net_worth`, and each delegation snapshot
  its `grouping_id`, as they stood that night.
- **Two scopes, because the app has two.** Net worth includes the house and the
  mortgage; the identity is precisely the reading that excludes them. Both pairs
  of totals are stored, and `identity_value_cents` is the **four-term** figure —
  the pending term included, so it matches the chip on the Budget page.

History starts at the first run after deploy. There is deliberately no backfill.

## Bitcoin quantities are a ledger, like delegation balances

`bitcoin_holding_events` is dated, signed and append-only, and
`accounts.bitcoin_sats` is a cache of its un-reversed sum —
`recompute-balances` rebuilds and checks both ledgers in one pass.

This is what lets the net worth chart value the quantity held _on a date_ rather
than applying today's quantity backwards, and what makes cost basis a
consequence of recording purchases rather than a number kept by hand. See ADR 023.
