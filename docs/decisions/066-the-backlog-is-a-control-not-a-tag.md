# 066 — The backlog is a control, not a tag

**Status:** accepted
**Date:** 2026-09-15

Amends [ADR 063](063-the-feed-reports-in-its-own-button.md), which listed the
categorization backlog among the things that "stay tags", and
[ADR 064](064-the-corner-answers-one-question.md), whose control zone was a group
of exactly four. Extends [ADR 065](065-a-dashboard-you-can-work-from.md), which
made the backlog something you work rather than something you read.

## Context

The foot of the sidebar says two different kinds of thing, and until now it drew
them the same way.

Above the rule is a column of tags: a sync that failed, an account the feed has
stopped reporting, a cheque waiting to be confirmed, a bill that did not arrive.
Every one of them is a **condition**. You read it, you work out what it means,
and then you decide whether to do anything. The tag is right for that — it
reports, it does not act, and ADR 059 put it in the sidebar precisely because it
is not a fact about the page underneath.

Below the rule is the control zone: the reading, Delegate, Sync SimpleFIN, Sign
out. Those are **acts on the household**, plus the one figure the household opens
the application for.

`4 new transactions` was in the column, and it is not a condition. It is a queue
of work. There is exactly one thing anybody has ever done about it — go and clear
it — and since ADR 065 the clearing starts on Overview, one press away from the
tag itself. Nothing about it is a judgement call, which is what separates it from
every other row in that column: a bank needing a fresh login might mean
re-authorising, or waiting, or ignoring it for a week.

Drawn as a tag it also lost every argument ADR 064 made about the reading. It was
a 13px pill above four bordered buttons — the smallest object in the corner,
carrying the most actionable thing in it, and the owner's own eye went to the
buttons.

**The counter-argument, and why it does not hold.** ADR 064 says the reading is
the only always-coloured thing in that zone so nothing competes with it. A second
blue control does compete — but only on the days there is a backlog, and ADR 063
already settled that shape: what is coloured in the control zone is a control
**reporting a state**, which is why Sync goes yellow. An empty queue is not a
state worth a button, so on a quiet morning the corner is exactly what ADR 064
made it.

## Decision

**The backlog is a control in the sidebar's foot, directly above Delegate**, and
it exists only while the queue is not empty.

**Blue.** `info`, the tone the notification already carried, and the same blue
the reading takes when there is money to delegate. A backlog is the ordinary
consequence of a bank feed that works, not a fault — yellow would say something
had gone wrong, and the thing that would then have gone wrong is "the bank sent
us transactions".

**A link, and so it does not ask first.** `ui-system.md` §12 says everything in
this zone asks before it acts, and that rule is about acting: distributing a pay
packet, rolling one back, fetching the bank, ending the session. This navigates,
exactly as the reading above it does. A confirmation on a link is a dialog in the
way of nothing.

**It keeps the count as its name and the sentence in its popover.** `4 new
transactions` on the face, and `4 transactions are waiting to be categorized, the
oldest from 3 days ago.` in the `ControlPopover` every other stateful control in
this zone uses. The age is the half that says whether it is urgent and the face
has never had room for it.

**It goes to the queue, not the register** — `?uncategorized=true`, unchanged
from the tag. That distinction was the whole point of ADR 044's filter living in
the URL and it survives the change of shape intact.

**Above Delegate rather than below it.** ADR 064 put Delegate directly under the
figure it acts on, and this separates them. That is the owner's call and it is
the right one: the two are read in the order the morning happens — what came in,
then what to do with it — and the reading is still the top of the zone and still
the thing the eye lands on.

## Consequences

- **`BACKLOG_KIND` joins `SYNC_KINDS` in `components/notifications.ts`.** Two
  folds out of the column now, on two different lines: the feed's because they
  are all answered at one connection, this one because it is work rather than a
  condition. The module already existed to hold exactly this kind of question.
- **The control zone is a group of four or five**, not four. It is still one
  group under one rule, and nothing else about ADR 064 changes.
- **A phone is unaffected and keeps it as a tag.** There is no sidebar below
  `sm` and so no control zone to hold it, so `Alerts inline` keeps it in the
  dot's list — the same treatment `SYNC_KINDS` get there and for the same
  reason: a thing on screen on a laptop and nowhere at all on a phone is the
  failure that case exists to prevent.
- **`buttonFace()` now dresses two links rather than one.** Both are in this
  zone and both go somewhere; the reading to Overview, this to the queue.
- **The end-to-end suite needed no change.** It looked for
  `getByRole('link', { name: '1 new transaction' })`, and the control is a link
  with the same accessible name — which is the test asserting the thing that
  actually matters rather than the markup that carried it.
- **No `role="status"`.** The reading 8px above is this zone's live region.
  A second one would have a screen reader announce two things after every sync,
  and the count is in the link's name either way.
