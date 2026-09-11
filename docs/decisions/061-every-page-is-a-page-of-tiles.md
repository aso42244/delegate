# 061 — Every page is a page of tiles

**Status:** accepted
**Date:** 2026-09-10

## Context

The owner looked at five screenshots side by side — Overview, Budget,
Transactions, Recurring and Rules — and said the interface was "just a little
bit different" on each page. He is right, and the difference is not taste. It is
the same drift [ADR 033](033-one-ui-system-with-a-test-that-holds-it.md) was
written to stop, arriving again in the one place that ADR did not put a number
on: **the box things are drawn in.**

Counted, on 2026-09-10:

- **Three implementations of one box.** Overview's `TileShell`, Settings'
  `SettingsCard`, and a bordered `<section>` that five files wrote out by hand.
  Same radius, same border, same `bg-canvas`. Two padding values (`p-4`, and
  `p-3` on the two suggestion panels). Two heading sizes (`text-section` on a
  tile, `text-base` on a card). Two places for the description — beside the
  title on Overview, under it on Settings.
- **Two grids.** Overview counted in twelfths and Settings in sixths, so
  `span="half"` emitted `lg:col-span-6` on one page and `lg:col-span-3` on the
  other. One word, two meanings, and nothing to tell them apart at a call site.
- **A page that started 24px lower than the others.** The Rules page wrapped
  `PageHeader` — which owns the 24px step, precisely so no caller has to — in a
  `flex-col gap-6`, so its one tile began 48px below its title. Invisible on
  that page alone and obvious the moment it is beside Overview. This is the
  defect the owner actually named.
- **Two hand-rolled dialogs**, both on the Budget page, the only two left after
  [ADR 038](038-a-dialog-is-measured-against-the-visual-viewport.md). Centred
  cards rather than sheets on a phone, no `visualViewport` measurement, and
  Escape did not close them — so the dialog somebody opens _to type an amount_
  put its amount field and its Transfer button underneath the software keyboard.
- **Four window queries inside a box that is not the window.** `md:w-24` on a
  table inside a tile asks how wide the _window_ is, which stopped being the
  same question in v0.49 when a card stopped being the whole row.

And two pages that were not tiles at all: the Budget page's three tables, and
Recurring, which was a segmented control over two full-page views.

## Decision

**One tile, one grid, one header shape, and a test for each.**

### The tile

`components/Tile.tsx` is the only place the surface
`rounded-lg border border-line bg-canvas p-4` is written, and
`ui-system.test.ts` fails the gate on a second one. A tile is a surface, an
optional header, a body and an optional footer.

**The header is `PageHeader`'s shape**: title, actions right, one line of
description underneath at the 4px step. A header is a header whether it belongs
to a page or to a tile, and it was three shapes.

**The footer belongs to the shell, not to the body.** Four tiles on Overview
drew their own `border-t` line as the last child of a scrolling list, so "All
bills →" scrolled away on a tile with eleven bills in it.

**A tile's title is optional.** Where the content already carries its heading in
the column it totals — the Budget page's tables, whose section total is the first
row of the table by
[a settled decision](../design.md) — the tile is a surface and nothing more.
Repeating "Delegations" above a table that says it is the drift this pass exists
to delete.

### The grid

**Twelve columns everywhere**, `gap-6`, and four names: `third`, `half`,
`two-thirds`, `full`. Settings' six-column grid is gone. Twelve divides by 2, 3
and 4 with nothing left over, which is every fraction either page ever wanted,
and a `span` now means one thing.

`TileColumn` is a grid cell holding tiles stacked down it — for a column of
tiles that belong together, which two spans only agree to by coincidence.

### Recurring is two columns

**Due and Cost are on screen at once**, at the owner's request, rather than two
views behind a segmented control. A switch between two answers that are never in
each other is a switch somebody has to press to find out which one they wanted,
and it meant the page could only ever answer half of what it knows.

Due takes two-thirds because it is a seven-column table; Cost is a column of
dense lists, which read down to about 300px and no further —
[`ui-system.md` §2](../ui-system.md) has that floor already.

**The Cost half is two tiles of rows** rather than a grid of 330px cards, one
per utility. Two cards filled a laptop row and the third utility was below the
fold. The rows are the shape "Spending by grouping" and "Coming up" already use.
Nothing is dropped: the per-cycle comparison is one tile, the twelve months and
the monthly average the other, and the sentence naming the divisor is a footer.

**Three things left the Due half**, each at the owner's request and each with a
reason that survives him:

- **The count.** "10 recurring." is a fact about how long the household has been
  running rather than about the list somebody came to work through — the same
  argument that took "494 transactions" off the register in v0.34.
- **The overdue count with it.** The pill says it, away from the page, which is
  where saying it is useful.
