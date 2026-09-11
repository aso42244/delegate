# The UI system

The measurements. `docs/design.md` says what this application looks like and why;
this says what every screen must actually use, in numbers a review can check.

It exists because the look was right and the execution drifted. An audit of all
seventeen screens on 2026-08-25 found four page-header implementations, five
container widths for the same kind of form, `gap-` and `mb-` at every value from
1 to 8, three verbs for creating a thing — including **"Add grouping"** on the
Budget page and **"New grouping"** in Settings for the same action — and four
different ways of saying a list is empty. No single screen was wrong. Together
they did not look like one application.

Everything here is normative. `ui-system.test.ts` enforces the mechanical half by
reading the source, because a rule nobody can check is a rule that lasts until
the next hurried change.

---

## 1. The scale

**Five spacing values. Nothing else.**

| Step | Tailwind | Used for                                                     |
| ---- | -------- | ------------------------------------------------------------ |
| 4px  | `1`      | Label to control, control to hint, title to description      |
| 8px  | `2`      | Controls in a cluster, buttons in a row, chip to chip        |
| 12px | `3`      | Blocks inside a tile, rows inside a dense list               |
| 16px | `4`      | Blocks inside a card, tile padding, header to body           |
| 24px | `6`      | **Tile to tile**, page header to content, section to section |

**Tile to tile is 24px, not 12.** This table said 12 from v0.59 while both grids
had been drawn at `gap-6` the whole time — the document was wrong and the code
was consistent, which is the better way round to find it. Corrected in v0.71 with
ADR 061, when the two grids became one.

**Twelve was added in v0.59**, with the Overview redesign, and the reason is
worth keeping so it does not become a precedent for a sixth. Four values held
while every screen was a table or a form. A dashboard of small cards has a real
gap between _inside a card_ and _between blocks_, and forcing it to 8 or 16 made
tiles either cramped or airy with nothing between. Thirty-two was proposed
alongside it and left out: 24 already separates sections, and a scale with two
values for the same job is a scale nobody can apply confidently.

`gap-5`, `mb-8`, `mt-7`, `space-y-9` and every other off-scale value are banned
and tested for. Two exceptions, both allowed by
name in the test: grid gutters may use `gap-4`, and the sidebar keeps its own
metrics from `design.md` §4.

A gap you cannot express in that scale is a sign the grouping is wrong, not that
the scale is short.

## 2. Widths

A field's width states what belongs in it. It is never inherited from whatever
container the field happens to sit in — which is how one text input ended up
384px wide on Settings → Users, 576px on Sync and 918px on Two-factor.

| Class          | Width | For                                                       |
| -------------- | ----- | --------------------------------------------------------- |
| `field-sm`     | 128px | Money, dates, counts, anything under ten characters       |
| `field-md`     | 256px | Names, single words, a delegation, a person               |
| `field-lg`     | 384px | Tokens, addresses, descriptions, anything pasted          |
| _(full width)_ | —     | **Only** inside a dialog, where the dialog sets the width |

Defined in `styles.css` beside the other tokens. Pick by what goes in, not by
what fits.

### Money fields

A figure is not open-ended content, so a money field is **`sm`** — everywhere,
including inside a dialog where `full` is otherwise the rule. `full` exists for
things whose length nobody controls: a name, a description, a pasted token. Eight
characters of number is not one of those, and a box the width of a sentence to
hold `$575.00` reads as a mistake.

A bare inline editor over a column of figures uses `.money-input`: `11ch`, which
is `$999,999.99` with tabular numerals, and `ml-auto` so it opens exactly where
the figure it replaces was sitting.

**Fixed, never growing with its content.** A box that resizes on every keystroke
moves the caret and the rows beside it while somebody is typing. That is the
convention for a column of editable figures and the reason for it.

### The tile grid

**One grid, twelve columns, `gap-6`, four names** — `third`, `half`,
`two-thirds`, `full`. `TileGrid` draws it and `Tile` takes a `span`.

**Twelve columns everywhere.** Settings counted in sixths and Overview in
twelfths until ADR 061, so `span="half"` emitted `lg:col-span-3` on one page and
`lg:col-span-6` on the other — one word, two meanings, and nothing at a call site
to tell them apart. Twelve divides by 2, 3 and 4 with nothing left over, which is
every fraction either page ever wanted.

**`TileColumn` is a grid cell holding tiles stacked down it**, for tiles that
belong together — the Cost half of Recurring. A column, not two tiles each
declaring a third: two spans only look like a column by coincidence, and
inserting anything between them produces an arrangement nobody asked for.

