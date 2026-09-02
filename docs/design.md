# Visual design

> **The measurements live in [ui-system.md](ui-system.md).** This document is the
> visual language — colour, chips, tone, and the record of decisions. That one is
> the spacing scale, field widths, button rules and the text budget every screen
> must use, and `ui-system.test.ts` enforces it. Where the two touch, this
> document says _why_ and that one says _how much_.

The owner's design specification. **Visual only** — it describes nothing about
behaviour. Where a design specification and a functional requirement disagree,
**functionality wins and the design bends around it.**

Six such disagreements were found on first reading. All are settled and **this
document now states the resolved design** — read it as written rather than
cross-referencing anything. The reasoning behind each change is recorded at the
bottom, so nobody re-derives the original wording from the build prompt later.

This is a starting point, written before the UI exists, and is expected to change
once real data is on screen.

## 1. Principles

- Dense but clean and readable. Density is valued, never at the cost of legibility.
- Minimal, industrial, neutral. White canvas, thin borders, quiet greys, generous
  whitespace _between_ sections but tight spacing _within_ data tables.
- Colour is semantic or organisational, never decorative, and never in your face:
  soft tints, not saturated fills.
- One typeface, few weights, few sizes. No gradients, no heavy shadows, no pill
  buttons except where noted.

## 2. Colour

| Role                                       | Value                                                   |
| ------------------------------------------ | ------------------------------------------------------- |
| Primary text                               | `#2C2C2B`                                               |
| Secondary text                             | `#7D7A75`                                               |
| De-emphasised data (To Delegate column)    | `#B4B1AB`                                               |
| Canvas                                     | `#FFFFFF`                                               |
| Soft surface (page background, headers)    | `#F9F8F7`                                               |
| Secondary surface (hover)                  | `#F0EFED`                                               |
| Borders                                    | `#E6E5E3`                                               |
| Primary accent (links, active nav, button) | `#2783DE`                                               |
| Accent soft (active nav, cell hover)       | `#E5F2FC`                                               |
| Positive / balanced                        | `#46A171` on `#E8F1EC`                                  |
| Warning                                    | `#8A6A14` on `#FFF4D6`, border `#EFDFAF`, dot `#D5803B` |
| Danger                                     | `#93332B` on `#FCE9E7`, border `#F2C4BF`, dot `#E56458` |
| Awaiting confirmation                      | `#6B3FA0` on `#F4ECFB`, border `#D8C2EC`, dot `#8B63B8` |
| Negative amounts                           | `#E56458`, text only, semibold                          |

### Grouping colours

The owner picks a colour per grouping from a curated palette — green `#46A171`,
blue `#2783DE`, orange `#D5803B`, purple `#8B63B8`, and a neutral grey default.
**Every delegation inside a grouping inherits that colour**; there is no
per-delegation colour.

Expression is restrained: the grouping header row takes a soft tint of the
colour, delegation rows within it an even fainter tint, and a 10px rounded-square
chip sits left of the grouping name. Text stays near-black regardless.

## 3. Typography

- System sans stack: `-apple-system, "Segoe UI", Roboto, Helvetica, Arial`.
- Base 14px / 1.5. Table body 14px. Column headers 11px uppercase, `0.05em`
  letter-spacing, secondary grey.
- **All currency uses `font-variant-numeric: tabular-nums` and right alignment.**
- Page titles 24px/700. Section titles 16px/700. Emphasised data 15px/700.

## 4. App shell

**Sidebar**, left, 232px: white, 1px right border. Brand mark and app name, page
navigation, user chip, and a full-width sync button with a "last synced" caption.

Collapsible to a 64px icon-only rail via a `«` button that flips to `»`. Collapse
state persists across sessions. Active nav item: accent-soft background, accent
text and icon. Nav items 14px/500, 17px icon, 6px radius.

**Main content**: soft-surface background, max width ~1200px, 28–36px top
padding, 24–48px side gutters. Page header is title plus a one-line grey subtitle
on the left, primary actions on the right.

## 5. Budget

### The balance reading

A chip **beside the page title**, baseline-aligned with the controls across the
header. Button-shaped so it sits in that row's rhythm, and deliberately not a
button: there is nothing to press, so it takes `cursor: default`.

It was a full-width bar carrying the state on the left and the equation on the
right. The equation is the reason to trust the figure, but it is not read twice a
day, and a bar's worth of page for it pushed the budget itself down the screen.
The state stays visible; the working is one hover away.

Thresholds derive from the **configured tolerance** — set in Settings, default
$5.00 — rather than being fixed. `T` below is that value.

| Condition  | State       | Look                        | Label                    |
| ---------- | ----------- | --------------------------- | ------------------------ |
| ≥ +T       | To delegate | Accent blue on accent-soft  | `To delegate $4,890.00`  |
| Within ±T  | Balanced    | Green                       | `Balanced`               |
| −T to −2T  | Warning     | Yellow; shows the shortfall | `Over delegated $7.40`   |
| Beyond −2T | Danger      | Red; shows the shortfall    | `Over delegated $212.00` |

State first, then the figure. It is a label on a chip now rather than a sentence
in a bar, and it reads as one.

**The working appears on hover _and_ on focus.** The chip takes `tabIndex` and
carries the equation as its `aria-describedby`, so the justification for the
number is reachable without a mouse — a reading only a pointer can interrogate is
one some people never get. The tooltip sits outside the `role="status"` live
region, or revealing it would re-announce the whole reading on every hover.

**A positive reading is not a warning.** It is the ordinary state on payday:
money has landed and has not been distributed yet, and that figure _is_ the
amount available to delegate. Colouring the most common healthy state yellow
would teach the owner to ignore the one reading that has to be read. Yellow and
red are reserved for over-delegation — the direction that is genuinely wrong.

### Tables

Borderless spreadsheet style: no card box, a 2px near-black rule across the top
of each table, then 1px `#E6E5E3` row dividers. No fill on the header row.

Rows are **40px tall**, with a **32px compact** setting in Settings → Display.
Only the spacing differs; the type size is the same in both, so compact is denser
without being smaller. The preference is stored per device rather than per
household — it describes the screen someone is looking at, the same reasoning as
the sidebar's collapsed state.

