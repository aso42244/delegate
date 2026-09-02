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

**Four spacing values. Nothing else.**

| Step | Tailwind | Used for                                                 |
| ---- | -------- | -------------------------------------------------------- |
| 4px  | `1`      | Label to control, control to hint                        |
| 8px  | `2`      | Controls in a cluster, buttons in a row, chip to chip    |
| 16px | `4`      | Blocks inside a card, card padding, header to body       |
| 24px | `6`      | Card to card, page header to content, section to section |

`gap-3`, `gap-5`, `mb-3`, `mb-5`, `mb-8`, `mt-3`, `mt-5`, `space-y-3` and every
other off-scale value are banned and tested for. Two exceptions, both allowed by
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

**One primary per screen**, and it is the thing you came to that screen to do —
Delegate on Budget, New transaction on Transactions. Everything else is
`default`. A screen with two primaries has not decided what it is for.

`danger` appears only inside a dialog or a row menu, never sitting on a page.
`ghost` is for a control that must recede: a disclosure toggle, a tertiary
escape.

**Creating a thing is always `New <noun>`.** Singular, no article. New
transaction, New grouping, New rule, New account, New check, New holding, New
property, New person. Not Add, not Create, not Set up. The audit found all four
in use, twice for the same action.

Buttons in a row: `gap-2`, primary last, destructive never adjacent to the
confirm.

## 6. Cards

`rounded-lg border border-line bg-canvas p-4`.

- Title `text-base font-semibold text-ink`
- Description optional, one line, `text-quiet text-muted`
- An optional action in the header, right, baseline-aligned with the title
- 16px from the header to the body
- **24px between cards**

**A card never carries a create-form.** Adding is a header button and a dialog,
which was already the rule and which Settings → Bitcoin and Settings → Properties
both broke by parking a permanently-open form where the list should be. A form
below a list pushes the list off the screen to make room for something that is
used once.

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

## 9. Header pills

`HeaderPill`. 28px, `rounded-lg`, a 1px border and a soft fill in its tone,
`text-quiet font-semibold`, `px-3`. The same object whether it is the budget's
own reading or something the application needs to say, because they sit on one
row and anything else reads as two kinds of thing pretending to be one.

**Every notification is one of these, at every severity.** There is no bar and
nothing renders above the page. A pill's tone and its words carry how serious it
is — the same way every other state in this system carries it — and floor space
is not asked to say it a third time.

**Two or three words, and a count is the most detail one carries.** `Sync issue`,
`4 new transactions`, `1 check to confirm`. Which bank, which accounts, how old —
that is the tooltip, one hover or one focus away, and it is where the whole
sentence goes.

Order: the page's own reading first, then whatever the application is reporting,
in the severity order the server sends.

A pill that leads somewhere is a `Link` and takes its own defaults with it — the
backlog opens `/transactions?uncategorized=true`, which is not what the sidebar's
link does. A pill that only reports takes focus and does not act.

## 10. Dialogs

One component, `Modal`, in two frames: a centred card on a pointer, a sheet
rising from the bottom edge on a phone. Escape closes it and Cancel closes it;
the backdrop does not, because these hold typed money.

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

**Cards are a three-column grid, and a card states what it needs.** `span` on
`SettingsCard` is 1, 2 or 3 and **defaults to 3**, so a card that has not thought
about it keeps the full width it always had. Three radio buttons take a third of
a row; a table of forty rules takes all of it. Grid gutter `gap-6`, which is the
card-to-card step from §1.

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
anything whose length nobody controls — the app name, the signed-in address — is
capped at `--spacing-sidebar-cap` and truncates, because `w-fit` takes the widest
child and an email address is wider than anything anybody navigates to.

## 13. What this does not change

Colour, the chip vocabulary, row heights, banner tones, the row-menu shell, the
keyboard map, and every decision recorded in `design.md`. Those were settled and
are not reopened here. This is the grid they all sit on.
