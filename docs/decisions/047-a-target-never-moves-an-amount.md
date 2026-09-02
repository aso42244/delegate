# 047. A target never moves an amount

**Status:** accepted, amended 2026-09-02
**Date:** 2026-09-02

## Context

A delegation's `amount_to_delegate_cents` is what the line receives when Delegate
is pressed. Everything else about a line — what it is for, what it is saving
towards, when the money is needed — was freeform text in `notes`, where the owner
writes `"$2200, Dec 27"` and does the per-paycheck arithmetic in his head.

That is the arithmetic worth having. `docs/architecture.md` said as much beside
the column: `notes` is a real text column precisely so that structured target
fields remain a purely additive migration later.

The question is not whether to store the target. It is what the application is
allowed to do with it once it has one.

## Decision

**A target is a reading, never a write.** Setting one changes no balance and no
amount to delegate. It records what the line is saving towards and, where a date
is given, works out what each remaining paycheck would have to carry — then says
so beside the figure the household actually controls.

That is the same line the Utilities page has always drawn: a bill averaging $118
is not a decision to fund it at $118, and the page suggests without ever writing.
The reason is sharper here, because this figure is not advice about a page — it
is the number multiplied by every line on the next Delegate press. An application
that rewrote it on its own would be moving real money for a reason nobody asked
for, discovered afterwards.

**The amount to delegate stays the household's, always.** It is typed, it is
theirs, and a target only ever judges it. Where the two disagree, the target is
not the one that wins.

**Taking the figure is one press and one switch.** The dialog shows what is
needed per paycheck beside what the line is set to, and offers _"Also set the
amount to delegate to $275.00"_ — off unless somebody turns it on. Afterwards it
is an ordinary amount: typed over, cleared, or left alone like any other. So a
target can be adopted in a second, and can be overridden by hand at any time,
which is what makes it safe to have one at all.

**The dialog spends its space saying what it does not do.** One line under the
reading: _"A target changes nothing on its own. It works out what each paycheck
needs to carry and marks the amount when it is not enough."_ That sentence is the
feature. Without it, a figure appearing in a dialog beside a Save button reads as
something that will be applied.

### Where it shows

**The chip beside the name says only that a target exists.** A chip is a
classification, and "saving towards something" is one. `tg`, because `t` is spent
on transfer — two letters where one would collide, which the vocabulary already
allows for `sp`.

**Whether the line is on course lives on the amount to delegate**, which turns
warning-coloured and carries the sentence on hover and through
`aria-describedby`. That is the figure somebody would change, so it is the figure
the judgement belongs on. A yellow letter beside the name would say something is
wrong without saying which number to fix.

**A pill, with no switch.** `2 lines behind` leads to the Budget page. The
overdue-bill pill added in [ADR 045](045-a-bill-is-inferred-not-entered.md) can be
turned off and this one cannot, and the difference is the point: a bill is a
schedule this application _inferred_ and can be wrong about, while a target is a
number the household typed. Being behind on it is arithmetic on their own
figures, and turning off arithmetic is not a preference — it is hiding the answer
to the question they asked.

### The shape of the data

**Two nullable columns, `target_cents` and `target_date`, and two check
constraints.** A date without an amount is a deadline for nothing; a target of
zero is not a target, because clearing one is what null is for. Both are held in
the database as well as in the domain, so a caller that never comes through
`updateDelegation` cannot write one either.

**No date is a standing target** — "keep $500 in this envelope". It has a
shortfall and no schedule, and it is deliberately not called `behind`: nothing
was due, so nothing is late.

**Clearing the amount clears the date with it.** Removing a target means the
whole target, and the validation checks the pair that will be _written_ rather
than the field that arrived — a distinction that failed its first test, because
checking a stored date against a cleared amount refuses the one request that is
unambiguously right.