### Overview's rows

**On Overview a tile does not declare a width.** Tiles form rows, a row divides
its width evenly among its members, and the span falls out of that: one tile is
full, two are halves, three thirds.

That is the one place the `span` vocabulary is wrong on its own — it cannot
express _these three share a row_, and a dashboard is rearranged by dragging. So
Overview stores the relationship and derives the span, and the two can never
disagree.

**Four to a row at most.** A quarter of a 1200px page is 300px, and a ranked bar
with a name and a figure stops being readable below about that. The arithmetic
says the same thing — a fifth would not divide.

**A phone ignores rows entirely** and stacks every tile full width in row order.
That is what lets one stored arrangement serve both screens: rearranging on a
phone rearranges the laptop too, because the thing being stored is the order and
the grouping rather than a width that only means something on one of them.

### Bars

**One construction, everywhere.** A grey track, 8px tall with a 4px radius, and
a **3px coloured bar inset 2px inside it**. The pace bar in the budget panel is
where it started and it is the most-read list in the application; the ranked bars
on Overview are the same thing without the tick and without the overspend zone,
because those answer a question only the pace bar is asking.

The fill used to be the full height of the track, so a bar and its remainder were
two blocks meeting at a hard edge and the eye read the _boundary_ rather than the
length. Inset, a track stays a track.

### Ranked bars

**Name, bar, figure — on one line**, at the same 28px row the budget panel uses.
It was a name and a figure with the bar on a second line beneath them: two rows
of chrome per reading, about 44px a line, and a tile that showed five readings
where it now shows nine.

A **grid**, not flex: the bars start at the same x down the column, which is what
makes them comparable at a glance, and that is a column definition rather than
whatever each name happens to be wide.

No tick and no overspend zone — those belong to the pace bar, which is answering
a different question. These bars are scaled to the **largest row**, so the bar
compares a line with the others and a percentage places it against the total.

**A percentage is a column of its own**, fixed width and right-aligned, and it is
reserved only on the tiles that have one. Beside the amount it moved with
whatever that amount happened to be wide, so a column of shares came out ragged —
35% sat somewhere different from 3%.

**A row's own list is what scrolls**, never the tile's body. A body that scrolls
takes the whole tile with it, so a row dragged short clips a chart halfway
instead of shortening the list beside it. Charts scale to the room; lists scroll
in place.

### Overview's rows

**Three tiles to a row at `lg`, two at `md`, one below it.** The cap is
arithmetic: a ranked bar with a name and a figure stops being readable at about
300px, the page caps at 1600px and the budget panel takes 398 of it.

**A row's height is dragged from the bottom edge of any tile in it**, between
120px and 1600px, and the arrows move it 24px at a time because dragging is not
reachable from a keyboard. It is stored on every tile in the row — a row is a
number they share rather than a record of its own — and read back as the largest
of them. **A tile moved to another row leaves the height behind:** heights belong
to rows.

Null is the tile's own height, which is what every row is until somebody drags
one.

### Creating a thing

**`New …` in every page header, and nowhere else**
([ADR 057](decisions/057-one-way-to-make-a-thing.md)). Six items: transaction,
transfer, check, delegation, grouping, rule. `PageHeader` renders it, so no page
has to remember to, and it is the **leftmost** action so it holds the same
position whatever else a page puts beside it.

A page keeps anything that is not creating a thing — Delegate, Arrange, Run
rules, and every row-level action. Those belong to the page they act on.

`ui-system.test.ts` fails the gate on a `New <noun>` button outside the menu.

### The pace bar

The one construction wherever a budget line appears
([ADR 053](decisions/053-a-pace-bar-reads-two-marks-not-one.md)). Track 8px,
`--color-surface-2`, radius 4. Fill 3px, inset 2px from the left, the grouping's
colour. Tick 1.5px × 6px in `--color-axis`.

**The track splits at a fixed 80%**
([ADR 054](decisions/054-the-pace-bar-measures-what-the-cycle-had.md)). The
first 80% is **what this line had to spend this cycle** — the delegation plus
whatever surplus or deficit carried in, which is `spent + balance` and so needs
no assumption about whether the press has run. The last 20% is overspending past
that, drawn only when a line is actually there, and full at a quarter over.

**The split does not move.** It is 80% on every row whatever the line holds,
because the tick is a _time_ marker and has to read as one straight vertical
down the column. The tick therefore only ever travels 0 → 80%.

