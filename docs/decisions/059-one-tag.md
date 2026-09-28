# 059 — One tag, and the alerts live in the sidebar

**Status:** accepted, amended by [063](063-the-feed-reports-in-its-own-button.md) and [064](064-the-corner-answers-one-question.md)
**Date:** 2026-09-10

Extends [ADR 039](039-a-bar-is-for-what-costs-data.md) and
[ADR 040](040-every-notification-is-a-pill.md), which put every notification on a
pill and every pill in the page header. The pill was right. The header was not,
and the pill had quietly become a fourth kind of small mark.

## Context

Four families of small mark had grown up, each saying the same kind of thing:

|                                                    | radius | size | construction               |
| -------------------------------------------------- | ------ | ---- | -------------------------- |
| `Chip` — the letter marks beside a row             | 4px    | 11px | soft fill                  |
| `HeaderPill` — the alerts and the budget's reading | 8px    | 13px | **1px border** + soft fill |
| `BillChip` — `Due now`, `Overdue`, `Paid`          | full   | 10px | soft fill                  |
| Asset/Debt tags in Settings                        | 4px    | 11px | grey surface               |

Three radii, three sizes, two colour recipes, and `design.md` §7 already
specified something none of them matched. Nothing here was wrong on its own.
Together they were why a chip, a state and an alert read as three different
species of object.

**The border was the one that mattered.** It was the single thing making the
alerts look like a different kind of thing rather than a louder one — a row with
three chips and a status was three fills and one outline.

Separately, the header was the wrong home. The alerts are not facts about the
page they happen to be sitting on: a bank that needs a fresh login is not a fact
about the Budget page, and it was not one when it was a bar either. They also
pushed the title's own controls around as they came and went.

## Decision

**One `Tag`.** `rounded-full`, soft fill, the same hue for the text, no border,
two sizes — `sm` inside a data row, `md` standing on its own. Every chip, state
tag and alert in the application is this face. `AlertTag` adds the one thing
particular to an alert: the whole sentence, one hover or one focus away.

Fully rounded rather than the 4px `design.md` §7 asked for. That was the owner's
call between two coherent answers, and it follows the mark this system already
had most of: `Due now` and `Overdue` were fully rounded already, and a letter in
a circle reads as a mark rather than as a cut-off word.

**The alerts move to the foot of the sidebar**, above the sync button and its
separator. Ordered by urgency with **the most urgent lowest**, nearest the eye
and nearest the budget's own reading — which is always last, so the reading
somebody looks for is in the same place whatever else is being said today. A
column that grows and shrinks from the top leaves the important end still.

**A phone keeps them in the header.** Below `sm` there is no sidebar at all — the
tab bar is the navigation — so a stack that lived only there would take a sync
failure off the small screen silently, for the reader most likely to be away from
the machine that can fix it.

## Consequences

The budget's reading is now on every screen rather than only on Budget. That is
the point — it is the household's bottom line, not a property of one page — but
it means a second `role="status"` region exists alongside any a page has of its
own, and a test looking for "the status" has to say which.

A tag in a fixed-width column can be too long for it. The face truncates and the
detail carries the sentence, which is what the detail was always for.

`/api/budget` is now requested on every page. On a demo page that had been
falling through to the real household's budget — the fixture for it was written
and never wired in — so this closed a leak that nothing had yet triggered.