**`target_date` is a `DATE`, and crosses the wire as `2026-12-27`.** A decided day
has no zone ([ADR 037](037-a-day-is-the-households-day.md)), and sending one as an
ISO timestamp invites the browser to place it in the reader's — so a target due
on the 27th renders as the 26th for everybody west of UTC.

## Consequences

**The arithmetic lives in `@budget/shared`**, with the money and merchant
helpers. The server computes the verdict for the row; the dialog computes it live
as somebody types, before anything is saved. Two copies would be two answers —
one on the row and one in the box where the decision is being made.

**The reading is computed server-side for the row and sent with it.** Whether a
line makes its date depends on the pay cadence and on which day it is in the
household's zone. The interface renders the verdict and never re-derives it.

**Paychecks remaining are floored, and never below one while the date is ahead.**
A half cycle is not a paycheck, and rounding up reports a per-cycle figure no
actual payday delivers. The per-cycle amount is rounded _up_ for the opposite
reason: $101 over two paychecks is $50.50 each, and a line funded at $50 is short
on the day it matters — which is exactly the quiet miss this exists to surface
rather than create.

**`notes` is a note again.** It stays freeform and every existing note is left
exactly as written, including the ones that say `"$2200, Dec 27"`. Nothing
migrates them: a text field somebody wrote by hand is not something to parse and
overwrite, and the two can coexist until he retypes them himself.

**No Insights tile, deliberately.** The Budget row answers "am I on course" where
the money is, and a tile would be a second place saying the same thing, to be
kept in step. If targets ever want a page of their own it should be because there
are enough of them to work through at once, which is a fact about the household
rather than about the feature.

---

## Amendment, 2026-09-02: a date is an anchor, and the figure is editable

The first target entered against real data was home insurance: **$2,200, due on
the last day of April and again on the last day of October.**

A single date could record the April one. It then went stale the moment it
passed — leaving the household to retype the same target twice a year, which is
precisely the by-hand arithmetic this feature exists to stop. A yearly insurance
premium, a quarterly water bill and a monthly saving all have the same shape and
none of them is a deadline.

**`target_date` becomes an anchor, and `target_interval_months` says how the rest
follow.** One occurrence of the series is stored; the reading always works towards
the next one still ahead, and rolls on by itself as each passes. A null interval
is a one-off, which is what every existing row is and what it stays.

**Months, not days.** A bill due on the last day of April is due on the last day
of October — thirty days later than a naive six-month jump, and not expressible in
days at all. `addMonthsToDayKey` keeps the end of the month: an anchor that is the
last day of its month lands on the last day of every month it reaches, and any
other day is clamped rather than allowed to roll over, so the 31st of January plus
one month is the 28th of February rather than the 3rd of March.

**The anchor may sit either side of today.** Somebody recording "the last day of
October" in September means this October, and a series anchored in April 2020
means the next one after today. `nextOccurrence` walks both ways.

**On the day itself, the date is still ahead.** `cyclesUntil` returns one rather
than zero for today, because money is due _that day_ and reporting the whole
shortfall as already too late on the morning it is wanted is the wrong answer.

### The offered amount is editable

The switch that applies the calculated figure now reveals a money field holding
it, and what gets written is whatever is in that field.

The calculated amount is the common answer and not the only one. Somebody funding
$274.38 a paycheck is more likely to want $300, and closing the dialog to go and
type that on the row is an extra step in exactly the moment they had decided.
Nothing about the promise changes: the field is empty of consequence until the
switch is on, the switch is off unless somebody turns it on, and the target still
moves nothing by itself.

### Three fields that constrain each other

The update path resolves the amount, the date and the interval **once**, as the
three values that will be written, and both validates and writes from that. Doing
it any other way went wrong twice in one afternoon: validating the field that
arrived refuses "remove this target", and writing the field that arrived while
validating something else lets a request past the domain and into a check
constraint — which then reports itself as a Prisma error rather than as a
sentence. Both of those were caught by tests written against the intent rather
than the implementation.