**Only the part past the split is red.** The fill keeps the grouping's colour
the whole way along the cycle zone, so a line that spent more than its
delegation but is still solvent stays its own colour — in an envelope budget
that condition is ordinary and often correct. Red says one thing: this much was
spent beyond what the line had.

**The hover text is figures, never a verdict.** Spent of available, and what
carried in — "On pace" and "Out of money" were both proposed and refused.

**What the cycle had is `spent + balance`, always.** Derived rather than
assembled from delegation-plus-carry-in, which means it holds whether or not the
press has run yet _and_ that money transferred between lines is already in it —
there is no transfer term to add and nothing to keep in step.

**No payday anchor means no tick.** A marker drawn from a guessed schedule is
confidently in the wrong place, and every reading beside it is judged against it.

### Overview's band

**The budget is the page's first block**, full width, above the tiles
([ADR 062](decisions/062-the-budget-is-the-first-block-of-overview.md)). It was
docked right at 398px and it was a reading; it is the Budget page's own table
now, and the width is what made that possible: two money columns and a
recognisable name do not fit in 398px, which is what v0.60.0 measured when three
of them were cut to one.

**It is pinned and it is not a tile.** It cannot be dragged, removed or dropped
onto, and nothing can be placed above it or beside it.

**One table, two surfaces.** `DelegationsTable` is the delegations table and
everything that can be done to a line in it, and the Budget page and the band
both render it. They differ in two props and nothing else: a pace bar, and a
narrowing to the chosen lines. A second component would be two renderings of one
budget, which is the drift this whole system exists to stop.

**Two tabs**: Delegations, and Accounts & Debts with **Accounts first** and a
`With balance / All` switch. The tab's own control — the scope on one, the
balance filter on the other — sits at the **right-hand end of the bar**, one
position whichever tab is showing.

**Read on the left, act on the right.** The header's left-hand track carries the
cycle stamp — the date range, the day, the percentage through — and its right
carries both controls in one order: which tab, then how much of it, so **Show
selected / Show all** is the last thing on the line at every width. The stamp sat
between the two controls until v0.73.0, which put a reading inside a row of
things to press and left neither control able to hold a position.

The stamp goes in through `Tile`'s `lead`, which is the header's left track for a
tile whose name is carried by being the page's first block rather than by a
heading. Never `lead` and `title` together: they are the same track.

**The controls stack below `@xl`**, tabs on top, both hard right. A container
query, not a breakpoint (§2): it is this tile's width that decides. The two come
to about 330px, which on a phone leaves the stamp nothing — so it wraps under
them on the left rather than squeezing them, and the second control stays where
the eye already is for it.

**The link under the table is `Select Delegations`**, which names the act.
"Choose which delegations show" described the dialog's contents and was long
enough on a phone to wrap under the table it belongs to. The dialog it opens says
the same words.

**Show selected is a flat list.** Eight watched lines cut into six headed
sections spends more width on headings than on figures. Each row keeps its
grouping's colour through `tintFor`, because the tint is how a line is found in a
column.

**The pace column is a fixed width**, never a share: the tick is a time marker
and has to read as one straight vertical down the page (ADR 054). It is not drawn
below the breakpoint, where the row is already choosing between its two money
columns.

**A phone gets the band and nothing else.** The tiles are hidden below `sm` —
still arranged, still stored, still there on a laptop.

**And no Arrange button.** Every tile is full width below `sm` and the band above
them is pinned, so the only thing left to arrange there is the order of one
column, for which the page was charging a button in the header with the least
room for one. `arranging` is read from the URL _and_ from the width, so a window
dragged narrow while Arrange is open cannot strand somebody in a mode whose
"Done" has gone.

**Overview's window picker is `sm` below the breakpoint**, which is the one
exception to §5's "one size". At `md` its four options are 212px, and beside
New… and Delegate that is 378px on a 343px line — so the header wrapped to three
rows on the screen whose whole point is the band underneath it. The three sit on
one line at `sm`. A control that has to be scrolled sideways to find YTD is worse
than a smaller one.

**One region.** `region` was `main` or `sidebar`, and `sidebar` was the single
column under the docked panel. There is no right-hand column now. The column
stays in the database and is still read, so an arrangement made before this
opens with every tile it had; the next save writes them all back as `main`.

