# 039. A bar is for what costs data; everything else is a pill

**Status:** accepted; the `danger` exception is superseded by
[ADR 040](040-every-notification-is-a-pill.md)
**Date:** 2026-09-01

## Context

The owner had a bank needing re-authorization and a handful of transactions
waiting to be categorized. Both are ordinary. Both raised a full-width bar, so
the Budget page opened with a yellow bar across it, a blue bar across it
underneath, and the budget beginning below both — two rows of chrome carrying six
words of content, on the screen whose entire purpose is the table they pushed
down.

The bar was right when there was one kind of notification. It stopped being right
when there were eight, because it treats "a bank wants a fresh login" and "no
backup has ever completed" as the same size of problem, and they are not.

## Decision

Prominence tracks what ignoring the condition costs.

**`danger` keeps the bar.** `backup_failing` and `sync_failing`: the only copy of
the household's data is at risk, or the numbers on screen are silently stale.
Two conditions out of eight. These earn the width, and they keep the snooze — an
X that puts the bar away for a day and brings it back if the thing is still true.

> **Superseded by [ADR 040](040-every-notification-is-a-pill.md).** The owner
> read this and said to make red a pill too. The reasoning below for why a
> `danger` is different survives; the conclusion that the difference has to be
> paid for in floor space does not.

**Everything else is a pill in the page header**, rendered by `PageHeader` so it
appears on every screen, sitting immediately right of the budget's own reading.
`HeaderPill` is now one component shared by both, rather than the reading having
its own: they are on the same row, and two things that merely resemble each other
drift.

**A pill's face is two or three words; its message is the tooltip.** The server
sends both — `pill` alongside `message` — because the counts and the institution
names are the server's to know. `Sync issue` rather than `Auth issue`: the feed
reports any per-institution problem this way and an expired login is only the
commonest of them.

**No dismiss on a pill.** Snoozing exists because a bar is in the way. A pill is
not in the way, and what makes it go away is fixing the thing.

**The backlog pill carries its own filter**: `/transactions?uncategorized=true`.
The filter moved out of component state and into the URL to make that possible,
which also means the two ways of reaching the register can disagree about what it
should open on — the sidebar means "the register", the pill means "the ones I
have not dealt with", and a single default cannot be both.

## Alternatives

**Everything becomes a pill.** Rejected here on the grounds that "no database
backup has ever completed" reduced to a two-word pill beside a title is a
condition that can end the budget drawn at the size of a tidiness reminder.
**This is what was chosen in the end** — see ADR 040.

**Hide a pill on the page it points at.** Tried, and wrong in the case that
matters most: the cashed-check proposal points at the Budget page, because the
row you confirm is on it. Suppressing it there would have shown that pill
everywhere except where it can be acted on. Left visible, its count also runs
down as the queue is cleared, which is better feedback than disappearing.

**Collapse them into one "3 issues" pill.** Loses the colour, which is the part
read at a glance, and adds a click to find out which three.

## Consequences

A pill is a `Link`, so on a touchscreen the press lands before any hover could and
the tooltip is never seen. That is the right trade: the page it goes to says in
full what the tooltip would have said.

With three pills the header can wrap its action buttons to a second row on a
narrow window. Still one row cheaper than the two bars it replaces, and the
common case is nought or one pill.

The accessible name of the backlog pill — "4 new transactions" — contains
"transactions", so `getByRole('link', { name: 'Transactions' })` in a test now
matches the sidebar _and_ the pill. Playwright matches accessible names as
substrings; the sidebar's link needs `exact: true`.