Section header above each table: 16px title left, accent-coloured
"+ Add …" links right. Rows are 8px vertical / 14px side padding. Assets and
Debts show Account, Source (grey tag chip), Balance (right), ellipsis.
Delegations show Delegation, Remaining, To Delegate, ellipsis. Alphabetical
within each section and grouping.

**Column emphasis.** _Remaining_ is the hero: 15px, 700, near-black. _To
Delegate_ is deliberately quiet: 13px, 400, `#B4B1AB`, and its header is the same
grey. Negative Remaining renders red semibold.

Grouping rows carry a disclosure caret (`▾` / `▸`) and colour chip, show no
amounts when expanded, and when collapsed show summed Remaining and To Delegate
plus a "(collapsed — N delegations)" hint.

Ad-hoc delegations — those with a null amount to delegate — show a grey em-dash
rather than `$0`.

A ghost "+ Add delegation row" sits at the bottom, then a totals row: bold, 2px
top border, soft-surface background.

Every number cell is click-to-edit; hovering an editable cell shows an
accent-soft highlight.

### Row menu

Triggered by a `⋯` button at the right edge, visible on hover **and reachable by
keyboard focus**. White card, 250px, 10px radius, 1px border,
`0 4px 16px rgba(0,0,0,.10)`.

Contents, top to bottom:

1. Delegation name, 13px/650.
2. A "Note to self" panel on soft surface in italic secondary text, rendered only
   when a note exists.
3. **Rename**
4. **Utility**, with a right-aligned toggle.
5. **Manually adjust this line** — writes a delta, never an absolute.
6. **History for this line** — the per-delegation event history. This is the only
   route to it, because adjustments deliberately never appear on the Transactions
   page.
7. **Move to grouping** `▸`
8. Divider.
9. **Archive**, in danger red.

Items are 13px, 7px vertical padding, 6px hover radius. Dismisses on outside
click.

**Archive, not Delete.** Nothing in this system is ever hard-deleted: archived
rows keep resolving, so an eight-month-old transaction still renders
`Grocery (archived)` rather than a dangling id. A menu item labelled Delete would
name behaviour that does not exist.

Archiving a delegation is **blocked unless its balance is exactly $0**. The
blocked state offers Transfer and Adjust inline, so the line can be zeroed
without leaving the menu.

## 6. Other pages

- **Transactions** — same table language; a bordered card is acceptable here.
  Search input with leading icon, filter dropdowns. Delegation shown as a small
  rounded chip tinted with its grouping colour. Badges: "Pending" amber, "Paired"
  grey. Income amounts green with a leading `+`.
- **Utilities** — card grid, ~330px minimum. Each card: name plus grouping chip,
  a 12-bar mini chart of the trailing twelve months (current month full opacity,
  others ~28%), and a footer with the 12-month average in bold and the suggested
  per-cycle amount.
- **Insights** — card grid, two columns on desktop. Cards have a title and an
  `×` remove affordance. **Add from catalog** is a button in the page header
  beside the window controls; it was a dashed tile at the end of the grid, which
  put an action on the page wherever the last card happened to leave it — below
  the fold once enough were on. Charts use the
  accent for the primary series; the ordered multi-series palette is `#5E9FE8`,
  `#EAC26B`, `#72BC8F`, `#BF8EDA`, `#DE9255`, `#DF84A8`, `#4FB9C9`, `#E97366`.
  Period chips as small segmented controls, active chip filled with the accent.
- **Settings** — bordered cards, 14px headings, one-line grey description.
  Account rows: name, a small Asset/Debt tag, right-aligned In Budget / In Net
  Worth toggles.

## 7. Components

- Buttons: 8px radius, 1px border, 13px/600. Default white on border, hover soft
  surface. Primary solid accent, white text.
- Toggles: 36×20px, `#F0EFED` off, accent on, white knob.
- Tag chips: 11px/600, 4px radius, secondary surface, secondary text.
- Interactive targets ≥ 44×44px where feasible; visible accent focus ring.

## 8. Responsive

Desktop-first. Below ~900px the sidebar auto-collapses to the icon rail, gutters
shrink to 16–24px, multi-column grids become one column, and wide tables scroll
horizontally inside their container rather than squeezing.

## 9. Accessibility

WCAG AA minimum: 4.5:1 body text, 3:1 for large text and meaningful boundaries.
**Never convey state by colour alone** — the banner states the variance in words,
and negatives carry a `−` sign. Respect reduced-motion; no animation is required
to understand the interface.

---

## Decisions where the design met the functional requirements

The design specification is visual; the build prompt is functional. Where they
disagreed, functionality won and the design above was rewritten to match — this
section records what changed and why, so nobody re-litigates it from the original
specification later.

All six are **settled**. The design above is now the authority; this is history.

### 1. Archive, not Delete — settled

The design specified **Delete in red** in the row menu. Hard constraint 3 is that
nothing is ever hard-deleted: delegations, groupings, accounts and transactions
are archived with a timestamp and stay resolvable so an eight-month-old
transaction still renders `Grocery (archived)`.

A menu item labelled Delete would name behaviour the system does not and must not
have. **The item reads Archive**, still the destructive-red item at the bottom.
Confirmed by the owner.

### 2. The row menu was missing two required items — settled

The design listed Rename, Utility, Move to grouping, Delete. §9.1 also requires
**"Manually adjust this line"** and **"History for this line"** — the latter being
the only route to per-delegation history, since adjustments deliberately never
appear on the Transactions page.

**Both added.** Confirmed by the owner, who asked that the specification be
updated to match the functionality rather than carry the discrepancy.

### 3. A positive reading is informational, not a warning — settled

The design coloured a **positive** unassigned sum yellow. But per §6.6 a positive
number is the ordinary, healthy state on payday: money has landed and has not been
distributed yet, and that figure _is_ the "available to delegate" amount.

Colouring the most common good state as a fault trains the owner to ignore the
banner, which is the one thing it must not do. **Positive is now informational**
— accent blue, labelled `$4,890.00 to delegate`. Yellow and red are reserved for
over-delegation. Confirmed by the owner.

Separately, the thresholds were fixed at ±$4.99 / −$10.00 while the tolerance is
configurable in Settings. **Thresholds now derive from the configured tolerance**,
with danger at twice it.

### 4. Grouping colour as a row tint — settled