**Everything on Overview is cycle-shaped except the outflow band**, which draws
the calendar month. That is the deliberate exception rather than a drift: the
rest answer "how am I doing against this cycle's plan" and need the cycle, while
a band of days answers "what did each day cost" — and days belong to months. It
names its month, so there is nothing to remember, and it is the one such tile
that needs no payday anchor.

**A row holds three tiles**, not four. A ranked bar with a name and a figure
stops being readable at about 300px, and a quarter of a 1600px page is 295.

**Band rows are one step tighter than table rows** — 32 / 28 / 24 against
Settings → Display's 40 / 32 / 28. One setting still governs both.

**Dragging works on the page itself**, not only inside Arrange — pointer devices
only, since HTML5 drag fires no events under a thumb and a phone has no rows to
rearrange. A grip appears on hover to say so: `design.md` is explicit that a card
which moves when dragged, with nothing to suggest it would, is a surprise rather
than a feature.

**And it is never the only route.** Inside Arrange a tile carries ⤒ to join the
row above, ⤓ to take a row of its own, and ◂ ▸ to move along the reading order —
the routes that work from a keyboard. ◂ ▸ reorder within a row and step **out**
onto a new row at its edge, never merging: merging is what ⤒ is for, and a
reorder button that silently changed two tiles' widths would be doing something
nobody pressed it for.

### A tile's figure

A figure tile — one number and the sentence that says what to do about it —
takes **`text-figure`**, which is 24px: the same size as a page title, and
deliberately not larger.

The scale had no size for this because the context did not exist until Overview
did. Everything above `text-hero` was a heading, and a dashboard tile's single
number is not a heading — it is the content. It gets the top of the scale rather
than a new size above it, because a dashboard where every tile shouts louder
than the page it sits on has spent the last of its hierarchy.

It is a separate token from `--text-page` rather than a reuse, because
`ui-system.test.ts` holds `text-page` to `PageHeader` alone and that rule is
worth keeping: one component decides how far below the title a page starts. Two
names for one value, each saying where it belongs.

## 3. The text budget

The rule the owner asked for, made countable. **Fewer words wherever a word is
not carrying its weight.**

- **A page** gets a title and **at most one** line of subtitle. The subtitle
  states the current fact — `469 transactions.` — never instructions.
- **A card** gets a title and **at most one** line of description, 80 characters
  or fewer. If it will not fit in 80, the card is doing two things.
- **A field** gets a label and **at most one** short hint, and only when the
  label genuinely cannot carry the meaning. Most hints are a label written twice.
- **An empty state** is **one short sentence and no instructions.** `No rules
yet.` — not `No rules yet. The fastest way to build them is "always categorize
like this" from a transaction.` Where to go next belongs on the control that
  goes there.
- **No trailing explanatory paragraph.** Settings → Budget carried three lines
  restating the three hints above it. Anything that genuinely needs more room is
  a disclosure (§7) or is deleted.

Copy states the fact, then stops. No "please", no "simply", no reassurance, and
never an apology.

## 4. The page header

One component, `PageHeader`. Every page, no exceptions.

```
title  [chip]                                    [actions]
one line of subtitle
```

- `h1` at `text-page font-bold text-ink`
- An optional chip or reading sits **beside** the title, baseline-aligned
- Actions sit right, baseline-aligned with the title, `gap-2`
- Subtitle 4px under the title, `text-quiet text-muted`
- **24px** between the header and the content below it, always

## 5. Buttons

**One size.** `min-h-[28px]`, `px-3`, `text-quiet font-semibold`, 8px radius.

**Everything on a control row is 28px** — a button, a text field, a select, a
segmented control. They were 36, 40 and 36, so a search box beside two filter
buttons sat 12px taller than both and the row had no baseline. The height is
written down twice and only twice: `min-h-[28px]` on the button, and `.field` in
`styles.css` for anything you type into. A `textarea` is sized by its rows and an
inline editor inside a table row by Settings → Display; neither is on a control
row.

**A control that sits beside an inline editor takes the editor's metrics, not the
button's** — `px-2 py-0.5 text-quiet`, the resting state of the field it stands
next to. The register's suggestion button is the one of these: a 28px button in a
row whose height is a display preference would set that height itself, and two
controls in one cell at two heights have no baseline between them.

A field keeps its **16px font**. Below that, iOS zooms the page when the field
takes focus, which is a worse thing to do to somebody on a phone than four pixels
of padding.
There is no small or large button.

**One primary per screen**, and it is the thing you came to that screen to do.
Everything else is `default`. A screen with two primaries has not decided what it
is for.