- **The hidden fold.** A list of corrections is not what anybody opens this page
  for, and Due is a tile beside another tile with nowhere sensible for a fold.

### Hidden bills move to Settings → Budget

Not to Settings → Archived, which was where they were put first and is wrong.
**"Archived" means something exact here** — `archived_at` on a row — and a list
of hidden bills under that heading reads as a claim that the charges were
archived too. The owner read it that way within a minute of being told about it,
which is the whole evidence needed.

They are not. `bill_overrides` holds one row per merchant carrying a refusal and
a name, and it touches no transaction: every charge stays in the register, still
categorized, still searchable, still counted in every figure it was counted in
before. **The card says so in its description**, because that is the question
somebody asks standing in front of it, and the row menu's "Not a bill" says it
too — "The charges stay." — because that is where the fear starts.

Settings → Budget is the right section by the rule Settings is grouped on: this
is a correction to what the register _infers_, and the switch governing overdue
notifications is already in the card above it.

The rule the fold was written for still holds and is why this moved rather than
went: **a correction nobody can find is one nobody can undo.**

### What else became a tile

- **The Budget page's three tables.** `design.md` §5 called this a borderless
  spreadsheet with no card box, written when Budget was the only page — the
  contrast it reached for was against nothing, and beside a dashboard of tiles it
  read as the one screen that had not been designed. The table is unchanged: the
  2px rule is still the separator and the total is still the first row of its own
  table.
- **The register**, with its filters as the tile's header controls and its pager
  as the footer, which is what keeps the pager on screen rather than at the
  bottom of fifty rows. No title: the page header says "Transactions" a few
  pixels above it.
- **The duplicate and pair panels**, which were `p-3` boxes with 14px headings
  and three-line descriptions.

### And two things that are not new rules

**Both hand-rolled dialogs are `Modal` now**, and `role="dialog"` outside
`ui.tsx` fails the gate. ADR 038 was already the rule; nothing was checking it.

**Every width inside a tile is a container query.** `@xl:w-24`, never `md:w-24`.
The gate checks column widths and table layout, which is where it bites.

### One trap, found by looking at the page

**A tile's group is named: `group/tile`, never a bare `group`.** Overview's
shell carried a bare one for its drag grip, which was harmless while exactly one
component had it. The moment every box on every page became that component, it
collided with the group the _table rows_ use — `.group:hover
.row-menu-trigger` reveals a row's `⋯` and its absorb button, and it matches any
hovered ancestor carrying the class. So hovering anywhere over the budget drew
"Move surplus here" on every line at once, and `.group:focus-within` meant a
press into the register's search box did the same to fifty rows.

Nothing failed. Every test passed, because each of those controls is still in
the DOM and still reachable — only _when_ they appear changed, and no test
asserts that a control is hidden. It was found in a screenshot, which is the
same way the owner finds most of these.

The general shape is worth more than the fix: **a utility class that is
effectively global stops being safe the moment a second thing uses it.** Tailwind
has named groups for exactly this, and this codebase was already using them
(`group/toggle`, `group/bar`) — just not where it mattered most.

## Consequences

Four new rules in `ui-system.test.ts`, each written against a defect that
actually happened rather than a principle: one box, one dialog, one step below a
page title, and container queries for widths. The page-title rule was checked
against the Rules page as it stood and does catch it.

`docs/ui-system.md` §1 is corrected: it said 12px was the tile-to-tile step on a
dashboard while both grids had been using 24px since v0.59. The document was
wrong and the code was consistent, which is the better way round to find it.

The Bills table's Delegation column is now drawn only where the tile is wide
enough to afford it (`@2xl`), with the delegation in the row's hover text at
every width. Due is two-thirds of the page and a merchant name is the one column
whose content has no upper bound — the same trade `design.md` records for the
"last seen" column that was removed for the same reason.

**`?view=cost` is gone**, and `/utilities` redirects to `/recurring` rather than
to a view that no longer exists. Both old addresses still land on a page carrying
what they named, which is the whole of what a bookmark is owed.

## Alternatives considered

**Leave Settings on six columns.** Rejected: the cost of two grids is not the
grids, it is that `span="half"` means two things and a reader cannot tell which
without opening the file.

**Keep Due and Cost as views and just fix the tiles.** Rejected by the owner, and
he is right — the two questions are asked in the same sitting, and neither
answer is in the other.

**Keep a card per utility and shrink it.** Rejected: the four labelled figures
are a settled decision and they are kept, but as a column heading and a row's
hover text rather than four labels repeated per utility. A list of six utilities
does not have room to say "Suggested per cycle" six times.

**Put hidden bills in Settings → Archived.** Tried, and reversed within the hour
for the reason above. Recorded here rather than quietly dropped, because the next
person looking for a home for a list of put-away things will have the same idea.
