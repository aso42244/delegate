# 037 — A day is the household's day, not UTC's

**Status:** accepted
**Date:** 2026-08-28

Narrows [ADR 036](036-the-schedule-timezone-is-a-setting.md), which limited the
zone setting to _when jobs fire_ and left every date the domain computes in UTC.

## Context

ADR 036 gave the household a zone and drew a deliberate line around it:

> It governs when jobs fire and nothing else. […] Every date the domain computes
> — which day a transaction posted on, which day a valuation is as-of, which day
> a Bitcoin close belongs to — stays UTC. Moving those is a real decision with
> real migration consequences and belongs on its own branch.

This is that branch, and the line was drawn in the right place for the wrong
reason. What it protected against — a migration through live financial data —
turns out not to exist. What it left in place is a bug that shows up nightly.

**The bug.** UTC is five or six hours ahead of the household. Anything after
about six in the evening is already tomorrow there. So:

- A charge at 8pm on the 31st of August was counted in **September's** utility
  average. The month it was actually made in came out short and the next came out
  long, and the suggested per-paycheck figure drawn from the average was wrong in
  both directions.
- The hourly Bitcoin price fetch, from six in the evening onwards, filed its
  reading under **tomorrow's** date — leaving the day it was actually taken on
  without a close, and settling a close for a day that had not happened.
- A price fetched minutes ago read as **stale** all evening, because "is this
  from today" compared against the UTC day.
- A balance typed into Settings → Accounts in the evening recorded its valuation
  under **tomorrow**, so the day it was typed on still read the old figure.
- Year-to-date on New Year's Eve excluded the evening it was looking at.

**Why the migration fear was unfounded.** The three columns ADR 036 named were
checked rather than assumed:

- `transactions.posted_at` is a `DateTime` holding a true instant, taken from
  SimpleFIN's unix epoch. It is already correct; only the _reading_ of it was
  wrong.
- `account_valuations.as_of` and `bitcoin_prices.price_date` are `@db.Date`
  columns holding calendar days somebody decided. A decided day needs no zone.

So nothing stored has to move. What changes is the _interpretation_ of instants
at the boundary where they become days — twelve sites across eight files.

## Decision

**One zone, one module, and a distinction held in the type of the thing.**

`apps/api/src/domain/calendar.ts` is now the only place that answers "which day
is this instant in", and it keeps two ideas apart:

- **An instant** — `posted_at`, `occurred_at` on a delegation event, `now`,
  `created_at`. The same moment everywhere; asking which day it is in _requires_ a
  zone.
- **A date key** — `as_of`, `price_date`, `snapshot_date`, a date somebody typed.
  A calendar day already decided, stored as midnight UTC because a `DATE` column
  has no zone, and needing none.

Conflating the two is the entire bug, so the module's header says so and each
function is named for which it takes.

- **`schedule_timezone` now means the household's zone.** The column and
  `SCHEDULE_TIMEZONE` keep their names deliberately: renaming the environment
  variable would silently revert a deployment to UTC the first time it booted
  without the new name, and that class of quiet failure has cost this project
  more than a slightly narrow name will. `householdTimezone()` is the read path.
- **The zone is a required argument, never an optional one defaulting to UTC.**
  A call site that forgets it is a build error rather than a silent revert to the
  behaviour being fixed.
- **Only where an instant genuinely becomes a day.** `priceOnDate` takes a key
  and stays zone-free; `addMonthsToKey` is plain calendar arithmetic. The
  discipline is that adding a zone parameter to a function that does not convert
  an instant is as wrong as omitting one from a function that does.
- **Local day bounds are resolved by probing, not by arithmetic.** The offset at
  midnight UTC is not the offset at local midnight on a spring-forward morning.
  Two mornings a year are 23 and 25 hours long, and a query filtering `posted_at`
  by a 24-hour window would drop an hour of transactions or count it twice.
- **`revalueBitcoinHoldings` is explicitly _not_ given a zone.** It values a
  quantity; whether the price is today's is irrelevant to it. Threading a zone
  through the six layers above it to compute a boolean it discards would have
  been the kind of parameter that eventually gets passed wrongly. `latestPrice`
  (staleness, needs a zone) and `newestPrice` (the figure, does not) are now two
  functions saying which question they answer.

## Consequences

- **No migration, and no backfill.** Nothing stored changes. Rows already written
  keep their dates; the snapshot tables are days old.
- **Figures move once, on deploy, and the new ones are right.** A utility average
  can shift by one bill, and a year-to-date total by an evening's spending. This
  is the correction, not a regression — but it will look like a change to
  somebody who was not expecting one.
- **UTC deployments are unaffected.** Every conversion is the identity in UTC,
  and the tests assert that in both directions rather than only checking the
  interesting zone.
- **Changing the zone in Settings re-cuts history on read.** The stored snapshot
  dates do not move, but a month boundary computed on the fly does. Moving zone
  is rare and moving it far is rarer; recomputing stored rows is not worth the
  machinery.
- **The DST edges are tested rather than reasoned about.** The calendar tests
  tile a full year with no gap and no overlap, round-trip 365 days in four zones,
  and assert the 23- and 25-hour days explicitly. Those are the assertions that
  fail if somebody later replaces a probe with a subtraction.
- **The line ADR 036 drew is now moved, not erased.** That ADR's reasoning about
  _why the value lives in a table rather than the repository_ is untouched. Only
  its "and nothing else" clause is superseded.