**The shell has no primary.** Delegate was it, from when it was the Budget page's
own button and the only loud thing on that screen. In the sidebar's control zone
it is one of two buttons 8px apart (§12), and the blue one was the one that moves
a pay packet while the plain one below it is the one pressed daily — an
invitation to reach for the wrong control, which is the hazard the confirmation
dialog already exists to catch. Both are `default` now. What is coloured in that
zone is a button reporting a **state**, and Delegate has none.

`warning` and `danger` on a control that still works mean it is reporting
something, and **Sync SimpleFIN is the only one**. It takes the colour of the
loudest condition the bank feed currently has, and the whole list of them opens
on hover and on focus — see §9.

`danger` otherwise appears only inside a dialog or a row menu, never sitting on a
page — with one exception, Undo Delegation, which replaces Delegate in that slot
while a run can still be taken back.

`ghost` is for a control that must recede: a disclosure toggle, a tertiary
escape.

**Creating a thing is always `New <noun>`.** Singular, no article. New
transaction, New grouping, New rule, New account, New check, New holding, New
property, New person. Not Add, not Create, not Set up. The audit found all four
in use, twice for the same action.

Buttons in a row: `gap-2`, primary last, destructive never adjacent to the
confirm.

## 6. The tile

**One box, and `components/Tile.tsx` is the only place it is written.** A card,
a tile and a bordered panel are the same object; there were three of them, at two
paddings and two heading sizes, with the description beside the title on one
page and under it on another. `ui-system.test.ts` fails the gate on a second
surface — see [ADR 061](decisions/061-every-page-is-a-page-of-tiles.md).

`rounded-lg border border-line bg-canvas p-4`, `@container`, `h-full`.

- Title `text-section font-semibold text-ink` — 16px, a section title, which is
  what a tile's heading is
- Description optional, one line, `text-quiet text-muted`, **4px under the
  title** — the same shape `PageHeader` uses, because a header is a header
- Actions right, baseline-aligned with the title, wrapping before the tile gives
- 16px from the header to the body
- **24px between tiles**

**A tile's title is optional.** Where the content carries its own heading in the
column it totals — the Budget page's tables — the tile is a surface and nothing
more. A tile heading repeating what the table says is the drift this system
exists to delete.

**The footer belongs to the shell.** A rule and a line of small print at the
foot, outside the body, because the body is what scrolls: four tiles on Overview
drew their own footer as the last child of a scrolling list, so "All bills →"
scrolled away on a tile with eleven bills in it.

**A tile never carries a create-form.** Adding is a header button and a dialog,
which was already the rule and which Settings → Bitcoin and Settings → Properties
both broke by parking a permanently-open form where the list should be. A form
below a list pushes the list off the screen to make room for something that is
used once.

**A tile's group is named — `group/tile`, never a bare `group`.** A bare one is
the same group the table rows inside it use: `.group:hover .row-menu-trigger`
reveals a row's `⋯` and its absorb button, and it matches any hovered ancestor
carrying the class. With the tile in that group, hovering anywhere over the
budget drew "Move surplus here" on every line at once. Anything hover-revealed
inside a tile names the group it belongs to.

**Content inside a tile asks how wide the _tile_ is.** `@sm:`/`@md:`/`@lg:`,
never `sm:`/`md:`/`lg:`. A window query stopped being the same question the
moment a tile stopped being the whole row — a third-width tile on a 1440px
screen is 345px across and was being handed the layout meant for 640, which is
how the backups table drew its columns past its own border in v0.49. The gate
checks column widths and table layout, which is where it bites.

## 7. The four recurring pieces

Each of these had between three and five implementations. Each is now one
component.

**Status line** — `StatusLine`. An 8px dot and one short sentence, coloured by
tone. Used wherever a screen reports what something currently is: connected,
backed up, enrolled, reachable.

**Empty state** — `EmptyState`. One sentence, `text-quiet text-muted`, in the
body where the content would be. No illustration, no instructions, no button
inside it — the button is already in the card header.

**Segmented control** — `SegmentedControl`. A single control for picking one of a
few options: the Insights window, a tile's view. Not a row of Buttons with one
turned primary, which is what Insights was doing directly above a real segmented
control doing the same job.

**Row menu** — `RowMenuShell`. It wires a long press on the row itself, so on a
touchscreen the `⋯` is a second way into a menu already reachable — and it cost a
40px column on a 390px screen, on every table that has one. The trigger is
**visually hidden on `(hover: none)` and its cell collapsed**, but it keeps its
place in the accessibility tree: a long press is not a gesture VoiceOver can
perform, and `display: none` would strand the menu for anyone using it.