§11 said grouping colour "must not be in your face", specified a 3px left rail or
a small dot, and said **"never a filled row background."** The design specifies
soft tints on the grouping row and its children.

The newer design is the owner's own and supersedes it, and soft tints are a fair
reading of restraint. **The design is followed**, with tints kept faint enough
that near-black text holds 4.5:1 contrast, and re-judged against real data as §12
anticipated.

### 5. "Insights", not "Metrics" — settled

The design called the page **Metrics**; §9.4 and decision 1 of §15 deliberately
name it **Insights**. **Insights** is used throughout. Still the owner's to
overturn — it is a naming preference, not a constraint.

### 6. The app name is personal data — settled

The design titled the application with a family name. Hard constraint 4 forbids
personal data in the repository, and §5 requires that going public be a README and
a LICENCE rather than a refactor.

**The displayed name comes from the `APP_NAME` environment variable**, defaulting
to `Delegate`. The owner sets his own in `.env`, which is git-ignored, so
the repository stays free of it. Confirmed by the owner.

## On a phone

**Navigation is a bar along the bottom**, not a sidebar. The five destinations
and the five icons are the sidebar's own; the difference is 56px of height and
an inset rather than 232px of width, which on a 390px screen is 59% of it. It
hides as the page scrolls down and returns as it scrolls up — the gesture for
seeing more of a list gives the list more room — and never hides in the first
screenful, where there is nothing to reclaim and hiding reads as a fault.

**Dialogs arrive from the bottom.** A centred card puts its buttons wherever its
own height lands them, which on a tall form is out of thumb reach; a sheet is
anchored to the edge and leaves the page visible above it.

**Anything hidden until hover is drawn**, because a phone cannot hover. That
applies to every row menu and to the reorder and archive controls in Settings.
Touch and hold still opens a row menu — it is a shortcut now rather than the only
route.

**The absorb button is for a pointer only.** It hangs out of flow in the gutter
left of the Remaining column, over space the name is not using at 1200px and on
top of the name at 390px. The same action is in the row menu, which has room to
say what it does.

**Targets are 44px where there is no hover.** The control keeps its size and the
target grows around it: a 20px switch that is 20px to hit is the problem, not a
20px switch.

Below 640px there is not room for a name and two money columns, so the
Delegations table shows **one amount at a time** — Remaining first, because that
is the number the budget is read for. Swiping horizontally across the table
switches to To delegate and back.

**The register is two lines rather than six columns.** What the charge is and
what it cost share the first; the date, the account and the decision share the
second. Categorizing is a **chip**, not a field — a full-width box on every row
reads as sixty things waiting to be typed into, and on a phone nobody types into
it. Tapping opens the picker as a sheet, with the field at the top and the
matches beneath it at a size a thumb can hit.

**Settings is an index list.** About four of thirteen tabs fit at this width, and
scrolling the other nine sideways hides them behind a gesture with nothing to
suggest it. One row reports its state — Sync, where "is it working" is the whole
question — and it reports a fact rather than a verdict, because whether the
backup counts as failing is decided in one place and repeating that judgement is
how two places come to disagree.

Swipe is never the only route. A two-button switch sits above the table doing the
same job, which is what a screen reader, a keyboard, and anyone who does not
think to try swiping will find. The same rule the row menu follows for
drag-and-drop: the gesture is an enhancement, the control is the interface.

A swipe is only read as one when it is decisively horizontal — at least 48px, and
further across than down. A thumb scrolling the page must not find the column
swapped underneath it.

## Keyboard

`j`/`k` and the arrow keys both move between rows in the transaction queue; both
are muscle memory for somebody and supporting both costs nothing. `Home` and
`End` jump to the ends. Movement is clamped rather than wrapped — wrapping from
the last row to the first silently moves the eye to the other end of a long
queue.

`Enter` steps into the focused row's categorize field. `Space` selects the row
for a bulk assignment.

One rule governs all of it: **a keystroke inside a form field belongs to the
field.** Every row in the queue contains a text input, so someone typing a
delegation name containing j or k gets the letters, not three rows of movement.

## Outstanding checks

A check that has been written and not yet cashed is money the household has spent
and the bank has not seen. Until it clears, the envelope it came from would
otherwise show funds that are already committed — and with a chequebook, spending
the same money twice is an easy mistake.

The `⋯` menu on a transaction row also says what the row **is**: ordinary
spending, income, or a transfer between accounts the household owns. A credit
card payment is the common case — confirming the pair does it for both halves at
once, and this is the manual route for when pairing had nothing to suggest,
because the two sides were more than five days apart or the amounts differ.

"Waiting to be categorized" means waiting for a **decision**, not merely lacking
allocations. Income and transfers allocate to nothing by design, so counting
them as uncategorized left every payroll deposit and every card payment in the
queue permanently.

Splitting a transaction and matching one to a check both live in the row's `⋯`
menu on the Transactions page, not as buttons in the row. That menu also carries
**Archive**, for a duplicate — a re-linked institution re-imports rows that are
already in the register, and there was otherwise no way to remove one. Categorizing is the
frequent act there and stays a field; two permanent buttons beside every one of
sixty rows made the rare thing as loud as the common one.

Every row menu has one way in per input device. A pointer hovers the row and
clicks the `⋯`. A keyboard focuses the row, which reveals the same control. A
finger **touches and holds the row**, because a phone has no hover to reveal
anything with — half a second, cancelled by moving more than about ten pixels,
since a finger travelling down the page is scrolling rather than holding. The
platform's own long-press menu is suppressed only for presses this actually
handled, so selecting a description to copy it still works.

A gesture with nothing on screen to suggest it is a gesture nobody finds, so the
Transactions page carries one quiet line saying so — and only on devices where
it applies.

**New check** sits beside Transfer and Delegate on the Budget page. It read
"New outstanding check" until the owner shortened it; the dialog carries the
word "outstanding" in its description instead, where it explains rather than
just lengthens.
It asks for the number, the amount, the date, a memo, and which delegation the
money comes from. Recording one moves the money out of that delegation and onto a
line of its own, filed under **Outstanding Checks** — a grouping the budget owns,
pinned to the bottom of the Delegations section and shown only while something is
in it.

A check is a delegation, technically, which is what keeps the budget identity
exact through the whole life of one. It is not presented as one: its row menu
offers History and Void, and nothing else. There is nothing to rename, re-file or
adjust about a piece of paper that already exists.

