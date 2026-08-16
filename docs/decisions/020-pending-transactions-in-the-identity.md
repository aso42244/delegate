# 020. Categorized pending transactions are a term of the identity

**Status:** accepted
**Date:** 2026-08-15

## Context

The identity read

    SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegation balances)

and the owner reported it wrong against real data. His budget was exactly
balanced. A $361.47 charge went pending on a credit card. He categorized it, the
envelope emptied by $361.47, and the page told him he had $361.47 to delegate —
money he had already spent.

The two sides of a pending charge move at different times, and that is by design
on both sides:

- **The envelope moves at once.** ADR 009 and `pending.ts` are explicit that a
  pending transaction affects delegations the moment it is categorized. The owner
  wants his envelopes to reflect money that is already gone, not money the bank
  has finished settling.
- **The account balance does not.** `simplefin/protocol.ts` stores the feed's
  `balance`, which the SimpleFIN specification defines as the settled balance;
  `available-balance` is the field that accounts for pending activity and holds.
  We do not read it. Manual transactions apply their own balance effect on
  creation, but a manual transaction is always created settled, so there is no
  second path.

So between categorizing and settling, the third term has moved and the first two
have not. The identity is out of step by exactly the amount of the charge, and it
reports that gap as money available to delegate.

## Decision

Add a fourth term:

    SUM(in-budget assets)
      − SUM(in-budget debts)
      − SUM(delegation balances)
      + SUM(categorized pending transactions)

Added rather than subtracted, because a pending spend is already a negative
amount. The account balance is short by exactly that amount, so adding it back
puts the first three terms on the same footing.

Three conditions on what is summed, and each excludes a case that would make the
reading worse rather than better:

- **Categorized only** — `allocations: { some: {} }`. An uncategorized pending
  row has moved _neither_ side and is already consistent. Correcting for it would
  change the identity from a reconciliation into a forecast: it would report
  money as spent before anyone decided which envelope it came from. The existing
  behaviour for a settled-but-uncategorized row is unchanged and still reads as
  a temporary imbalance, which is what prompts the owner to categorize it.
- **In-budget accounts only**, matching the first two terms. An account the
  identity does not count cannot contribute a correction to it.
- **Not archived**, on both the transaction and the account.

Allocations are required to sum to the transaction amount, so summing
`amount_cents` sums exactly what the delegations moved by. There is no partial
case to reason about.

The term is shown in the banner — `− Pending $361.47` — and only when it is
nonzero.

## Consequences

The correction assumes the institution reports a settled balance, which is what
SimpleFIN specifies. An institution that instead folds pending activity into
`balance` would now be corrected twice and read as over-delegated by the pending
amount.

This is the reason the term is displayed rather than applied silently. A wrong
correction is visible on the line the owner reads most, next to the figure it
changed, instead of being a quiet few hundred dollars in the wrong direction. If
that shows up, the fix is per-account and known: read `available-balance` for
that account, or exclude it from the term.

The alternative — reading `available-balance` everywhere — was rejected because
it is optional in the feed, absent from many institutions, and would make the
asset and debt totals disagree with what the bank's own website shows.