Only the shell's own trigger. Settings → Groupings and Settings → Rules paint the
same class on an Archive button and a pair of reorder arrows with no long press
behind them; hiding those would leave them unreachable by any means, which is the
state that rule was written to fix once already.

**Disclosure** — `Disclosure`. A `ghost` button carrying `aria-expanded`, and the
content below it. Not `<details>`, which Settings → Tor used and which draws its
own triangle in its own font at its own size.

## 8. Tables

Unchanged from `design.md`, restated because it is part of the system:
`.row-cell` for height so Settings → Display governs it, a 2px `border-ink` rule
above the header row, hairline dividers between rows, no rule underneath the
last one. Column headers `text-label uppercase tracking-[0.05em] text-muted`.
Money right-aligned in `.money`.

A table's own top rule is the separator. It never also gets a margin above it.

## 9. Tags

**`Tag` is the only small mark.** Chips, state tags and alerts are all it:
`rounded-full`, a soft fill and the same hue for the text, **no border**, and one
of two sizes — `sm` (11px, `px-[6px]`, 18px line) inside a data row, `md` (13px,
`px-2`, 20px line) standing on its own. Tones: `quiet`, `info`, `positive`,
`confirm`, `warning`, `danger`, `negative`.

There were four of these and they had drifted into four objects: 4px letter
chips, 10px fully-rounded bill states, 4px Asset/Debt tags, and 8px alert pills
with a 1px border nothing else had. Three radii, three sizes, two colour
recipes. The border was the one that mattered — it was the single thing making
the alerts read as a different species — and colour carries them now, as it does
everywhere else.

`AlertTag` adds the one thing particular to an alert: the whole sentence, one
hover or one focus away. It is a `Tag` face and nothing more.

**Every notification is one of these, at every severity.** There is no bar and
nothing renders above the page. A tag's tone and its words carry how serious it
is — the same way every other state in this system carries it — and floor space
is not asked to say it a third time.

**They live at the foot of the sidebar**, above the sync button and its
separator, ordered so the most urgent is lowest and the budget's own reading is
always last.

**Except the bank feed's own, which are folded into Sync SimpleFIN**
([ADR 063](decisions/063-the-feed-reports-in-its-own-button.md)).
`SYNC_KINDS` in `components/notifications.ts` is the list: a failing run, a sync
warning, a stale balance, an account the feed has stopped reporting, an account a
sync discovered and guessed at. Five yellow tags stacked directly above a yellow
button, every one answered by looking at the same connection, is one sentence
said five times — and it crowded out the alerts the feed has nothing to do with.
The button takes the loudest one's colour; the list opens on hover **and on
focus**, most significant first, each row a link to where its condition is dealt
with. The panel takes the pointer so those links can be reached, which is why it
hangs from a padded wrapper rather than a margin: a gap between button and card
drops `:hover` on the way into it.

**What is not folded**: a categorization backlog, a cheque to confirm, a row to
clear, an overdue bill, a line behind its target, a stale Bitcoin price, a
failing backup, a stalled snapshot — none of those is anything the bridge did,
and burying them inside a button about the bank would be hiding them. Nor is the
budget's own reading, which is the thing the household opens the application for.

**Below `sm` there is no sidebar, and no Sync button to fold into**, so the phone
keeps every notification — and shows them as **one coloured dot** beside the page
title, carrying the loudest tone, opening the whole list in a `Modal` on a press.
Three tags wrapped that header onto three lines and pushed the band off the
screen, and a tag's detail is a tooltip, which a touchscreen has no way to open.
The count is in the dot's accessible name and the list behind it is words, so
colour is still not the only carrier. The budget's reading stays a tag there: it
is one pill, and it is the one being read.

**Two or three words, and a count is the most detail one carries.** `Sync issue`,
`4 new transactions`, `1 check to confirm`. Which bank, which accounts, how old —
that is the tooltip, one hover or one focus away, and it is where the whole
sentence goes.

**The detail is `w-96`, it wraps, and it stays on the screen.** Tall rather than
wide, deliberately: a detail is read once and dismissed by moving the mouse, so
wrapping costs nothing while running past the edge costs whatever was cut off.
`w-96` is the prose width from §2 rather than a number invented here.

