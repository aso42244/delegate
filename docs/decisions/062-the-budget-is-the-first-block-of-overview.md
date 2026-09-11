# 062 — The budget is the first block of Overview

**Status:** accepted
**Date:** 2026-09-11

Amends [ADR 053](053-a-pace-bar-reads-two-marks-not-one.md), whose consequence
"Overview and Budget now describe the same line differently" this deliberately
reverses, and supersedes the `sidebar` region introduced with the docked panel.

## Context

The panel was docked down the right of Overview in a 398px column, and it was a
**reading**: a chosen handful of lines, a pace bar each, three tabs, and no way
to act on any of it. Its own doc comment said so — _"Budget stays the working
surface … This is a reading."_

That split cost something every day. A review that found an overspent line ended
on another page, and the two surfaces drew one list twice: the panel's chosen set
was a second ordering of a budget that already had one.

The owner asked for the panel moved to the top of the page, full width, as the
first and most useful block — with everything the Budget page can do to a line
available on it, and the tiles below.

Two facts decided the shape rather than taste:

- **Two money columns and a recognisable name do not fit in 398px.** Measured in
  v0.60.0, when three money columns were cut to one and names truncated to about
  ten characters. A docked column can never be the working surface; a full-width
  block can.
- **The second region existed only because of the dock.** `region` was `main` or
  `sidebar`, and `sidebar` meant "the single column under the panel". With the
  panel across the top there is no right-hand column for it to mean.

## Decision

**The band is the page's first block, pinned.** Full width, above the tiles. It
is not a tile: it cannot be dragged, removed, or dropped onto, and nothing can be
placed above it or beside it.

**It is the Budget page's own table, not a second one.** `DelegationsTable` holds
the editable figures, the row menu, dragging, folding a grouping, closing the
reading against a line and confirming a cheque — and both surfaces render it.
Two renderings of one table is precisely how two screens come to disagree about a
budget, which is the failure this whole change exists to end. What the two
surfaces differ in is two props: a pace bar, and a narrowing to the chosen lines.

**Show selected / Show all**, at the right-hand end of the bar — the tab's own
control, in one position whichever tab is showing. The scope lives in the URL, so
it survives leaving the page and can be linked to, and it opens on the chosen
lines every time rather than remembering: the point of choosing a few is that the
daily open is short.

**Selected is a flat list.** Eight watched lines spread over six groupings is six
headings and eight rows, which spends more of the band on saying where a line
lives than on what is in it — and the reader chose them one at a time, so they
know. Each row keeps its grouping's colour, because the tint is how a line is
found in a column and losing the heading must not lose that too.

**Two tabs, not three.** Accounts and Debts are read together — what there is,
and what is owed against it — so they are one tab, **Accounts first**, with a
`With balance / All` switch: some cards genuinely hold nothing some of the time,
and a list that hides them silently is one somebody goes looking for.

**A phone gets the band and nothing else.** Overview on a small screen is the
screen this household reads most and acts on least, and a dashboard of charts
under it is a scroll past the only thing anybody opened it for. The tiles are
still arranged, still stored, and still there on a laptop.

**`region` stays in the database and is still read.** An arrangement made before
this release opens with every tile it had — anything in the sidebar is appended
as a row of its own — and the next save writes them all back as `main`. That is
the migration: no column changes, and nothing is lost if nobody ever rearranges
anything again.

## Consequences

- **The Budget page still exists, and now has a twin.** Everything it does, the
  band does. That is a duplication of _destination_ rather than of
  implementation — one component draws both — but it is a real one and it is the
  owner's call whether the page survives. It was left alone here because deleting
  a destination nobody asked to delete is not a side effect to slip into a
  release about something else.
- **`buildPanel` computes every line rather than the chosen ones.** A selection
  that filtered the figures would leave the bars missing on the one view that
  shows the most of them. The selection travels beside the figures as
  `panelSelected` and decides what is drawn.
- **`BudgetSection` gained two optional props**, `pace` and `tintFor`, and the
  Budget page passes neither. A table that draws a pace column only when handed
  one is a table with one implementation; a second component would have been two.
- **`TransferDialog` moved out of `pages/MainBudget.tsx`.** Two other files
  already imported it from there, which is a dialog that has outgrown its page.
- **The four-way phone control is gone**, and with it the idea that Overview is a
  fourth tab beside the panel's three.
- **The pace column is fixed width and absent on a narrow screen.** Fixed because
  the tick is a time marker and has to read as one straight vertical down the
  page (ADR 054); absent below the breakpoint because the row is already choosing
  between its two money columns there.
