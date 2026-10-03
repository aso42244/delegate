# 076. Each tile keeps its own period

**Status:** accepted
**Date:** 2026-10-03

## Context

Overview had one period for the whole page: a segmented control in the header,
Cycle by default, carried in the URL as `window`. The cashflow chart was the one
exception, with its own control stored on the tile, because "where did the money
go" is read at a different cadence from "where do I stand".

With Budget gone, Overview is the page read every day, and the exception turned
out to be the rule. Spending by grouping is a this-cycle question; net worth over
time is a quarter-or-longer question; burn rate is somewhere between. One
control for all of them meant whichever was chosen made the others wrong, and a
period in the URL was forgotten the moment somebody opened the bare address on
another device.

## Decision

**Every tile drawn over a period carries its own picker, in its header**: a small
segmented control offering Cycle, 30D, 90D and YTD. The choice is stored in that
tile's `config.window`, on the server, so it is remembered per person and is the
same on every device they sign in on. The header picker and the URL parameter are
gone.

**Defaults: the cycle for the two spending tiles, ninety days for the rest.**
Spending by grouping and by delegation answer "what has this cycle's money gone
on", which is read against the budget, and the budget is a cycle. Everything else
— the series through time, movers, burn rate, cashflow, an account's history —
starts on ninety days. `TILE_WINDOW_DEFAULTS` in `domain/overview.ts` is the list.

**Shared series are computed once per distinct period, not once per page.** The
three aggregate tiles and the two composition tiles used to share one series
because they shared the page's period. They now share one per period: three
tiles on ninety days cost one read, and one moved to the cycle costs a second.
The payload carries them keyed by tile (`aggregates`, `compositions`), and a
`windows` map saying which period each tile is on.

**A stored period the picker does not offer is kept and read as the default.**
The cashflow tile used to offer `1yr`. A layout save re-sends every tile's
configuration, so refusing the old value would make every later rearrangement
fail; the server accepts any spending window and reads only the four.

## Consequences

- A tile's period is part of its configuration, so changing it is a layout save
  and marks the layout arranged — the same as pointing the account history tile
  at an account.
- The account history tile's configuration holds two things now, the account and
  the period, and the page merges a change into the configuration rather than
  replacing it.
- The picker in Arrange previews each tile on its default period.
- The read door is unchanged: it asks for its three tiles on the cycle, as it
  always has.
- `/overview?window=…` links still open, and the parameter is ignored.