It was `w-max` with a viewport-width cap until v0.55.1, and that cap could never
have worked — it bounds the detail's _width_ while `left-0` puts its left edge
wherever the pill happens to sit, and the two were never compared against each
other. The `6 not reporting` message ran about 1,500px on one line, off the right
of a wide display, with the end of the sentence unreachable by any means.

Its position **clamps rather than flips**. Hanging it from the pill's other edge
was tried first and is the same defect mirrored: on a phone the pill is narrower
than the detail, so right-anchoring puts the left edge off the left. And it is
measured from the **pill**, never from the detail — the detail is `display: none`
until revealed and a hidden element has no box, while the pill is always on
screen and the detail's width is a constant.

Order: the page's own reading first, then whatever the application is reporting,
in the severity order the server sends.

A pill that leads somewhere is a `Link` and takes its own defaults with it — the
backlog opens `/transactions?uncategorized=true`, which is not what the sidebar's
link does. A pill that only reports takes focus and does not act.

## 10. Dialogs

One component, `Modal`, in two frames: a centred card on a pointer, a sheet
rising from the bottom edge on a phone. Escape closes it and Cancel closes it;
the backdrop does not, because these hold typed money.

**`role="dialog"` outside `ui.tsx` fails the gate**, since ADR 061. This was
already the rule and nothing was checking it, so two hand-rolled overlays
survived on the Budget page from before ADR 038 — centred cards on a phone, no
`visualViewport` measurement, and Escape did nothing. One of them is Transfer,
which is a dialog somebody opens to type an amount, and on iOS its amount field
and its confirm button sat underneath the software keyboard.

A third was written in v0.70, for the Delegate and Undo confirmations, on the
reasoning that neither holds a typed figure. That is true and it is an argument
for **`dismissible`** — the switch that lets the backdrop close a reading — not
for a second frame. "It holds nothing typed" answers one of the four things
`Modal` guarantees and leaves the viewport measurement, the sheet and Escape
unanswered. It matters most there of anywhere: that control sits in the page
header on a phone, and the confirmation a phone reaches most easily is the
destructive one.

**A dialog is measured against the visual viewport, never the window.** They are
not the same thing on a phone: a software keyboard is drawn _over_ the page
rather than beside it, so the window stays 844px tall while 430px of it is on
screen. A `fixed` overlay pinned to the window is therefore pinned underneath the
keys. `Modal` reads `window.visualViewport` and takes its top and height from
there, so the sheet always ends where the keyboard begins.

**A dialog is a column: header, scrolling body, pinned footer.** The header and
the footer keep their places and the body takes whatever height is left.

Put in the `footer` anything that has to be reachable from wherever the body has
been scrolled to:

- the buttons that commit or cancel,
- the verdict that decides whether it can commit — Split's remainder,
- the errors raised by pressing the button, since an error you cannot see from
  where you pressed is not raised at all.

**Nothing inside a dialog scrolls itself.** One scroll container, and it is the
body. Two nested touch scrollers fight over the same drag, and an inner one sized
in `vh` is sized against the window the keyboard just made a lie of.

Most dialogs are a field or two, never scroll, and need no footer at all; their
buttons are simply their last children.

## 11. Settings

**Eight sections, and the row is a set of places rather than a list of words.**
There were twelve and half of them held a single card. They are grouped by the
question somebody came to answer — Sync, Accounts, Budget, Rules, Holdings,
Access, Display, Archived — and every route that existed before still resolves,
redirecting to whichever section absorbed it.

**Cards are tiles on the one grid, and a card states what it needs.** `span` on
`SettingsCard` is `third`, `half`, `two-thirds` or `full`, and **defaults to
`full`** — a card that has not thought about it keeps the width it always had.
Twelve columns, the same grid Overview lays its tiles on (§2): it was six here
and twelve there, which is how `half` came to mean two different spans.

It is `span`, not `width`: a field's `width` is its own scale (§2), and two
vocabularies under one prop name is a trap for whoever reads it next.

**Cards on one line end level.** The grid stretches its items and the card is a
flex column with `h-full`, so its border reaches the bottom of the tallest card
beside it rather than stopping where its own content stops. Three radio groups of
three, two and three options drew three different boxes before that.

**A card holds one subject.** Where a second card was only a property of the
first, it belongs inside it under a rule and a `text-quiet font-semibold`
sub-heading — the Bitcoin node is where those holdings are read from, not a
subject beside them.