When the bank posts the payment, the check is settled automatically if the amount
matches exactly **and** the description names the number as a whole token. Both
are required — an amount alone matches any payment for the same figure, and a
number alone matches a coincidence among the trace numbers and store numbers
banks put in descriptions. Anything it cannot resolve is left for the **Check**
action on the transaction row, which lists what is outstanding.

The spending lands on the delegation the check was drawn on, never on the check
line. Money spent on piano lessons was spent on piano lessons whether or not it
travelled by check; attributing it to "Check 1062" would balance perfectly and
tell Insights something false.

The bank is the record of what was paid. A check written down as $120 that clears
for $125 leaves the envelope $5 short, which is exactly where someone would want
to find the discrepancy.

## Insights, arranged

Tiles move by dragging one onto another, and with **◂ ▸** in their own header.
The order is saved per person on the server, so it follows you to a phone.

Both, for the reason the budget rows already give: a drag is not reachable by
keyboard and does nothing under a thumb, so the buttons are the route that always
works and the drag is the one that feels right with a mouse. The grip beside each
title says the card can be pulled — a card that happens to move when dragged,
with nothing to suggest it would, is a surprise rather than a feature.

Each tile also says how it is drawn, where there is a real choice — a ranked
breakdown reads as bars or as a donut, and a series reads as a line, an area or
columns. Some tiles offer one shape and show no switch at all: a donut of a
single number says nothing, a stacked area is what "what is it made of" looks
like, and an option that made a tile worse would not be a choice worth offering.

**Bitcoin over time** used to carry a note saying quantity history was not
recorded and the line moved with the price rather than with buying or selling.
That stopped being true at [ADR 023](decisions/023-bitcoin-holdings-are-a-dated-ledger.md),
which made holdings a dated ledger, and the note is gone. The line now moves
with both.

## Insights, drawn from snapshots

Since [ADR 035](decisions/035-the-financial-picture-is-snapshotted-nightly.md)
the time-series tiles read a nightly record rather than a reconstruction, which
gives them three things to say that the older ones could not.

**Where a figure came from.** A stretch drawn from estimated days is dashed and
muted with the reason on hover; observed, reconstructed and carried days are all
exact and draw normally. A bucket takes the weakest provenance in it, because a
line through a week is no better than its worst day.

**That it ends on now.** Snapshots are labelled for the previous day, so every
chart appends a hollow marker for current state on a dashed final segment. It is
kept visually apart from the stored points because it is not one.

**That it has nothing yet.** History starts at the first night. Every tile has a
one-sentence empty state — `No history yet — the first night records one.` — and
a one-day tile says that instead of drawing an axis through a dot.

The multi-series palette above is used only where a chart genuinely has several
series and none carries a grouping colour of its own. One line is the accent,
which is most tiles most of the time, and is how §11's "must not be in your
face" holds without an allow-list.

**Delegations drill down three levels** — every grouping, one grouping's
delegations, one delegation — with a breadcrumb back up. The level survives a
change of the page range, so widening from 30 days to a year widens the view you
are looking at rather than returning you to the top. Lines in no grouping are a
level like any other and open the same way.

## Grouping colour

The five presets are a shortcut, not the vocabulary. A colour well and a hex
field sit beside them, so a colour someone already thinks in does not have to be
rounded to the nearest of five. §11's "must not be in your face" holds without an
allow-list, because colour reaches the page only as a tint at 4% and 10% alpha —
even a shouting hex arrives as a whisper.

`#RRGGBB` is still enforced. Three-digit shorthand and named colours are refused
rather than guessed at, because the tint reads the three channels out of the
string by position.

## Account nicknames

An account may carry a short name, shown on the Budget page and in the
transaction register. "Citibank Costco VISA Costco Anywhere Visa® Card by
Citi-7459" is a column of its own on every row otherwise.

The full name stays on Settings → Accounts, where identifying which account this
is happens to be the point, and search matches both — so looking for either what
is on screen or what the bank calls it finds the row.

## One more rule about money

A figure never wraps. A squeezed column was breaking `+$3,527.63` after the sign
and putting the amount on a second line, which reads as two numbers rather than
one.

## What an account is worth

Most accounts carry a dollar balance. A Bitcoin account does not — its
`balance_cents` is zero and its worth is the quantity at today's price. Anywhere
net worth is summed or an account's worth is shown, that valuation is applied,
so a real holding is not reported as $0.00 and net worth is not quietly short by
the size of it.

Without a price the holding contributes nothing, which is the honest answer: a
quantity is not a value until something says what it is worth.

The budget identity is untouched by this. Bitcoin sits in net worth and outside
the budget, so it never appeared in that sum to begin with.

A property with a mortgage against it appears as **one line, at equity**, and
that mortgage is dropped from the debts beside it. The net is identical either
way — this is presentation, not arithmetic — but a $350,000 line taking 96% of
the assets, next to a debt nobody connects to it, describes a household that owns
a house outright. Netting the pair says how much of it is actually theirs.

The line is named `… (equity)`, because the same name against a number that is
not the property's value would be the same confusion in a new place. An
underwater property moves to the debts side, where it belongs. A mortgage that is
not itself in net worth is never netted, since subtracting it here would subtract
it twice.

## Closing the reading against a line

While the reading at the top is not zero, hovering a delegation reveals a small
button — **Move surplus here**, or **Fix deficit from here** when the envelopes
hold more than exists. It is revealed on hover like the row menu: an occasional
act on a row that is mostly numbers.

It sits **immediately left of the Remaining figure**, hung out of flow so the
160px column gives up no width for it. Beside the number it is about, and in one
vertical line down the table rather than wherever each name happens to end.

Three choices, and an unavailable one is shown **disabled with its reason**
rather than hidden. Hiding it makes the dialog look arbitrary, and the reason —
"This line holds $50.00, which is not enough" — is usually what the reader
actually wanted to know. The dialog opens on the first choice that can be
applied.

An outstanding check never offers it. A check holds a specific sum written on a
specific cheque and is settled by matching the payment that cashes it — and that
match is always confirmed by a person, never applied by a sync (ADR 030).

## Delegate, and undoing it

