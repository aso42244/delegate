# 063 — The bank feed reports in its own button

**Status:** accepted, amended by [064](064-the-corner-answers-one-question.md)
**Date:** 2026-09-11

Amends [ADR 059](059-one-tag.md), whose "every notification is a tag at the foot
of the sidebar" this narrows, and [ADR 060](060-the-sidebar-holds-the-acts-on-the-household.md),
whose "the shell keeps a primary" this reverses and whose description of the Sync
button's state this replaces.

## Context

The column at the foot of the sidebar was the right home for a notification and
the wrong home for five of them at once.

On the owner's own machine the standing set is: a run that failed or warned, an
account the bridge has stopped reporting, a balance nobody has confirmed, an
account a sync discovered and guessed the type of. Five tags, four of them
yellow, stacked directly on top of a yellow **Sync SimpleFIN** button — and every
one of them answered by looking at the same connection. That is one sentence said
five times, in the space where the notifications the feed has _nothing_ to do
with were supposed to be legible: a categorization backlog, a cheque to confirm,
an overdue bill.

Two smaller things were wrong in the same corner.

**The blue button was the dangerous one.** Delegate was `primary` because it had
been the Budget page's primary, and in the control zone it sits 8px above Sync.
The loud button moves a pay packet; the plain one below it is the one pressed
daily. That is an invitation to reach for the wrong control, and the
confirmation dialogs ADR 060 added exist precisely because the two are that
close.

**The phone had the opposite problem.** Below `sm` there is no sidebar, so
`Alerts` falls back to the page header — where three tags wrapped the title onto
a third line and pushed Overview's band, the only thing anybody opens that screen
for, off the bottom of it. And a tag's detail is a tooltip, which a touchscreen
has no way to open at all: the sentence naming _which_ bank or _which_ accounts
was unreachable on the device most likely to be in the hand when it mattered.

## Decision

**Everything the SimpleFIN import is responsible for is folded into the Sync
SimpleFIN button.** `SYNC_KINDS` in `components/notifications.ts` is the list,
and it is the list because each of these is answered at the connection:
`sync_failing`, `sync_warning`, `stale_balances`, `feed_not_reporting`,
`accounts_need_review`.

The button takes the loudest one's colour. The whole list opens **on hover and on
focus**, most significant first, each row a `Tag` in its own tone above the
sentence that names the bank or the accounts.

**The list is reachable, not merely visible.** Every row is still a link to where
its condition is dealt with, which is what the tags it replaces were — so the
panel takes the pointer instead of refusing it, and hangs from a padded wrapper
rather than a margin: a bare gap between button and card drops `:hover` as the
mouse crosses it, closing the panel on the way into the thing being reached for.

**The line is what the import is responsible for, not what happens to mention an
account.** A categorization backlog, a cheque to confirm, a row to clear, an
overdue bill, a line behind its target, a stale Bitcoin price, a failing backup,
a stalled snapshot — none of those is anything the bridge did, and burying them
inside a button about the bank would be hiding them rather than tidying them.
They stay tags. So does the budget's own reading, which is the thing the
household opens the application for.

**The shell has no primary.** Delegate is `default`. What is coloured in the
control zone is a button reporting a **state** — red on Undo Delegation while a
run can still be taken back, and whatever the feed currently is on Sync — and
Delegate has no state.

**On a phone every notification is one coloured dot** beside the page title,
carrying the loudest tone, opening the whole list as a `Modal` on a press. The
feed's own are _unfolded_ there rather than dropped: there is no Sync button
below `sm` to fold into, and an alert that is on screen on a laptop and nowhere
at all on a phone is the exact failure `Alerts`' `inline` case exists to prevent.

Colour is not left alone to carry it (design.md §9): the dot's accessible name is
the count, and everything behind it is words.

## Consequences

- **`components/notifications.ts` is new**, and holds the DTO, the urgency order,
  `byUrgency`, `loudest` and `SYNC_KINDS`. Two components ask the same question
  now — the sidebar's column and the Sync button's fold — so the question lives
  somewhere neither of them owns. `Alerts.test.ts` moved with it.
- **The Sync button merges two sources.** `/api/sync/status` is re-checked every
  minute and `/api/notifications` every five, so a run that has just failed shows
  from the status first; it is matched on `kind` and drops out once the
  notification arrives with its own fuller message, so the same failure is never
  listed twice.
- **The panel is the only place those sentences exist**, which is why it opens on
  focus as well as hover, and why the e2e suite asserts that separately. A fold
  that a keyboard could not open would have hidden a failing bank feed outright.
- **The native `title` is gone from the expanded button.** It would open on the
  same hover as the panel, on top of it, saying less. The collapsed rail keeps
  one, and it only names the control: there a glyph is all it has.
- **`Tile` gained `lead`**, the header's left-hand track for a tile whose name is
  carried by being the page's first block rather than by a heading. It is the
  budget band's cycle stamp, and nothing else uses it. Never `lead` and `title`
  together: they are the same track.
- **Overview loses Arrange below `sm`**, and `arranging` is read from the width
  as well as the URL so a window dragged narrow cannot strand somebody in a mode
  whose "Done" has gone. What that frees, with the alert dot, is what gets New…,
  the period picker and Delegate onto one line above the band.
- **Overview's window picker is `sm` on a phone**, which is the one exception to
  `ui-system.md` §5's "one size". At `md` its four options are 212px, and beside
  New… and Delegate that is 378px on a 343px line.
