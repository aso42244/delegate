# 068 — One accounts table, on both screens

**Status:** accepted
**Date:** 2026-09-15

Completes [ADR 067](067-the-budget-page-is-hidden-for-a-trial.md), which hid the
Budget page for a trial and named three things that page could do and Overview
could not — the reason it said deleting the page would be deleting a capability
rather than a screen. Extends [ADR 062](062-the-budget-is-the-first-block-of-overview.md),
which put the budget across the top of Overview.

## Context

ADR 062 made the band draw **the Budget page's own `DelegationsTable`**, and that
component's docstring says why in one line: there are two places a household
works on its envelopes, and two renderings of one table is exactly how two
screens come to disagree about a budget.

The accounts half was never finished to the same standard. The band's second tab
drew `BalanceList` — its own flat list of name and balance, from its own
`['accounts']` query. No groupings, no row menu, no handle. So after ADR 067 the
whole of what the Budget page still had over Overview was:

- accounts and debts **in their groupings**,
- **filing an account under a grouping**,
- **ordering accounts and groupings** within Assets and Debts.

All three are one component away, and none of them wanted designing again. The
question was not "what should this look like" but "why is there a second
rendering at all".

## Decision

**`AccountsTable`, the sibling of `DelegationsTable`, drawn by both screens.**
Assets and Debts, in their groupings, with `AccountRowMenu` on every row and the
drag, fold and nudge handling `BudgetSection` already had. The Budget page and
the band differ in two props and nothing else.

**`arrangement` says stacked or side by side**, rather than a container query
deciding. The Budget page's own columns/stacked preference already allocates the
room these get, and a grid here would fight it: in that page's `columns`
arrangement the two share two fifths of the width, and splitting them again would
give each a fifth. The band has the whole page and takes side by side.

**`onlyWithBalance` is the band's "With balance" filter**, and it is a _display_
filter only. An account at zero is one nothing can be decided about and a
closed-but-not-archived card is the commonest of them — but what is written back
is always the whole order.

**That last point is the only hard part of this, and it is a correctness one.**
`BudgetSection` builds a new ordering from the section it was handed, so on a
filtered list it produces an order over the visible rows alone. Neither endpoint
can take that:

- `placeAccount` writes `position = (index + 1) * 10` for exactly the ids it is
  sent and leaves every other row alone, so a three-row order sent for a six-row
  list renumbers three of them into positions the other three already hold. **It
  does not fail.** The list is simply wrong afterwards, with ties broken
  arbitrarily, which is the worse of the two outcomes.
- `reorderGroupings` refuses a partial list outright — safer, and still a failure
  somebody has to see.

So `restoreHidden` in `components/account-order.ts` widens the order again before
it is sent. One rule: **each hidden id stays attached to the visible id it
followed.** A closed card filed under Savings after Everyday Checking is still
after Everyday Checking wherever that moves to, rather than being swept to one
end because nobody could see it. It needs no idea of which row was dragged, which
is what let it replace a first attempt that tried to infer the mover from two
orderings and was three times the size.

**No total moves under the filter**, and that is a property rather than a
promise: every figure on screen — each section's and each grouping's — is
computed by the server and carried on the DTO, and a row at zero contributes zero
to a balance, which is the only figure these two sections hold.

**The band's headings are Assets and Debts**, as everywhere else, where the old
flat list said "Accounts". The tab is still called Accounts & Debts: an _account_
is the thing, and Assets and Debts are the two sections it can sit in — the
vocabulary ADR 021 settled for Settings → Accounts.

## Consequences

- **`MainBudget` is 87 lines, from 270.** Four mutations, a nudge helper, a
  cache-patching helper and two `BudgetSection` call sites moved into the shared
  component. What is left is the page: a header, an error slot, and the
  columns-or-stacked arrangement of two tables.
- **The band's `['accounts']` query is gone.** It reads the `['budget']` view the
  delegations tab is already holding, which is also the only view that answers
  the in-budget question at source — `/api/budget` selects `inBudget: true`, so
  nothing on the client has to sieve for ADR 050's wall any more.
- **A latent bug in Overview came out with it.** The `['budget']` query was
  `enabled` only when a tile keyed `delegations` was in the stored layout, while
  the band that needs it is pinned and always drawn and its layout row is created
  lazily by the first "Select Delegations". A household that had never pressed
  that had a band reading "Loading the budget…" for ever. Nobody had hit it
  because the accounts tab fetched its own data and the delegations tab was
  usually chosen; with both tabs on one view it would have emptied the band. The
  query is unconditional now.
- **ADR 067's precondition for deleting the Budget page is met.** Its "How this
  ends" said deleting meant first giving Overview a home for grouping and
  ordering accounts. That home is this. What deleting still costs is the
  columns-or-stacked preference, which belongs to that page alone.
- **Dragging is still never the only route.** Move up, Move down and Move to
  grouping are on the row menu on both screens, which is what a keyboard and a
  thumb reach — and, since the band can hide rows, what a nudge has to step over
  correctly: it nudges within the unfiltered list, or it would appear to do
  nothing.