One slot in the header. While the latest run can still be undone the button
reads **Undo Delegation** and is red; when the window closes it goes back to
**Delegate**. There is never a moment where both make sense — a run that has
just gone out is not a run to repeat.

What was delegated, and the fact that undoing rolls the cycle back, sit beside
"This cycle began …" and vanish with the offer. The date stays: the cycle did
not end when the chance to undo it did.

The offer closes on a timer as well as on a refetch. Left alone in a tab,
nothing else would ever ask the server again.

## Ordering delegations

Lines sit where they are put. The order is a column on the delegation, so it is
the same for everyone who signs in — a property of the budget, not of a browser.

Three routes to it, and the last is the one that matters:

- Drop a row **onto another row**: it takes that row's place, in that row's
  grouping.
- Drop a row **onto a grouping**: it goes to the end of it.
- **Move up** / **Move down** in the row menu, beside Move to grouping.

Dragging is the fast route and it is not a keyboard one, so the row menu is not
a lesser alternative — it is the route that always works, including under a
thumb, where a drag gesture would fight the page's own swipe.

Ties break on name, so a new line lands predictably rather than wherever the
database felt like putting it.

## Settings → Users

Two cards. **Your account** is the display name, and everyone gets it whatever
role they hold — a name is not a credential and nothing is looked up by it.
**The household** is the table of accounts, administrator-only, with creating
and editing in a dialog.

It was a permanent creation form at the foot of the page and a set of inline
fields on every row, which made the common case — reading who has an account —
the hardest thing on the screen to do.

**Two-factor has no setting.** It is required of every account including the
first, so the only control is an administrator's **Reset two-factor**, for a
phone that is gone.

## Utilities

Each card's sparkline takes its grouping's colour, the same one as the dot beside
the name. A purple dot above a blue chart read as two unrelated things on one
card.

Both headline figures name their unit, and both are per cycle — the suggestion
and what is actually funded, which is the comparison. How many cycles a year
that is comes from the pay cadence on Settings → Budget, and the sentence under
the cards names the number it used rather than a fixed 26. The monthly average sits in
the sentence explaining where the suggestion comes from. It used to lead in hero
type with an unlabelled "Currently" beside it: a per-month figure and a
per-paycheck one, adjacent and looking comparable.

## The shell, revised

The page is **Budget**, not Budget.

Sidebar icons are drawn rather than typed. They were Unicode glyphs — ▤ ⇄ ◷ ◔ ⚙
— which render at whatever weight and baseline each platform decides, so the set
never looked like a set. They are now inline SVG at one stroke weight on one
grid, taking their colour from the link they sit in. The navigation is tighter:
five entries were spaced as though there were twenty. The brand mark beside the
app name is gone; the word carries it.

## Totals sit in the column they total

Each section's total is the first row of its own table, so the figure lands
directly above the column it sums. The `Total` row at the bottom is gone: it
repeated the section's name in the left column and put the figure furthest from
the thing it totalled. Delegations carries both of its totals there.

The total is inside the table rather than in a heading above it for one reason —
a heading laid out separately has to be kept in step with the columns by hand,
and the drift is invisible until someone reads a column of figures that does not
add up to the number on top of it. The same table means the same layout pass. An
e2e test measures the right edges and holds them within a pixel.

Column headings survive only where there are two money columns to tell apart.
Assets and Debts have one, under a heading that already says what it is.

The identity reading states itself and keeps its working in a tooltip: the label
and figure on the chip, the equation on hover or focus.

## A transaction is one line

A bank description is as long as the bank feels like making it. Rows truncate
rather than wrap, with the full text on hover — sixty wrapping rows is a page
that will not sit still. Only the description gives way: the badges beside it are
short, fixed, and the useful half.

## Utilities, briefly

Hovering a bar names its month and what was spent. The column is full height so
that a month which spent nothing can still be pointed at.

Under the chart, four labelled figures in one column:

|                                 |                                       |
| ------------------------------- | ------------------------------------- |
| Average per month               | the completed months only             |
| Suggested per cycle             | that average spread over a year's pay |
| Delegated per cycle             | what the line is actually set to      |
| Delegated above/below suggested | the comparison the page exists for    |

This was two hero numbers and two sentences underneath, which said the same four
things at three different weights and left the reader to work out which two were
the comparison. Colour still marks a shortfall, but the label says it too.

**Delegated, never funded.** Delegate has one verb for putting money in an
envelope. A second word for it in one corner of the application is a second
concept as far as the reader is concerned.

## A chip is one letter

Every mark that sits beside a row's name is **one letter** — two where one would
collide, and `btc`, which is a word before it is an abbreviation. At eleven
pixels a word costs a row's width and says no more than its initial does once
the initial is known, and the register and the budget are the two places where
width is scarcest.

| Mark  | Means                                      | Where            |
| ----- | ------------------------------------------ | ---------------- |
| `p`   | Pending — the bank has not settled it yet  | Transactions     |
| `i`   | Income — allocates to nothing              | Transactions     |
| `t`   | Transfer between your own accounts         | Transactions     |
| `c`   | Settled an outstanding check               | Transactions     |
| `sp`  | Split across more than one delegation      | Transactions     |
| `m`   | Kept by hand                               | Budget, Settings |
| `s`   | Balance may not be current                 | Budget, Settings |
| `r`   | Discovered by a sync — its type is a guess | Budget, Settings |
| `btc` | Bitcoin holding — quantity × price         | Budget           |
| `h`   | Property — a valuation, not a balance      | Budget           |
| `u`   | Utility — tracked on the Utilities page    | Budget, Settings |
| `n`   | Has a note                                 | Budget           |

`p` and `r` take the yellow; the rest are the quiet grey. Yellow means
something is worth noticing, not that something is broken.

`s` was yellow until v0.34.0 and is grey now. Yellow is for something to do,
and how fresh a figure is is not something anybody can act on — where `p` and
`r` both are. The owner asked for it and the distinction is better for it.

`s` read "Not confirmed recently" until v0.30.0, which was written for a manual
balance nobody had checked. It now covers a synced one too, where the bridge
answers with a snapshot several days old and there is nobody to do the
confirming. One letter, one meaning still holds — the meaning is _this balance
may not be current_, and both cases are that.

Two rules make a vocabulary of letters legible, and both are enforced rather
than promised.

