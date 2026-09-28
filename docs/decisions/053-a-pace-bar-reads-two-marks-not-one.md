# 053 — A pace bar reads two marks, not one

**Status:** accepted, amended by [054](054-the-pace-bar-measures-what-the-cycle-had.md)
**Date:** 2026-09-08

## Context

The owner brought a full visual specification for a redesigned Overview. Its
centrepiece is a **pace bar**: a progress track on every budget line, with a fill
for what has been spent and a tick for how far through the pay cycle the
household is. Reading it is the relationship between the two marks — fill left of
the tick is spending slower than time, fill past it faster.

Three things in Delegate stood in the way, and each is a decision rather than an
implementation detail.

**There was no dated cycle.** `pay_cadence` was introduced as a divisor and
nothing more — a cycle here is one Delegate press to the next, and no amount is
ever written because a date passed. A tick has nowhere to stand without dates.

**Envelopes carry over.** A line can have spent $100 of a $300 plan while holding
$450, because $200 rolled in from before. A bar drawn as spent-over-plan says 33%
and says nothing about the $450; a bar drawn over everything available says the
line is comfortable and hides that this cycle's money is going quickly. Both are
true and neither is enough.

**Red meant the wrong thing.** The specification turns the bar red when spending
exceeds what was delegated. In an envelope budget that condition is ordinary and
frequently correct — it is what carrying over is _for_.

## Decision

**One anchor date turns the divisor into a schedule.** `next_payday_on`, plus the
existing cadence, generates every boundary before and after it. Money still moves
on Delegate presses; nothing is scheduled by this and no amount is written
because a date arrives. What it adds is the other half of a question the budget
has never answered: not "how much is left" but "how much is left _for how long_".

**No anchor means no tick** — not a default. A marker drawn from a guessed
schedule would be confidently in the wrong place, and every pace reading on the
page is judged against it. The three cycle-shaped tiles draw nothing at all
rather than something plausible.

**The track carries both plan and reserve, split at a fixed 75%.** Plan to the
left, reserve to the right, fill counting up from the left through one and into
the other. Crossing the split is visible without a word.

> **Superseded by [ADR 054](054-the-pace-bar-measures-what-the-cycle-had.md).**
> The two zones meant two scales on an 8px track, and nobody reads two scales
> that small. The cycle zone is now one number — what the line had to spend —
> and the split moved to 80%.

**The split is at a fixed position on every row, never proportional.** This is
the load-bearing part. The tick is a _time_ marker, identical on every line, and
it has to read as one straight vertical down the column — that is what makes a
list of bars scannable rather than twenty separate charts. Scaling each track to
its own plan-plus-reserve would put the tick somewhere different on every row.

The cost is accepted: the reserve zone's width says only that there _is_ reserve,
not how much. The figure beside the bar says how much.

**Red is a negative balance and nothing else.**

> **Amended by [ADR 054](054-the-pace-bar-measures-what-the-cycle-had.md).** The
> rule stands; what changed is that red is a _segment_ rather than a _state_, so
> its width says how far past.

**Spending is measured from the payday, not the last press.** A press is where
money moves and a payday is where time is measured from; the bar compares one
against the other, so numerator and tick must share a window. With no anchor it
falls back to the press boundary, which is what this application has always meant
by a cycle.

## Consequences

- **Semi-monthly is approximate and says so.** Twenty-four paydays a year means
  exactly two per month, so it cannot be a fixed number of days — stepping
  fifteen at a time drifts five days over a year. It is two days of the month
  instead, derived from the anchor and its partner fifteen days away. A household
  paid on the 1st and the 15th, fourteen days apart, sees its second boundary
  land a day late. The fix, if it ever matters, is a second date rather than
  cleverer arithmetic.
- **Overview and Budget now describe the same line differently** — pace and
  spent-against-plan here, Remaining and To delegate there. That was the owner's
  call, taken knowingly. They read the same domain functions, so they can differ
  in presentation and never in arithmetic.
- **The pay cycle is a second notion of "cycle" beside the Delegate run.** They
  are kept apart by name everywhere: a _run_ is where money moved, a _cycle_ is
  where time is measured from. Anything that conflates them will produce a line
  that looks behind for no reason on a cycle where the press ran late.
- `ui-system.md` §1 gains 12px, deliberately and with the test changed rather
  than worked around. The scale is five values, not four, and 32 was proposed
  alongside it and refused because 24 already separates sections.
- A third text tone was proposed at `#a9a6a0` and **refused**: it measures about
  2.4:1, clearing neither the 4.5 AA asks of text nor the 3 it asks of non-text
  boundaries. `--color-axis` is that idea darkened until it clears 3:1, restricted
  to marks a chart could be read without, and measured in both palettes.
