# 077. Every figure opens its rows

**Status:** accepted
**Date:** 2026-10-04

## Context

A figure that sums transactions is a claim about a list of rows. Until now
almost none of them could be checked: the daily outflow cell opened a dialog,
and that dialog's "Open in the register" link brought the day's income and
refunds along, so the rows did not add up to the cell. Everything else —
spending by grouping and by delegation, the figures band, the pace bars,
cashflow, income per cycle, a utility's month — was a number with nothing
behind it.

The audit for this found three places the figures and the register would have
disagreed even with links:

- **The cycle started at the wrong instant.** `payCycleAt` returns calendar
  dates stored as UTC midnight, and the figures band, the pace bars and the
  read door counted from that instant directly. In Chicago that is 7pm the
  evening before payday, so the last hours of one cycle landed in the next
  one's Spent, Inflow and every pace bar.
- **Cashflow's Uncategorized** counted rows on accounts outside the budget,
  which the uncategorized queue rightly leaves out — they cannot be filed.
- **A split row** is a whole charge in the register and a share in every sum
  built from allocations.

## Decision

**Every figure that is a sum or a count of transactions links to the register
filtered to exactly those rows**, and the register says whether they reconcile.

- The register reads its filters from the URL: `delegationId`, `groupingId`
  (`none` for no grouping), `kind`, `sign` (`in` or `out`), `source`,
  `dateFrom`, `dateBefore` (exclusive), `day` and `uncategorized`. Each one is
  drawn as a pressed button that takes itself off. `components/drill.ts` is
  the one place a link is built.
- **A window is always an instant the server sent**, never a date the browser
  worked out: the overview payload carries `figuresSince`, `panelSince` and
  `cashflow.since`, the spending tiles their `since`, and each utility month
  its `from` and `before`.
- **Under a delegation or grouping filter a row counts at its share.** The
  API returns `shareCents` per row and in total; the row shows "−$70.00 of
  −$100.00". This is what the figure summed, so the total matches it.
- **The link carries the figure** (`figure`, `expect`). The register's footer
  says "Matches 2 - Food on Spending by grouping" when its total is that
  figure to the cent, and says the figure has changed since when it is not.
  Taking any filter off drops the claim, because the list is no longer the
  figure's.
- The cycle is counted from **the payday's midnight in the household's zone**,
  in the figures band, the pace bars, Bills this cycle and the read door.
- Cashflow's Uncategorized counts **in-budget accounts only**, the queue's own
  predicate. An off-budget charge with no envelope now falls into the
  remainder, which is what it is: money the budget does not track.

## Consequences

- Not linked, deliberately: Left to spend and Safe per day (each a difference
  of two sums, which no list adds up to); net worth and every chart through
  time (balances and snapshots, not transactions); movers and burn rate (built
  from nightly delegation balances); bill forecasts.
- Income per cycle links its income. The spending beside it on the same row is
  a comparison, not the row's figure.
- Spent, Inflow and pace bars on a household west of UTC lose the evening
  before payday from this cycle's figures, which is the correction.
- A pace bar floored at zero by a net refund opens its rows without claiming a
  match: a refund is not a zero the register can be asked to equal.
