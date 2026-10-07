# 078. A month is read back, never stored

**Status:** accepted
**Date:** 2026-10-04

## Context

The household wanted a look back at a finished month: what came in, what went
out, which lines went further than they were given, which bills changed, and
what net worth did. Overview answers "where do I stand"; nothing answered "how
did that month go".

The obvious build is a monthly report written once the month closes. That
would be a second copy of the ledger — and the ledger here is corrected after
the fact all the time: a charge categorized a week late, a duplicate archived,
a split adjusted. A stored September would keep the September that existed on
the day it was written.

## Decision

**Month in review is computed from the ledger every time it is opened, and
nothing about it is stored.** One page, `/review`, beside Overview in the
navigation (`Month` on the phone's tab bar), opening on the last finished
month. The month in progress is not offered: a fortnight of a month reads as
a collapse.

- **Came in and Went out count in-budget accounts only**, the accounts the
  identity sums. An off-budget account's purchases are net worth, and they
  show there.
- **Each line from start to end** (amended 2026-10-07): what the line held as
  the month began, what Delegate presses gave it, what transfers and
  adjustments moved in or out, what was spent from it, and where it ended.
  Start + delegated + moved − spent = end, and end is the ledger's own balance
  at the month's close. The first version counted presses alone, so a line
  funded by a carried balance or a transfer read as overspent when it was not.
  Spending is dated by when the transaction posted, as the register's filters
  are, so every Spent figure opens the rows that make it.
- **Lines are shown by grouping, each grouping closed** with its totals; open
  one to see its lines. A line that did nothing all month is left out. The only
  red is an end below zero. The lines and a "Not categorized yet" row add up to
  Went out to the cent.
- **Bills that moved**: a recurring bill charged at least $1 and 10% away from
  its typical amount, a bill whose first charge landed this month, and a
  monthly bill that was due and did not come. Read from the bills Recurring
  already infers, not a second detection.
- **What net worth did**: the nightly aggregate at the day before the month and
  at its last day, split into other assets, Bitcoin at its price, and debts
  paid down.
- **Every figure that sums transactions opens them** (ADR 077). Came in and
  Went out pass `inBudget=true`, a register filter added for this.

## Consequences

- Notes on a month are the next layer and are not built: a row per month,
  kept apart from the figures so a note can never rewrite one.
- A month changes when its rows do. Categorizing a late charge moves it from
  "Not categorized yet" into its line the next time the month is opened, which
  is the point.
- A month before the nightly snapshots began has no net worth section; it says
  so rather than inventing a starting figure.
- The read door does not carry it yet. Eventide can read it later through the
  door if it wants it.