**Where the sections are listed is a per-device preference**, on Settings →
Display beside the theme and the row height: a row across the top, or a rail down
the side of the page. The rail belongs to Settings and disappears with it, so it
is rendered inside the page rather than in the app shell — the shell would
otherwise need to know which page is open, and would carry a second permanent
column everywhere else.

## 12. The sidebar

**Expanded, it is as wide as its longest label and no wider** — `w-fit`, not a
number, so a renamed destination cannot leave it stale. It was a flat 232px from
`design.md` §4, about sixty more than "Transactions" actually takes, and every one
of those pixels came off the page beside it.

Two rules make intrinsic sizing safe. Every nav label is `whitespace-nowrap`, so
the links state a real width rather than collapsing to their longest word. And
anything whose length nobody controls — the app name, the signed-in address, the
undo offer's own sentence — is capped at `--spacing-sidebar-cap` and truncates or
wraps, because `w-fit` takes the widest child and an email address is wider than
anything anybody navigates to.

### The control zone

Below the alerts and the budget's reading, above the sign-out block: the two acts
on the household, 8px apart, **Delegate then Sync SimpleFIN**. Neither is a fact
about the page underneath — the argument ADR 059 used to move the alerts out of
the page header — and Delegate sits directly under the reading it acts on, which
is the whole reason it is here rather than on Budget.

**Both ask before they do anything.** They are one control apart and the upper
one moves a pay packet, so a misclick costs a dialog rather than a distribution.
That includes Undo Delegation, which fired on the press until it moved here.

**Neither is coloured.** Delegate was the accent until v0.73.0; §5 says why it is
not. The one thing that paints a button in this zone is a condition it is
reporting, and only Sync has any.

**There is no caption under Sync.** "Synced 12m ago" was a figure nobody acts on
and "Last sync failed" was a line saying what the button's own colour says. The
button carries its state, and now the bank feed's whole list with it (§5, §9).

**Below `sm` there is no sidebar**, so Delegate falls back to `PageHeader` — the
same rule and the same reason as the alerts (§9). Sync does not: it has no phone
fallback today and did not gain one here, which is exactly why the alerts it
folds are unfolded again on a phone.

## 13. Themes

**A theme is a token swap and nothing else** — the colour tokens, plus
`--font-sans` and `--tracking-label`. Layout, spacing, the chip vocabulary, row
heights and every measurement above are outside it. A theme that needs a
different layout is not a theme.
[ADR 048](decisions/048-a-theme-is-a-palette-that-is-measured.md).

**Every theme is measured.** `theme-contrast.test.ts` reads `styles.css` and
holds each palette to WCAG AA on the pairs that actually appear: body text on
both grounds, each semantic colour on its own soft fill, `on-accent` on `accent`,
and a negative amount on the canvas — 4.5:1 throughout. **There are two palettes,
Light and Dark**, plus System, which follows the device rather than being a third
palette. A theme absent from that test's list is a theme nobody is checking, so a
third one is added to both in the same change or not at all.

**`--font-sans` and `--tracking-label` are still tokens** rather than values
written into every heading, even though both palettes now set them the same. They
were introduced for Ledger, which swapped the typeface; that theme is gone, and
the tokens stay because the thing they buy — one place to change a face or a
tracking value — is worth having whether or not a second palette uses it.

## 14. Recurring

**Due and Cost are side by side, always** — two-thirds and a third, stacking to
one column below `lg` ([ADR 061](decisions/061-every-page-is-a-page-of-tiles.md)).
They were two views behind a segmented control, and a switch between two answers
that are never in each other is one somebody has to press to find out which they
wanted.

Due takes the wide column because it is a seven-column table; Cost is a column of
dense lists, and §2's floor — a ranked bar with a name and a figure stops being
readable below about 300px — is what stops it being narrower.

**The Due table's Delegation column gives way at `@2xl`**, with the delegation in
the row's hover text at every width. Due is two-thirds of the page now, and the
merchant name is the one column whose content has no upper bound, so every other
width is taken out of it — the same trade `design.md` records for the "last seen"
column removed for the same reason.

**Cost is two tiles of rows**, not a grid of one card per utility: the per-cycle
comparison, and twelve months with the monthly average. Every figure still names
its unit — the tile's heading carries it for a column, and the row's hover text
carries both where a row has two.

## 15. What this does not change

Colour, the chip vocabulary, row heights, banner tones, the row-menu shell, the
keyboard map, and every decision recorded in `design.md`. Those were settled and
are not reopened here. This is the grid they all sit on.