**One letter, one meaning, across the whole application** — not per page. A `p`
that means pending in the register and property on the budget is a vocabulary
nobody can learn. That is why property is `h`, for house. A unit test fails if
two chips ever share a mark.

**The word is always there.** Every chip paints its letter and carries its full
meaning as real text for a screen reader, with the same words as a `title` for
anyone who hovers. A letter with no expansion is a private joke. Locate one in a
test by its meaning rather than its letter: the letter is what is painted, the
meaning is what it is for.

**A mark never repeats what the row already says.** The register used to print
"Split across 2: Grocery, Household"; `sp` says the first three words in two
characters, so the row now reads `Costco Run  sp  Grocery, Household` and the
merchant name keeps the width those words were spending.

Order is what a row **is** before what is **wrong with it** — `btc s`, not
`s btc`, and `c p` for a settled check the account has not caught up with. That
is the order somebody would say it out loud.

## Purple is the fourth banner colour

Blue says "here is a fact", yellow "this needs attention", red "this is wrong".
None of those is what a **proposal** is — something the application has worked
out and will not act on until somebody says so.

The one that exists today is a check the bank appears to have cashed. A sync used
to settle those by itself; now it proposes and waits ([ADR 030](decisions/030-a-cleared-check-is-confirmed-not-assumed.md)).
`#6B3FA0` on `#F4ECFB` is 6.41:1, which sits with danger rather than scraping the
4.5 floor, and the dot reuses the grouping purple so the hue is one the palette
already owns.

It appears twice, and deliberately. The banner names the checks; the check's own
row carries a **Confirm it cleared** button in the slot beside Remaining that the
absorb affordance uses. That button is **always visible**, unlike the absorb one
— it is a standing state rather than an offer, and a state nobody can see until
they hover the right row is one the banner would be pointing at in vain.

## Every notification is a pill

A sync that _succeeds_ while the feed complains about one institution raises a
notification. SimpleFIN reports an expired bank login per-institution without
failing the run, because everything else synced fine — so the text was recorded
on the run from the beginning but legible only on the Settings page. An account
could quietly stop updating while the whole interface looked healthy. The feed's
own words are used: it names the bank, and paraphrasing would lose that.

These were all full-width bars stacked above the page, and two of them at once —
a bank wanting a fresh login and a few transactions waiting to be categorized —
pushed the budget a third of the way down the screen to say six words between
them.

All eight are **pills in the page header** now: the same object as the budget's
own reading, sitting immediately to its right, in the tone the severity names.
Two or three words on the face, the whole message on hover or focus, and a press
goes to where the condition is dealt with.

Red is a pill too, which was tried the other way first ([ADR 039](decisions/039-a-bar-is-for-what-costs-data.md),
[ADR 040](decisions/040-every-notification-is-a-pill.md)). **How serious a thing
is and how much of the page it occupies are separate questions.** Severity is
already carried twice here — in the colour and in the words — which is the rule
every other state in this application follows, so that a reader who cannot
separate the two still gets the answer. A bar was saying it a third time in floor
space, on the screen whose whole purpose is the table it pushed down. And a band
across the top is the shape people learn to scroll past, which is a poor home for
the one state you most want re-read.

A pill is a link, so on a touchscreen the press arrives before any hover could —
which is the right trade: the page it lands on says in full what the tooltip
would have.

**The backlog pill opens the queue, not the register.** `?uncategorized=true` is
on the link rather than in the page's defaults, because the two ways of arriving
want different things: the sidebar means "the register" and the pill means "the
ones I have not dealt with". A default cannot be both.

**Nothing can be put away.** Bars carried an X, and it was a snooze rather than a
clear — away for a day, back afterwards if the condition still held — because a
notification dismissed for something that is still true is a lie the interface
tells on the owner's behalf. Snoozing went with the bar: it existed because a bar
was in the way, and a pill is not in the way. What makes one go away is fixing the
thing it is about.

## A display preference does not wait for the network

Collapsing a grouping used to send the change, refetch the whole budget, and only
then move anything on screen — a second or two of nothing happening after the
click. The read model itself takes about 2.5ms; the wait was entirely the round
trip plus a blanket `invalidateQueries()` refetching every query on the page.

The cache is updated first now and the request follows. A failure puts it back
and says so. Nothing is invalidated on success, deliberately: no figure on that
page can differ because a grouping is folded up.

The rule this is an instance of: **a change that moves rows can be optimistic; a
change that moves money cannot.** Editing a balance still waits, because the
identity, the section totals and the banner are all derived from it and showing a
guess at any of them would be showing a wrong number. Folding a grouping derives
nothing.

The risk that trade introduces is an optimistic update that never reaches the
server — perfect on screen until the page is reloaded. So the test reloads.

## Two things the rows stopped saying

**"(collapsed — 8 lines)" is gone.** It restated what the chevron already showed,
in more words than the grouping's own name, on a page where the eye is meant to
travel down a column of figures. The count was never actionable: nobody expands a
grouping _because_ it holds eight lines. The chevron carries the state, and
`aria-expanded` carries it for anyone not looking at the chevron — which is what
the end-to-end tests read now, rather than the prose.

**The `simplefin` tag is gone; `manual` became `m`.** Nearly every account comes
from the feed, so labelling those said nothing while spending a word of width on
every row. What is worth knowing at a glance is the opposite: which balances
somebody has to keep true by hand, because those are the ones that go stale
without anybody being told. One faint letter, with the full word still on
Settings → Accounts where there is room for it.

Both are the same edit really: a row of a financial table should carry the
figures and the name, and make everything else earn its place.

## A menu that stays on screen

The row menu always opened downwards, which is right everywhere except the rows
near the bottom of the window — and the last row of a long table is exactly where
somebody is when they want to rename the line they just added. It ran off the
bottom and its items could not be reached at all.

It measures now, in a layout effect so the decision happens before the browser
paints and the flip is never seen. Three rules, in order:

1. Open downwards. That is where a menu belongs, and flipping every one of them
   would be a different bug — the first row would open upwards over the header
   for no reason.
2. Flip up only when it does not fit below _and_ there is more room above.
   Flipping into somewhere equally cramped moves the problem rather than solving
   it.
3. If neither side is tall enough, scroll inside the menu. A long list of
   groupings on a short window has nowhere else to go.

