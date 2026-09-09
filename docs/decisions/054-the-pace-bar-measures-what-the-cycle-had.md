# 054 — The pace bar measures what the cycle had

**Status:** accepted
**Date:** 2026-09-09
**Amends:** [053](053-a-pace-bar-reads-two-marks-not-one.md)

## Context

ADR 053 built the pace bar with a two-zone track: this cycle's plan to the left
of a fixed 75% split, carried-over reserve to the right. The reasoning was that
envelopes carry over, so neither spent-over-plan nor spent-over-everything is a
complete reading, and the bar should carry both.

It shipped in v0.59.0 and the owner used it. Two things came back from that use.

**Two zones meant two scales, and nobody reads two scales at 8px.** The fill
crossing the split was supposed to say "into reserve". What it actually said,
to the person the page is for, was "something changed here" — and the change of
meaning at the boundary made the whole row harder to read, not easier, because
the same horizontal distance meant different amounts on either side of it.

**Red arrived too early and too often.** ADR 053 set red at a negative balance,
which is correct as a rule. But the whole bar turned red at once, so a line that
had overspent by two dollars looked exactly like a line that had overspent by
two hundred, and the grouping's colour — which is how the owner's wife finds a
line in a column of twenty — disappeared at precisely the moment she was looking
at that row.

The owner then specified the replacement himself, in a form that resolves both.

## Decision

**The cycle zone is one scale: what this line had to spend.** Delegation plus
whatever surplus or deficit carried in, as one number, because it answers one
question — how much is there before the next payday. The reserve zone is gone;
carried money is inside the reading rather than beside it.

**It is derived, never stored:** `available = spent + balance`. The balance is
what is left and the spending is what has gone, so their sum is what there was —
and that holds whether or not this cycle's Delegate press has run yet, which a
`delegation + carry-in` formula does not. A press running mid-cycle moves both
terms and never the sum's meaning.

**The split moves to 80%, and the tick travels 0 → 80% only.** The load-bearing
part of ADR 053 stands unchanged and is now stronger: because the tick's range
is the cycle zone and the cycle zone is a fixed 80% on every row, the tick lands
at the same x on every line in the column, whatever that line holds. One
straight vertical down the page was the owner's stated first priority.

**80–100% is overspending past everything the line had**, full at a quarter
over and clamped beyond. A line 30% over and a line 300% over both have to stay
inside their own box; past a point, "well past" is the whole of the message.

**Only that part is red.** The fill keeps the grouping's colour the entire
length of the cycle zone. Red now means one thing and means it precisely: this
much was spent beyond what the line had. ADR 053's rule — red is never
spent-exceeds-delegation — survives intact; what changes is that red is now a
_segment_ rather than a _state_, so its size says how bad it is.

**The hover text states figures and never a verdict.** "$566 spent of $830 ·
$105 carried in". No "On pace", no "Out of money": the bar already says the
shape of it, and a household reading its own budget wants the amount rather than
an opinion about the amount.

**Remaining stays the line's actual balance** and goes negative when the line
is. It is the one figure somebody reads to decide anything, and smoothing it at
zero would make it a different figure.

## Consequences

- **The bar no longer distinguishes delegation from carry-over visually.** A
  line living off a large surplus — $135 delegated, $496 carried — reads as
  comfortable all cycle while spending several times its delegation. That is the
  right answer to the daily question and it is a real loss of information at a
  glance. The hover text is where that story now lives, and the Budget page has
  always been where it lives in full.
- **A line can open a cycle already overspent.** With a deficit larger than the
  delegation, `available` is negative before a dollar moves: the cycle zone is
  full from day one and Remaining opens negative. There is no scale to measure
  the overspend against, so the zone falls back to a quarter of the delegation
  and, failing that, simply fills.
- **`paceFill` no longer reads `plannedCents` for the common case.** It stays in
  the signature because the underwater fallback needs it and because
  `carriedIn` — the hover text's other half — is `spent + balance − planned`.
- ADR 053's other decisions are untouched: no anchor means no tick, spending is
  measured from the payday rather than the last press, and the split is never
  proportional.
