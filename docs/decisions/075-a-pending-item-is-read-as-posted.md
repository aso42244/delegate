# 075. A pending item is read as posted

**Status:** accepted
**Date:** 2026-10-03
**Amends:** [ADR 020](020-pending-transactions-in-the-identity.md)

## Context

ADR 020 added categorized pending transactions to the identity, and only those.
An uncategorized pending row "has moved neither side", and correcting for it
"would turn a reconciliation into a forecast".

That held for a charge and failed for a paycheck. **Income is never
categorized**, so a pending paycheck was counted nowhere: not in the balance,
which is the settled one, and not in the fourth term, which wanted an
allocation. On 2026-10-02 a $1,476.06 paycheck went pending on an account
whose institution reports a settled balance, Delegate was pressed on payday as
it always is, and the budget read **Over delegated $1,431.15** on a household
that had $44.91 left to delegate. The bank showed the paycheck posted; the feed
had not caught up.

The household's own reading of a pending item is that it has happened. A
pending charge is money gone, which is why ADR 009 moves its envelope the moment
it is categorized; a pending paycheck is money arrived, which is why Delegate is
pressed the day it lands.

## Decision

**The fourth term sums every pending transaction**, categorized or not, on
in-budget accounts whose balance does not already include pending
(`balance_includes_pending`, ADR 074). The `allocations: { some: {} }` condition
is gone, in `computeBudgetIdentity` and in the nightly snapshot's copy.

What each case now reads:

- **A categorized pending charge** — unchanged. The envelope moved and the
  term adds the charge back to the balance; they net out.
- **An uncategorized pending charge** — over-delegated by its amount, which is
  exactly how an uncategorized _posted_ charge reads. It says so a day or two
  sooner, which is the point at which somebody can file it.
- **A pending paycheck** — money available, the day it is pending.

## Consequences

**Holds are read at their pending amount.** A $100 pump authorization that posts
at $38, a hotel or car-rental hold, a restaurant charge whose tip is added at
settlement: the reading is off by the difference until it posts or drops off,
usually a day or three. A pending row that vanishes is already backed out
completely (`pending.ts`), so a dropped hold costs nothing afterwards. Pressing
Delegate while a large hold is pending is the one case worth a glance at the
reading's working, where the pending term is shown on its own line.

**`balance_includes_pending` keeps its meaning.** An account whose institution
folds pending into its balance is still left out of the term entirely; it would
otherwise count every pending item twice.

**No account balance changes.** Every balance on every screen is still the
institution's figure, which is what a statement and the bank's own site show.
Only the reading's fourth term moved.
