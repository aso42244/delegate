# 065 — A dashboard you can work from

**Status:** accepted
**Date:** 2026-09-12

Amends [ADR 063](063-the-feed-reports-in-its-own-button.md), whose folded panel
is now the quiet case's home too, and
[ADR 064](064-the-corner-answers-one-question.md), whose reading keeps its
control on a laptop and loses its words on a phone.

## Context

Three things on Overview reported, and one of them reported nothing at all.

**The backlog tile was a notification.** A count, "Waiting, oldest 1d", and "Open
the queue →". The owner reads it on the screen he opens every morning, and then
navigates away to spend forty seconds filing three charges. Categorizing is the
highest-traffic act in this application — `DelegationPicker`'s own note puts it
at several hundred in a sitting at go-live — and the dashboard that announces the
work could not do any of it.

**The Sync button said nothing on a good day.** ADR 063 folded the bank feed's
conditions into it, and there are nearly never any, so for most of its life the
panel did not open at all. The useful thing then is that it ran and what it
brought back — which had been a caption under the button until ADR 060 removed it
as "a figure nobody acts on". That was right about the caption and wrong about
the figure: it is worth a glance when somebody wonders, which is exactly what a
hover is for.

**The phone header was still spending a third of itself on a reading.** ADR 064
left `Balanced` / `To delegate $1,240.00` as a tag beside the title, and a period
picker sat under it. Both cost a row of the screen this household reads most,
whose whole point is the band underneath.

## Decision

**The backlog tile is the register's own row, without the register.** Date,
payee, amount, and the same type-ahead with the same suggestion leading it.
Choosing files the charge and the row leaves, because the list is "what is still
waiting". The first five, the count of the rest, and a link to the full queue —
sixty charges is a session at the register, not a tile on a dashboard.

Its rows are its own query rather than a field on the overview payload. The
payload carries a count, which is what a figure needed; rows have a different
lifetime — they change as they are filed — and refetching them must not pull the
whole dashboard through again. The band's balances list already works this way.

**The Sync button's panel has two readings and shows whichever applies.**
Conditions when there are any; otherwise when it last ran and what it found. The
wording is coarse on purpose — "12m ago", "3h ago" — because nobody acts on the
difference between 41 and 43 minutes, and a figure that changes every time it is
looked at reads as noise.

That reading is keyed on **runs, not on configuration**. A run that finished is
the thing being reported; `configured` answers a different question, and gating
on it would have made this impossible to prove end to end — the access URL is
encrypted with the deployment's data key and no test can write one.

**The period picker is gone from a phone.** Every tile it changes is hidden below
`sm`, and the band is cycle-shaped whatever it says, so it was a control costing
a third of the header and moving nothing visible. `window` stays in the URL, so a
link into a period still opens in it.

**The reading on a phone is a circle of colour and nothing else**, beside the
alert dot it matches: the two marks in that corner are "where the budget stands"
and "what needs attention", and neither is a sentence a 375px header has room
for. What that frees puts New… and Delegate on the title's own line.

Its words are **a press away, not a hover away**. A tooltip is a pointer's
gesture and a touchscreen cannot open one, so this is a button and a sheet rather
than an `AlertTag` — and the sheet carries the reading _and_ its working, which
is more than the tag ever gave anybody without a mouse.

## Consequences

- **`components/sync-status.ts` is new**, holding `describeSync`, `agoLabel` and
  `readSync`. `agoLabel` has a test because "an hour ago" at 59 minutes and "1d
  ago" at 25 hours are precisely the boundaries a hand-rolled duration gets
  wrong, and a clock drifted ahead of the browser's must read as "just now"
  rather than as a negative.
- **`components/BacklogQueue.tsx` is new**, and `BacklogTile` on Overview is four
  lines that defer to it. It invalidates transactions, suggestions, budget and
  overview by key on a successful filing — money moved, so the reading in the
  corner and the count this tile used to be are both stale — and leaves the
  charts alone, which did not change.
- **The reading is two components with one `read()`**, as before: a control on a
  laptop, a circle on a phone, one tone and one set of words. What changed is
  that the phone's half is no longer a `Tag`.
- **`AlertTag` has one caller fewer.** It is still the notifications' face; the
  budget's reading no longer uses it on either screen.
- **A phone cannot change Overview's period.** Deliberate: there is nothing there
  whose figures it would change. If a phone-visible tile ever appears, this comes
  back with it.
