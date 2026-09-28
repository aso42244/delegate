# 033. One UI system, with a test that holds it

**Status:** accepted
**Date:** 2026-08-25

## Context

The owner asked for a review of every screen — spacing, widths, button size and
placement, and how much explanatory text sits on each one — and then for a spec
that makes them one application rather than seventeen.

The audit was done by screenshotting all seventeen screens at 1280px and 375px
and reading the source behind them. The look was never the problem. Nearly every
screen was defensible on its own; together they were not one thing.

What was actually found:

- **Four page headers.** `mb-4` on two pages, `mb-6` on a third, a fourth with no
  subtitle at all. `flex` on one, `flex flex-wrap` with `gap-3` on another.
- **Five widths for one kind of field.** A text input was 384px on Settings →
  Users, 576px on Sync and 918px on Two-factor. `TextField` was hard-coded to
  `w-full`, so its width was whatever container it happened to land in.
- **Spacing at every value from 1 to 8.** `gap-2` 78 times, `gap-3` 51, and
  `mt-1`, `mb-1`, `mt-2`, `mb-4`, `gap-4`, `mb-6`, `mt-5`, `mb-8` behind them.
  There was no scale to be off.
- **Three verbs for creating a thing** — Add, Create, Set up — including **"Add
  grouping"** on the Budget page and **"New grouping"** in Settings, two buttons
  opening the same dialog.
- **Four ways of saying a list is empty**, ranging from `No groupings yet.` to a
  two-line paragraph explaining where to go instead.
- **Two segmented controls on one page, built differently.** The Insights window
  picker was five Buttons with one turned primary, sitting directly above the
  tile switchers, which were a real pill group.
- **Two cards carrying permanently-open create-forms** — Bitcoin and Properties —
  which the settings-card convention had already ruled out, and which on a phone
  wrapped a checkbox onto its own line beside a field and pushed an input past
  the card's edge.

## Decision

**`docs/ui-system.md` is the measurements.** `design.md` keeps the visual
language and the record of decisions; the new document holds the numbers every
screen must use. Two documents with disjoint jobs, rather than one 900-line file
where the mechanical rules are buried among the reasoning.

**Four spacing values: 4, 8, 16, 24.** A gap that cannot be expressed in those is
a sign the grouping is wrong, not that the scale is short.

**A field states its own width** — 128px, 256px, 384px, or full inside a dialog —
chosen by what goes in it. `max-w-full` on all of them, which also fixed the
input running off the edge of a phone card.

**A text budget, made countable.** One line of subtitle per page. One line of
description per card, 80 characters. One short hint per field, and only when the
label cannot carry the meaning. An empty state is one sentence with no
instructions — where to go next belongs on the control that goes there, which on
every one of these screens was a button already sitting a few pixels above the
text telling the reader to go and find it.

**Creating is `New <noun>` at the entry point and the bare verb on the submit.**
The dialog title already carries the noun; repeating it is exactly the extra word
this pass is about.

**One `PageHeader`, `StatusLine`, `EmptyState`, `SegmentedControl` and
`Disclosure`.** Each replaced between three and five near-identical
implementations.

**`ui-system.test.ts` enforces the mechanical half by reading the source.** Five
rules: the spacing scale, the page header, declared field widths, no bare
`<details>`, and the create-verb. It is a lint rule rather than a test of
behaviour and it lives in the web app rather than in ESLint, because it is about
this design system and would mean nothing anywhere else.

That test is the part that matters. The drift did not happen because anyone
decided to be inconsistent; it happened one hurried change at a time, with
nothing looking. A spec nobody can check is a spec that lasts until the next
hurried change.

## Consequences

**Every end-to-end spec that named a renamed control had to be updated**, and
seventeen failed on the first full run. That is the suite doing its job: the
labels are the interface, and a test that did not notice them changing would not
be testing the interface.

**One trim went too far and was put back.** Settings → Budget lost the line
reading "26 paychecks a year", which was the only confirmation that the pay
cadence select — which saves on change, with no Save button — had taken effect.
It returns as the field's hint. `SelectField` gained a `hint` prop to carry it,
which `TextField` already had. **Removing words is not free where the words were
the feedback.**

**The `s` chip, the row menu, the chip vocabulary, the colours and the row
heights are untouched.** Those were settled and this pass is the grid they sit
on, not a reopening of them.

**Two exemptions are named in the test rather than left implicit**: the app shell
keeps its own gutter from `design.md` §4, and the three screens outside the shell
— sign-in, forced password change, enrolment — are centred cards with no
navigation and no actions, where a header built for a title-plus-actions row
would be the wrong shape.
