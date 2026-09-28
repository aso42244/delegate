# 040. Every notification is a pill

**Status:** accepted
**Date:** 2026-09-01

## Context

[ADR 039](039-a-bar-is-for-what-costs-data.md) moved six of the eight
notification kinds into header pills and kept the full-width bar for the two
`danger` conditions — `backup_failing` and `sync_failing` — on the argument that
the only copy of the household's data being at risk earns the width.

The owner deployed that and asked for red to be a pill too.

He is right, and the argument for the exception was weaker than it looked. It
conflated _how serious this is_ with _how much of the page it should occupy_, and
those are separate. Severity is already carried twice, in the colour and in the
wording, which is the rule everywhere else in this application — the budget
reading, the chips, the status lines, all of them say their state in words as
well as in colour so that a reader who cannot separate the two still gets the
answer. The bar was saying it a third time, in floor space, and charging the
Budget page a row for it.

There was also a practical cost. Red is the state you most want the owner to keep
looking at, and a bar is the shape people learn to scroll past. A pill that sits
permanently beside the budget's own reading, in the row he reads on every visit,
is not obviously less noticed than a band he has trained himself to skip.

## Decision

**One shape for all eight.** `HeaderPill`, in the page header, in the tone the
severity names. `NotificationBanners` is gone, the app shell renders nothing
above the page, and the component is `NotificationPills`.

**Snoozing goes with the bar.** It existed because a bar was in the way — and it
was a snooze rather than a clear, so the interface never told a lie on the
owner's behalf about a condition that still held. Nothing is in the way now, so
there is nothing to put away, and what makes a pill go away is fixing the thing
it is about. That is strictly stronger: a red condition can no longer be hidden
for a day at all.

**`actionLabel` goes too.** It was the text of the bar's link — "Backups",
"Sync", "Review". A pill _is_ the link, so a second label for it had nothing left
to name.

## Consequences

A red condition is now a pill among pills, and on a day with three of them the
red one is distinguished only by its colour and its words. That is the same
distinction every other state in the application relies on, so if it is not
enough here it is not enough anywhere — but it is worth knowing that this is the
one thing the change gives up.

The backup notification is the one to watch. It is the only condition here that
can cost the household its data rather than its accuracy, and it fires on a
deployment that has been running longer than one backup cycle with no recent
dump. If it ever turns out that a pill is not enough to get it acted on, the
answer is a louder pill or an email, not a bar — the bar has now been tried.
