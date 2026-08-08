# Visual design

The owner's design specification. **Visual only** — it describes nothing about
behaviour. Where a design specification and a functional requirement disagree,
**functionality wins and the design bends around it.** The conflicts found so far
are listed at the bottom of this document; they are not editorial quibbles, they
are places where following the design literally would break a hard constraint.

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
Four states driven by the unassigned sum:

| Condition        | State    | Look                             |
| ---------------- | -------- | -------------------------------- |
| Within ±$4.99    | Balanced | Green                            |
| +$5.00 or more   | Warning  | Yellow; suggests distributing it |
| −$5.00 to −$9.99 | Warning  | Yellow; shows the shortfall      |
| −$10.00 or more  | Danger   | Red; shows the shortfall         |

See conflict 3 below: the thresholds must read from the configurable tolerance,
and a positive reading is the normal payday state rather than a warning.

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

Contents: delegation name (13px/650); a "Note to self" panel on soft surface in
italic secondary text, rendered only when a note exists; Rename; Utility with a
right-aligned toggle; Move to grouping `▸`; divider; then the destructive action.
Items are 13px, 7px vertical padding, 6px hover radius. Dismisses on outside
click.

See conflicts 1 and 2: the destructive action is **Archive**, not Delete, and the
menu is missing two required items.

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

## Conflicts with the build prompt

Recorded rather than silently resolved. Numbered so they can be settled
individually.

### 1. "Delete" must be "Archive" — hard constraint

The row menu specifies **Delete in red**. Hard constraint 3 is that nothing is
ever hard-deleted; delegations, groupings, accounts and transactions are archived
with a timestamp and stay resolvable so an eight-month-old transaction still
renders `Grocery (archived)`.

A menu item labelled Delete would therefore describe something the system does
not and must not do. **Resolved as: the item reads Archive.** It may still be the
destructive-red item at the bottom of the menu.

Archiving a delegation is also blocked unless its balance is exactly $0, so the
item needs a blocked state offering Transfer and Adjust inline (§6.9).

### 2. The row menu is missing two required items

The design lists Rename, Utility, Move to grouping, Delete. §9.1 requires the
menu to also offer **"Manually adjust this line"** and **"History for this
line"** — the only route to the per-delegation event history, since adjustments
deliberately never appear on the Transactions page.

**Resolved as: both are added**, above the divider.

### 3. The banner thresholds are hardcoded, and treat payday as a fault

Two problems.

The tolerance is **configurable in Settings**, defaulting to $5.00 (§6.6, §9.5).
The design hardcodes ±$4.99, −$9.99 and −$10.00. **Resolved as: thresholds derive
from the configured tolerance**, with the danger threshold at twice it.

More substantially: a **positive** reading is shown as a _warning_. But per §6.6 a
positive number is the ordinary, healthy state on payday — money has landed and
has not been distributed yet, and that figure _is_ the "available to delegate"
amount. Colouring the most common good state yellow trains the owner to ignore
the banner, which is the one thing it must not do.

**Proposed: positive is informational, not a warning** — accent blue or neutral,
labelled `$4,890.00 to delegate`. Yellow and red stay for the genuinely wrong
direction, over-delegation. Flagged for the owner; not yet settled.

### 4. Grouping colour as a row tint contradicts the original restraint

§11 says grouping colour "must not be in your face", specifies a 3px left rail or
a small dot, and says **"never a filled row background."** The design specifies a
soft tint on the grouping row and a fainter tint on its children.

The newer design is the owner's own and supersedes it, and soft tints are a fair
reading of restraint. **Resolved as: follow the design**, with the tints kept
faint enough that the near-black text keeps its 4.5:1 contrast, and re-judged
against real data as §12 anticipated.

### 5. "Metrics" versus "Insights"

The design calls the page **Metrics**. §9.4 and decision 1 in §15 name it
**Insights**, deliberately. **Resolved as: Insights**, since it is a flagged
decision the owner can still overturn, and this document uses that name
throughout.

### 6. The app name is personal data

The design titles the application **"Ott Family Budget"**. Hard constraint 4
forbids personal data in the repository, and §5 requires that going public be a
README and a LICENCE rather than a refactor. A family name baked into committed
UI copy is exactly what that rule is about.

**Resolved as: the displayed name comes from configuration** — an `APP_NAME`
environment variable defaulting to `Household Budget`. The owner sets it to
whatever he likes in `.env`, which is git-ignored, and the repository stays free
of it.
