# 055 — Bills and Utilities are one page, and a glance on Overview

**Status:** accepted
**Date:** 2026-09-09

## Context

Bills and Utilities were two sidebar entries. The owner asked whether they were
redundant with each other, whether they should merge, and whether either belongs
on Overview instead.

They are not redundant with each other. They ask different questions of the same
rows:

- **Bills watches time.** Did a charge that should have landed, land? A failed
  autopay and a cancelled service look identical from inside a budget — no
  transaction, which is also what a quiet week looks like — and stay invisible
  until a balance is wrong or a letter arrives.
- **Utilities judges amount.** Is this line funded at what it actually costs?
  The arithmetic the owner used to do by hand: what a bill averages over a year,
  and what that is per paycheck.

Neither answer is in the other page, so neither is a filter of the other.

What they share is shape. Both are derived entirely from the register and store
nothing. Both are lists of the same recurring merchants. And **Electricity was on
both of them**, described two different ways — which is the actual confusion, and
one that merging the pages fixes while moving them to Overview does not.

## Decision

**One page, `Recurring`, with two views: Due and Cost.** One sidebar entry
instead of two, one place a merchant lives, and the two questions kept apart by
name rather than blended into a list that answers neither.

**The view lives in the URL.** A view kept in component state resets every time
somebody follows a link out and comes back, which is how Insights lost its window
on every navigation — including on a press of one of its own tiles.

**Both old addresses redirect** — `/bills` to the Due view, `/utilities` to Cost.
A bookmark is a promise and the thing it pointed at still exists.

**The glance moves to Overview as five tiles**, reading the same two builders:
what is coming, what needs a look, what this cycle's recurring charges come to,
which way each utility is going, and which are worth adjusting.

**The page is not absorbed into Overview.** Bills carries real operations —
search, renaming, attaching a charge to a bill, dismissing one — and Utilities
draws twelve months of history per line. Both are inspection surfaces, and a tile
that tried to be either would be a small bad table. This matches the owner's own
division: Overview is a quick review, pages are for operations and inspection.

**Two of the five tiles are exception lists.** "Needs a look" and "Worth
adjusting" are empty most weeks. A tile that is usually empty and occasionally
urgent is worth more of a dashboard than one that always says the same thing.

**A utility's trend compares twelve months against the twelve before**, not six
against six. These bills are seasonal: July's electricity against January's is
weather rather than a trend, and a tile that flagged every air-conditioned
household every June is one nobody reads by August. A line without two years
behind it says it does not know, rather than reporting a confident 0%.

## Consequences

- **The utilities window doubled to twenty-four months.** The average and the
  suggestion still read the last twelve, and deliberately: taking twelve
  _complete_ months out of a twenty-four-month window reaches back past the year
  the page draws, and on a household whose history is shorter than the window it
  changes the divisor — eleven months of bills averaged over twelve. That moves
  the suggestion without anything about the household having changed. Caught by
  the existing tests, which is what they were for.
- **Bills carry their grouping's colour**, so a bill on Overview is the same
  colour as the money it comes out of is everywhere else.
- **`utilities_vs_delegated` feeds three tiles.** They are three readings of the
  same twenty-four months, which is the arrangement the aggregate series already
  uses for the three net-worth tiles — one pass, one payload, three tiles.
- **The sidebar is one entry shorter**, which matters as Overview joins it.
- The `bills` icon serves the merged entry. A new one was not drawn: the sidebar
  has one visual language and inventing a glyph for a merge is not a reason to
  extend it.
