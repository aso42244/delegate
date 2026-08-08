# Architecture

The domain model, kept current. If this document and the code disagree, the code
is right and this document is a bug.

## The idea in one paragraph

This is an envelope budget. Money sits in real accounts, and every dollar is
_delegated_ to a named envelope. The health of the budget is a single subtraction,
recomputed on every view:

```
SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)
```

That difference is displayed at the bottom of the Main Budget page. It is not
enforced by double-entry bookkeeping and it is not always zero. It is a reading.

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

`notes` is freeform text with no structure. The owner writes `"$2200, Dec 27"` and
does the per-cycle arithmetic himself. It is a real column so structured target
fields remain a purely additive migration later.

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

## Go-live reconciliation

A first-class feature, not a migration script. At go-live the owner has backfilled
and categorized twelve months of history, which drives balances deeply negative —
Grocery may read −$9,000 when its true balance is $725. That is deliberate: it buys
full history and accurate day-one numbers.

**Reconcile to Actual** lists every delegation with its computed balance and an
editable "actual", and one commit writes every `adjust` delta in a single batch.
Sixty corrections are one screen and one commit, not sixty modals.

Order of operations: **sync → build rules → bulk-apply rules → categorize the
remainder → reconcile.**

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
