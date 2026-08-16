# Visual design

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

### Balance banner

A full-width 8px-radius bar with a status dot and one line stating the identity.

Thresholds derive from the **configured tolerance** — set in Settings, default
$5.00 — rather than being fixed. `T` below is that value.

| Condition  | State       | Look                                      | Label                    |
| ---------- | ----------- | ----------------------------------------- | ------------------------ |
| ≥ +T       | To delegate | Accent blue on accent-soft; dot `#2783DE` | `$4,890.00 to delegate`  |
| Within ±T  | Balanced    | Green                                     | `Balanced`               |
| −T to −2T  | Warning     | Yellow; shows the shortfall               | `$7.40 over-delegated`   |
| Beyond −2T | Danger      | Red; shows the shortfall                  | `$212.00 over-delegated` |

**A positive reading is not a warning.** It is the ordinary state on payday:
money has landed and has not been distributed yet, and that figure _is_ the
amount available to delegate. Colouring the most common healthy state yellow
would teach the owner to ignore the one banner that has to be read. Yellow and
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
- **Insights** — card grid, two columns on desktop. Cards have a title, an `×`
  remove affordance, and a dashed "+ Add from catalog" tile. Charts use the
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

Below 640px there is not room for a name and two money columns, so the
Delegations table shows **one amount at a time** — Remaining first, because that
is the number the budget is read for. Swiping horizontally across the table
switches to To delegate and back.

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
menu on the Transactions page, not as buttons in the row. Categorizing is the
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

**New outstanding check** sits beside Transfer and Delegate on the Budget page.
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
columns. **Bitcoin over time** is one of those series: the holding valued at each
day's price. Quantity history is not recorded, so the tile says plainly that the
line moves with the price rather than with buying or selling. Some tiles offer one shape and show no switch at all: a donut of a
single number says nothing, and an option that made a tile worse would not be a
choice worth offering.

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

## Utilities

Each card's sparkline takes its grouping's colour, the same one as the dot beside
the name. A purple dot above a blue chart read as two unrelated things on one
card.

Both headline figures name their unit, and both are per cycle — the suggestion
and what is actually funded, which is the comparison. The monthly average sits in
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

The identity banner reads as a statement and its working: the figure on the left,
the equation right-aligned against it, no bullet between them.

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
| Suggested per cycle             | that average spread over 26 paychecks |
| Delegated per cycle             | what the line is actually set to      |
| Delegated above/below suggested | the comparison the page exists for    |

This was two hero numbers and two sentences underneath, which said the same four
things at three different weights and left the reader to work out which two were
the comparison. Colour still marks a shortfall, but the label says it too.

**Delegated, never funded.** Delegate has one verb for putting money in an
envelope. A second word for it in one corner of the application is a second
concept as far as the reader is concerned.

## Banners can be put away, not cleared

A sync that _succeeds_ while the feed complains about one institution now raises
a banner. SimpleFIN reports an expired bank login per-institution without failing
the run, because everything else synced fine — so the text was recorded on the
run from the beginning but legible only on the Settings page. An account could
quietly stop updating while the whole interface looked healthy. The feed's own
words are used: it names the bank, and paraphrasing would lose that.

Every banner now carries an X, and the X is a **snooze rather than a clear**. It
puts the banner away for a day, keyed on the message so a second bank failing is
news again, and brings it back afterwards if the condition still holds. A banner
dismissed for a condition that is still true would be a lie the interface tells
on the owner's behalf. What makes one go away for good is fixing it.