Measured from the real element rather than estimated from the item count,
because the grouping panel is a different height and grows with the number of
groupings. Re-measured on resize and scroll, since the window can change under an
open menu.

## Row height: three settings, and a new default

**Compact (32px) is the default now**, with Comfortable (40px) and a new Dense
(28px) beside it.

Forty was the default on the reasoning that legibility comes first. That reason
does not survive looking at what the setting actually does: the type size has
never changed with it, only the space around the type. So the old default was not
buying legibility, it was buying air — and on a page whose whole job is a column
of figures read against each other, eight pixels a row is two fewer envelopes on
screen for nothing.

The three sit on one variable, so the whole interface changes at once and no
component knows the number. Anything unrecognised in storage falls back to the
default rather than being trusted: a value written by an older version must not
leave the interface with no row height at all.

It stays per-device. Which of the three reads best depends on the screen and the
eyes in front of it, and one person's large monitor should not decide the other
person's phone.

## The Budget page has two arrangements

**Stacked** — Assets, Debts, then Delegations, each the full width — is what this
page has always done and stays the default. It reads in the order the identity is
written, and on a phone it is the only thing that fits.

**Two columns** puts the **delegations on the left and the accounts on the
right**, Assets above Debts. The reason is what a wide monitor actually does with
the stacked layout: the balances scroll off the top before somebody reaches the
envelopes they came to work through, and half the width goes unused holding a
name column and one figure.

Below `lg` there is no room for two, so it collapses to one column and keeps
**its own** order — Delegations, Assets, Debts. That is not a fall back to
Stacked. It is the same idea at a smaller size: the envelopes are the reason the
page exists, and on a phone that argument is stronger, not weaker.

Three-to-two, not half and half. The columns are not doing equal work:
Delegations carries two money columns and a row menu, Assets and Debts carry one
money column each.

**Per device**, on Settings → Display, like row height and the theme — it
describes the screen in front of somebody. Two columns on a 27-inch monitor
should not put two columns on the other person's laptop, where it would squeeze
both and improve neither.

## A sixth destination

**Bills** joins Budget, Transactions, Utilities, Insights and Settings. It lists
what recurs, worked out from the register itself — see
[ADR 045](decisions/045-a-bill-is-inferred-not-entered.md) — and it is a
destination rather than a card on an existing page because the household looks at
it for a different reason than any of the others: not "what did we spend" but
"what is coming, and what has not arrived".

**The tab bar's columns come from the page list**, not from a number written
beside it. It said `grid-cols-5` while the list held five, so a sixth destination
would have appeared in the sidebar and silently off the end of the bar — the
exact drift the shared list exists to prevent. Six tabs on a 390px screen give
each 65px, so a label wider than that truncates: `Transacti…` under an icon that
already says which one it is. That is the cost of the sixth and it was taken
knowingly. A second, shorter name for one page would have been worse — two names
for one thing is what the UI audit spent its time deleting.

**The Bills table gives its width to the merchant name**, which is the only
column whose content has no upper bound. Everything else states a width and is
taken out of what is left. A "last seen" column was drawn and then removed on
exactly that ground: the cadence says how often, Next says when, and an overdue
row already carries how many days late it is, so a fourth way of saying the same
thing was being paid for out of the one column that needed the room.

**The column is `Cadence`, not `Every`.** The cell under it reads `Monthly`, and
"Every Monthly" is not a sentence.

**Nothing here says "fortnightly".** Settings → Budget offers "Every two weeks —
26 a year" for the pay cadence, and one vocabulary for one idea is the reason the
chip rules and the text budget exist at all.

**A bill carries a row menu, and it offers exactly two things.** _Give it a name_
and _Not a bill_ — a rename in red-free black, the correction in danger red. Every
other figure on the row is arithmetic over transactions and would be a lie if it
were editable; if the cadence is wrong, the answer is that this is not a bill, not
that the number should be overwritten.

**A renamed bill shows its name and nothing else.** The bank's description is
kept — a name is a label, not a claim about what the feed sent, and somebody
reconciling against a statement needs the original — but it lives in the row menu.
Drawn under the name in small grey it put a line of feed text on every renamed
row, which is the exact noise renaming was for. It is still searchable, so a bill
is findable by the only name a statement knows.

**Hidden bills live under a fold at the foot of the page**, with the count on the
summary. A list of corrections is not what anybody comes to the page for, but a
correction nobody can find is one nobody can undo — and the row it hid is
invisible by design.

**Status is a word before it is a colour.** `Overdue`, `Due now`, `Expected`,
`Stopped?` — §9 says never to convey state by colour alone, and the colour here
decides how fast a row is read rather than what it means.

**Typical and last sit beside each other**, and the last one is marked when it is
more than a tenth above. That comparison is the whole of how a price rise becomes
visible, and it costs one column.

## A target marks a figure rather than adding one

A delegation can carry a target — what it is saving towards, and by when. It
lands on the Budget row in two places and neither of them is a new column, which
is the whole design problem: the row already carries a name, two money columns
and a menu, and on a phone it shows one money column at a time.

**The chip says a target exists.** `tg`, quiet, beside the name — `t` is spent on
transfer, and two letters where one would collide is what the vocabulary already
does for `sp`. A chip is a classification, and "saving towards something" is one.

**Whether the line is on course marks the amount to delegate.** That figure turns
warning-coloured, and carries the sentence on hover and through
`aria-describedby`. It is the number that decides whether the target is reached,
so it is the number the judgement belongs on — a yellow letter beside the name
would say something is wrong without saying which figure to change. The To
delegate column is otherwise deliberately quiet (`#B4B1AB`); the warning wins
over that weight, because a figure that is wrong is not one to de-emphasise.

**The dialog spends most of its space on what a target does not do.** It never
moves the amount to delegate — see
[ADR 047](decisions/047-a-target-never-moves-an-amount.md) — so the reading is
shown rather than applied: what each remaining paycheck needs to carry, beside
what the line is actually set to, stated in both directions so neither figure has
to be remembered. Taking it is one switch, off unless somebody turns it on, and
one line underneath says so in words.

**A target's date is an anchor, and the dialog says which occurrence it means.**
"Repeats" sits beside the date and the hint under it names the next one — `Next:
Oct 31, 2026` — because a household entering "the last day of April" for a bill
that also falls in October needs to see that the reading moved on without them.

