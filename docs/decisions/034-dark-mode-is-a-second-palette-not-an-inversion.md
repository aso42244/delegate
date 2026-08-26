# 034. Dark mode is a second palette, not an inversion

**Status:** accepted
**Date:** 2026-08-25

## Context

The owner asked for dark mode as an option in Settings.

Settings → Display already existed and already held exactly this kind of
preference: row height, stored per device rather than per household, because it
describes the screen somebody is looking at rather than the budget. A theme is
the same kind of fact — one person reading in a dark room must not put the other
person's phone into dark mode — so it belongs beside it and is stored the same
way.

## Decision

**Three choices: System, Light, Dark**, stored in `localStorage` under
`budget.display.theme`, applied before React renders so the page is not painted
light and then repainted dark.

**System is resolved in JavaScript, not in CSS.** The stylesheet carries one dark
palette, keyed on `data-theme="dark"`, and `theme.ts` decides when that attribute
goes on — including a `matchMedia` listener so "System" keeps meaning the system
rather than whatever it said when the tab was opened.

The alternative is a second `prefers-color-scheme` block holding the same
twenty-five colours, because a media query cannot be added to a selector list to
avoid the duplication. Two copies of a palette drift, and the drift shows up as
one screen in the wrong grey — which is precisely the class of problem
[ADR 033](033-one-ui-system-with-a-test-that-holds-it.md) exists to end.

A three-line `prefers-color-scheme` block remains, setting only the page ground
and only while no attribute has been stamped, so a dark-preferring device does
not flash white on first paint.

**The palette is rotated, not inverted.** The light theme's warm neutral greys
get warm dark counterparts, so the application reads as itself with the lights
off rather than as a second design.

**Every accent is lifted.** The light values are tuned against white and sit at
2–3:1 on a dark canvas, which is the usual way a dark mode ends up unreadable.
`--color-on-accent` is new and moves the other way: the accent fill is now light
enough that the white text that sat on it would not clear 3:1.

**`color-scheme: dark` is set on the root**, so the browser draws checkboxes,
selects, date pickers and scrollbars dark. Without it those stay white
rectangles in an otherwise dark page — the detail that makes a dark mode look
half-finished.

## Consequences

**The QR code stays white in both themes.** It is scanned rather than read, and
inverting it is the one change that stops a camera seeing it at all. Said in a
comment at the element, because it looks like an oversight otherwise.

**Grouping colours lift too.** They are row tints and chip text, and the light
values disappear against the dark canvas. The owner's chosen hues are preserved
in relationship, not in hex.

**Nothing is stored on the server**, so there is no migration and no setting for
an administrator to get wrong. The cost is that a new device starts at System
until somebody chooses, which is the right default anyway.
