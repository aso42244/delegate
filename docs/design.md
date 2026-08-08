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

## 5. Main Budget

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
