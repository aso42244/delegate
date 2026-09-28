# 067 — The Budget page is hidden from the navigation, for a trial

**Status:** accepted, provisional — review on or after 2026-09-29
**Amended by:** [068](068-one-accounts-table-on-both-screens.md), which gives Overview the three things listed below
**Date:** 2026-09-15

Amends [ADR 056](056-where-a-person-lands.md), whose "the sidebar is six entries:
Overview, Budget, Transactions, Rules, Recurring, Settings" this makes five.
Follows from [ADR 062](062-the-budget-is-the-first-block-of-overview.md) and
[ADR 065](065-a-dashboard-you-can-work-from.md), which are between them the
reason the question came up at all.

## Context

The owner's reading after a fortnight of the dashboard: **Overview and Budget
have become duplicative.** He asked for Budget to leave the navigation, for a
couple of weeks, and to be reassessed rather than deleted.

He is right about the overlap, and more right than a glance suggests. The band
across the top of Overview draws **the same `DelegationsTable` component the
Budget page draws** — not a summary of it, the component itself, off the same
`['budget']` query key. Every row menu, every editable amount to delegate, every
target, transfer, manual adjustment and line history is there, and `?lines=all`
widens it from the chosen handful to the whole list. The daily work has genuinely
been in two places since ADR 062.

**What was only on the Budget page** when this was written, established by
reading both rather than assuming, was narrower than the overlap and all of one
kind — and is on Overview too since
[ADR 068](068-one-accounts-table-on-both-screens.md), a day later:

- **Accounts and debts _in their groupings_.** Overview's Accounts & Debts tab is
  a flat list of name and balance, deliberately — `BalanceList` draws no
  grouping, no row menu and no handle.
- **Assigning an account to a grouping**, and **ordering accounts and groupings**
  within Assets and Debts. That is `AccountRowMenu` plus the drag handling in
  `MainBudget`, and it exists nowhere else: Settings → Groupings names and
  colours a grouping, and Settings → Accounts does not place one.
- **The columns-or-stacked arrangement** from Settings → Display, which applies
  to this page and no other.

Every one of those is an **arrangement** task — done when the household is set
up, and revisited when an account is opened or closed. None is daily. That is
what makes a fortnight a fair test rather than a fortnight of being stuck.

## Decision

**Budget leaves the navigation and keeps everything else.** One entry is removed
from `PAGES` in `components/Sidebar.tsx`. The route, `MainBudget`, the API, the
tests and the layout preference are untouched.

**Hidden, not deleted, and deliberately cheap to undo.** Both navigations read
`PAGES` — the sidebar and `TabBar` — so restoring it is the one line the comment
in that file spells out. This is why the change is a line rather than a rewrite:
a trial whose reversal is a project is a trial nobody reverses.

**`/budget` still answers**, and `landing.spec.ts` now asserts that directly
rather than by implication. A trial that quietly broke the thing under test would
answer the wrong question at the end of it.

**A landing preference of `budget` is left alone.** `LANDING_PAGES` still offers
both, and anybody who chose Budget still lands there. Two reasons: it is a
decision somebody made, and ADR 056's whole argument for storing null rather than
a default is that the application does not overwrite those; and the setting is
the one remaining route to the page that does not require remembering an address.

**The demo loses it too.** `DEMO_PAGES` is a filter over `PAGES`, so naming a
page that is no longer in the list matches nothing. `/demo/budget` is still
routed. The alternative — a demo that advertises a page the application hides —
is worse than a demo with one destination for a fortnight.

## Consequences

- **Nothing in the application links to `/budget` any more.** It was only ever
  the navigation entry: no row menu, no notification and no redirect points
  there. Two notifications — checks to confirm, and lines behind their target —
  use `actionPath: '/'`, which resolves to the reader's landing preference, so
  where they land is unchanged by this and was never Budget-specific. The "lines
  behind" one carries a comment saying it goes to the Budget page; that comment
  was already describing an intention rather than the behaviour, and the work it
  describes is on Overview's band either way.
- **Reaching it during the trial is by address or by landing preference.** Worth
  saying plainly, because it is the trial's one sharp edge: if the arrangement
  tasks above are needed in the fortnight, `/budget` has to be typed.
- **Four end-to-end tests moved off the navigation entry.** `transactions` and
  `demo` pressed it to navigate, and `phone` used it twice as the signal that the
  tab bar had rendered. Each now uses Overview, which is a better signal anyway:
  it is the first destination and it exists on every device.
- **`landing.spec.ts` asserts a position rather than a pair.** "Overview then
  Budget" became "Overview first, and Budget nowhere in the list", plus a new
  test that the address still serves the page.
- **The `budget` icon stays in `PageIcon`.** Nothing draws it while the trial
  runs. Removing it would be a second thing to undo.

## How this ends

One of two ways, and the point of writing it down is that neither is a drift.

**Put it back:** restore the one line in `PAGES`, revert this ADR to superseded,
and say what was missed.

**Delete it:** `MainBudget`, its routes, and `budget-layout` with the Settings →
Display control that feeds it. It said here that this had to wait until Overview
had a home for grouping and ordering accounts, because that was the part with
nowhere else to go and deleting before it would be deleting a capability rather
than a page. [ADR 068](068-one-accounts-table-on-both-screens.md) built that
home: the band draws `AccountsTable`, the same component this page does, so all
three of the gaps above are closed and `AccountRowMenu` and the account placement
endpoints stay whichever way the trial ends.

**What deleting would still cost** is the columns-or-stacked arrangement, which
belongs to this page alone — and the answer to that is to drop it with the page
rather than to rebuild it on a dashboard whose arrangement is already the
household's to drag.
