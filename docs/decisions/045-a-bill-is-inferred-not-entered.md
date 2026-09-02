# 045. A bill is inferred, not entered

**Status:** accepted
**Date:** 2026-09-02

## Context

Every condition this application raises is about something that happened: a sync
that failed, a balance nobody confirmed, a charge waiting to be categorized. None
of them can see the opposite case.

**A bill that does not arrive leaves no trace.** A failed autopay, a card that
expired, a service that was cancelled by somebody else — from inside the budget
each of them is a merchant that simply stopped appearing, which is also what a
quiet month looks like. It stays invisible until a balance is wrong or a letter
comes, and by then the failure is weeks old.

The same absence hides a smaller thing in the other direction: a subscription
that renewed at a higher price is a perfectly ordinary charge, unremarkable on
its own row, and only visible beside what it used to cost.

There was no list of bills to check either against. The obvious answer — let the
household enter one — is the wrong one, and predictably so: a hand-maintained
list of bills is a second copy of facts the register already holds, and a second
copy is wrong within a month. It is wrong in the direction nobody notices, too,
because nothing prompts you to delete the row for a service you cancelled.

## Decision

**A bill is a merchant whose charges have landed at a steady interval.** It is
computed from the transactions on every request and **stored nowhere** — there is
no bills table, no `is_recurring` flag, and nothing to maintain. The only column
this feature added is the switch that decides whether it speaks.

It proposes and never writes, which is the line ADR 030 drew for a cleared check
and ADR 044 for a suggested delegation.

**What qualifies, and why each bound is where it is.**

- **Three charges**, because two give one interval and one interval agrees with
  nothing.
- **Every gap within a quarter of the median, floored at four days.** Month
  lengths differ by three, a weekend moves a bill by two, a card posts a day
  late. All of that is one monthly bill.
- **Every gap, not most of them.** One charge in the wrong place means a merchant
  that is sometimes billed and sometimes visited, and a schedule fitted through
  that is one nobody can rely on.
- **Nothing faster than a fortnight.** This is the bound that does the real work.
  Groceries, coffee and fuel recur in the plain sense, and their gaps are regular
  enough that a tolerant check would happily call the weekly shop a weekly bill.
  A household's actual bills are fortnightly at the fastest, so declining to
  answer below that is cheaper than answering confidently and wrongly.
- **Money out only, settled, not a transfer.** Income is not owed. A card payment
  is not a bill — the bill was the spending on the card, and counting both shows
  one obligation twice. A pending charge has not settled and its date moves when
  it does.

**A bill can stop.** `lapsed` exists because the alternative is worse than
useless: a service cancelled in March would otherwise be "overdue" every day for
ever. Past one further interval plus the grace, the row says `Stopped?` and
raises nothing. It stays on the page, because it is a true fact about the
household's spending, and it stops shouting, because a warning nobody can act on
teaches people to stop reading warnings.

**The notification has a switch and the page does not.** Settings → Budget
carries "Tell me when a bill is overdue". This is the first notification here
that can be turned off, and it is the right one to be: every other condition is a
fact the application knows, while this is a reading of a schedule it inferred.

The page stays either way. A switch that hid the list as well would make "I
turned the noise off" and "there are no bills" indistinguishable, which is the
exact state this project keeps refusing to create.

**Both figures are on the row.** Typical and last, side by side, with the last
one marked when it is more than a tenth above. That comparison is the whole of
how a price rise becomes visible, and it costs one column.

## Consequences

**The detection is a heuristic and the page says so by what it declines.** It
will miss a bill whose amount and date wander — an irregular quarterly invoice,
say — and that is the failure chosen deliberately. A page listing four of five
bills is four bills nobody was tracking; a page listing a fifth that is not a
bill produces a confident wrong date and eventually a notification about a
payment that was never due.

**It is bounded** at the most recent 5,000 charges, like the suggestions. The
register grows for ever and this runs whenever the page is opened.

**`merchantKey` is now load-bearing in a third place.** Suggestions group history
with it, the rule dialog fills its field from it, and a bill is a merchant under
it. That is the argument for it living in `@budget/shared`, and the argument for
being careful with it: a change to what counts as one merchant now moves three
features at once.

**A sixth destination in the sidebar**, and therefore a sixth tab on a phone,
where "Transactions" now truncates. The bar's column count comes from the shared
page list rather than from a number written beside it — it said `grid-cols-5`
while the list had five entries, so a new destination would have appeared in the
sidebar and silently off the end of the bar.
