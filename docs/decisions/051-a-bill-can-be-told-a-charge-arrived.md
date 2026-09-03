# 051. A bill can be told a charge arrived

**Status:** accepted
**Date:** 2026-09-03

## Context

[ADR 045](045-a-bill-is-inferred-not-entered.md) makes a bill a reading of the
register: a merchant whose charges land at a steady interval. Nothing is entered
and nothing is stored. That is still right — a bill nobody maintains is a bill
nobody forgets to maintain.

The first run against real data found the reading saying something the register
plainly contradicted. A life insurance payment of $30.96 left the account on
1 September and sat in the transaction list, while the Bills page said
**Overdue · 5d**.

Two separate causes, and the first is a mistake in ADR 045's implementation
rather than in its principle.

### A pending charge answered no question at all

`findRecurringBills` excludes pending transactions, with this reason: a pending
charge has not settled, its date moves when it does, and including it would shift
every prediction by however long the feed took.

That reason is sound, and it is a reason about **arithmetic**. It was applied to
the whole row. So the charge that answers "has this arrived?" — the only question
the overdue status is asking — was excluded from answering it.

The failure is the page contradicting something the household can see one click
away, which is the fastest way to make somebody stop believing a page.

### A merchant that renames itself is unreachable by any threshold

The second cause has no fix in the detection at all. Charges are grouped by
`merchantKey`. An insurer that changes what it sends the bank — `LINCOLN LIFE
PREMIUM` becoming `PROTECTIVE LIFE PREMIUM` — produces charges under a new key.
The old bill goes overdue for ever; the new one needs three occurrences before it
is a bill, which is three months of the old one shouting.

No threshold reaches this. The two strings share nothing, and loosening the key
until they matched would merge merchants that are genuinely different — which is
exactly the mistake [ADR 049's amendment](049-a-duplicate-is-proposed-never-archived.md)
had just been made to correct on duplicates.

## Decision

**A pending charge answers "has it arrived", and never touches the schedule.**
Pending rows are fetched with the rest and separated. The cadence, the typical
amount and the expected date are still fitted from settled charges only. A
pending charge newer than the last settled one sets a new status, `arrived`,
shown as **Paid, pending** — which is what the reader is checking against their
own account.

Newer than the last settled charge, specifically. A pending row _older_ than that
is the tail of a period already accounted for, usually one caught mid-settlement;
counting it would mark every bill as arrived for ever.

`arrived` is never announced. Nothing needs doing about it, and the notification
that shouts about a thing already handled is the notification people learn to
ignore.

**A charge can be attached to a bill by hand.** `bill_links` records that one
transaction belongs to one merchant's bill. It is the third correction on the row
menu, beside "not a bill" and "give it a name", and it is worded as what the
reader believes rather than as the mechanism: **The charge did arrive**.

**A link moves the last-seen date and never the cadence.** This is the load
bearing part. The schedule is fitted from charges that matched on their own; the
clock runs from all of them, links included. If a link were fitted too, attaching
one late payment would put a gap in the history that no longer fits the tolerance
— and the bill would vanish from the page entirely, which is a spectacularly
unhelpful answer to "this did arrive".

**The bill keeps the merchant's own name.** `feedName` comes from a charge that
matched by itself. A linked charge arrived under some other name — that is why it
had to be linked — and showing it would rename the row to the thing that went
wrong.

**One transaction belongs to at most one bill.** Attaching it somewhere moves it,
because saying a charge belongs here is also saying it does not belong where it
was. The dialog says so on the row before the press.

## Consequences

**This is a stored correction, and ADR 045 still holds.** The table holds no
bill: no schedule, no amount, no name, no next date. It holds one fact the
inference cannot reach, exactly as `bill_overrides` does for "this is not a bill"
and "this is not what it is called". The bill is still computed on every request.

**Three corrections is the whole vocabulary.** Not a bill, not that name, and
that charge is this one. Everything else on the row is arithmetic over
transactions and would be a lie if it were editable.

**`arrived` shifts what the overdue pill counts.** A bill whose charge is pending
raises nothing. That is the point, and it means the pill can go quiet while a row
still reads as not-yet-settled — which is correct and worth knowing when reading
the page.

**A link survives what it points at only while that row does.** The foreign key
cascades: archive a transaction and its link goes with it, and the bill returns
to whatever the register says on its own. That is the right behaviour — the
correction was about a specific charge, and without the charge there is nothing
left to assert.