**The offered amount is a field, not a figure.** Turning on "Also set the amount
to delegate" reveals a money box holding what was calculated, and what gets
written is whatever is in it. The calculated number is the common answer, not the
only one: $274.38 a paycheck is more likely to be funded at $300, and closing the
dialog to type that on the row is a step in the wrong moment.

**It is set in one place.** The row menu opens the dialog; Settings → Delegations
shows the target and its verdict and does not offer a second, terser editor. Two
editors for one thing would mean the explanation exists in only one of them.

## Settings, and the width the shell was taking

**Eight sections.** There were twelve, and half of them held a single card, so
the tab row read as a list of words rather than a set of places. They are grouped
by the question somebody came to answer: **Sync** (what comes in and how it gets
out), **Accounts**, **Budget** (the tolerance and the cadence, the delegations,
the groupings they sit in), **Rules**, **Holdings** (Bitcoin, its node, property),
**Access** (the household's accounts, your own credentials, the onion service),
**Display**, **Archived**.

[ADR 021](decisions/021-bitcoin-and-property-are-managed-where-they-live.md) is
not reopened by Holdings. What it moved was the _creation_ of a holding out of the
Accounts list, because doing it there produced one that contributed nothing to the
identity. The cards, their create flows and their own histories are unchanged;
only the tab they share is.

**Every route that ever existed still resolves.** A section that moves is a
bookmark that breaks and a link in somebody's notes that breaks, so the old paths
redirect. `security` has been doing exactly that since two-factor moved to Users.

**Cards are three columns, and a card states what it needs.** Settings → Display
was three radio groups stacked down a 1,200px page, each using a fifth of its own
row. `span` defaults to the whole row, so nothing that has not thought about it
changed.

**Where the list sits is a per-device preference** — a row across the top, or a
rail down the side of the page. The rail is inside the page rather than in the
shell: it belongs to Settings and disappears with it, and putting it in the shell
would mean a second permanent column on every other screen.

**The sidebar is as wide as its longest label.** §4 specified 232px, which is
about sixty more than "Transactions" takes; the rest was margin the page beside it
could have used. It is intrinsic now — `w-fit`, with the labels holding their line
and anything of uncontrolled length capped and truncated, because an email address
is wider than anything anybody navigates to.

## Assets, Debts and their headings are ordered too

Delegations have had a position since v0.24. The argument was that the owner's
groupings are named "3 - Food" and "5 - Home" because ordering was the thing
missing, and numbering them was the workaround — and that argument is no
different one level up or one level across. The order a household reads its own
accounts in is a fact about the household; alphabetical is nobody's reading.

**A row is dragged onto the row it should sit above.** The same gesture and the
same request shape delegations use: the whole resulting order, not a direction —
a "move up" that races another tab's "move down" lands somewhere neither person
asked for, and a list cannot.

**A heading is dragged onto the heading it should sit above.** Rows and headings
are dropped on the same table and mean different things there, so the payload
says which it is; a heading dropped on a row does nothing, because filing a
heading under a line is not a request anybody can honour.

**The application's own groupings do not move.** Outstanding checks sort last by
rule rather than by where anybody put them — that heading is where the budget
keeps money that has left in paper form, not something anybody filed under.

**Dragging is never the only route.** The account row menu carries Move up and
Move down, and Settings → Budget carries a pair of arrows on every grouping. Drag
and drop is the fast way and it is not an accessible one; these are the ones that
always work.

**A drop lands on the edge the pointer is nearest.** Dropping onto a row used to
insert before it, always — so there was no gesture that meant "after this one",
and the last place in every list and every grouping could not be reached by
dragging at all. The pointer's half of the row decides, and the accent line is
drawn on the edge it will land on rather than always on top.

**A heading dragged over another grouping's rows means "past that grouping".**
The last heading's own row is one row tall and sits above everything it holds, so
reaching the bottom of a long section meant hitting a strip of pixels. What is
being dragged is remembered in state rather than read from the event —
`dataTransfer` is empty during `dragover` in every browser, and this is a
decision that has to be made while the pointer is moving.

**Nothing moves until somebody moves it.** Every row starts at position zero and
a tie falls through to the name, so a budget nobody has rearranged still reads
alphabetically.

**The sidebar's toggle is a drawn icon**, on the same 20-unit grid and stroke as
the destinations below it. It was `«` and `»`, which is the mistake §4's icon set
was fixed for: a Unicode glyph renders at whatever weight and baseline each
platform decides. Collapsed, it joins the icon column — same size, same centre —
with a rule under it, because it acts on the sidebar itself rather than going
anywhere.

## Six palettes, and a number under each one

`design.md` §2 fixes the Light palette and ADR 034 added Dark as a second design
rather than an inversion. Three more join them, and the rule that makes that a
system rather than a pile is in
[ADR 048](decisions/048-a-theme-is-a-palette-that-is-measured.md): **a theme is a
token swap** — colours, the font stack, the label tracking — and nothing about
layout is themeable.

**Ledger** is monospace, everywhere. A page half in monospace reads as a mistake
rather than a decision, and this application is a ledger: with the face swapped
the whole grid lines up — names, dates and amounts — instead of only the money
column. The rest gets quieter to pay for it. Warm paper, a burnt amber accent
where blue would compete, ink-adjacent grouping presets because a saturated tint
on paper reads as a highlighter, and `--tracking-label` at zero because a
monospace capital is wide enough already. It costs about 15% width, so long
merchant names truncate sooner here than anywhere else.

**Reading light** is the one with a use rather than a look: a parchment ground at
reduced luminance with the blue taken out, for ten at night in a lit room. Its
semantics are re-chosen against that ground — terracotta, moss — because a cool
accent on a warm dim ground reads as a screen with the brightness turned down.

**High contrast** is a setting, not a style. Pure black on pure white, every
value at the far end, and `--color-line` at 5:1 so a hairline reads as a boundary
rather than a suggestion.

**§9 is now checked rather than asserted.** A test reads the stylesheet and
measures every palette. It found six pairs in the shipped Light palette under
4.5:1 — the worst being positive green on its own green fill at 2.76:1 — and
those are recorded at today's values rather than changed, because this document
is settled and moving them is the owner's decision. They cannot get worse.
