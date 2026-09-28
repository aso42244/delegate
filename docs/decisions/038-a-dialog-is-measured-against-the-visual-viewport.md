# 038. A dialog is measured against the visual viewport

**Status:** accepted
**Date:** 2026-09-01

## Context

The owner sent a screen recording of the categorization sheet on a phone: tap
Categorize, the keyboard comes up, and most of the sheet is underneath it. The
list could not be read and neither button could be pressed.

Measured at 390×844 with the keyboard taking the lower 414px, the sheet ran from
y=264 to y=844. Only its first option was above the fold. Cancel sat 361px below
the edge of a screen that does not scroll to reach it.

The cause is not the sheet. It is an assumption underneath every dialog in the
application, and it is wrong on every phone:

- **The layout viewport** is what CSS lays out against. `position: fixed`,
  `inset-0`, `100vh` and `45vh` all mean this one.
- **The visual viewport** is the part of it currently on screen.

On a desktop they are the same rectangle, which is why nothing showed this in
three years of the pattern being fine. On iOS a software keyboard is composited
_over_ the page rather than given space beside it: the layout viewport keeps its
full 844px and the visual viewport shrinks to 430. A sheet anchored to the bottom
of the window is anchored behind the keys.

Every dialog in Delegate is the same `Modal`, and eleven of the twenty call sites
contain a text field, so this was one defect in twenty places. The sheet is
simply where it is worst, because that dialog focuses its field on open and so
_always_ has the keyboard up.

## Decision

**`Modal` sizes its overlay from `window.visualViewport`,** taking `offsetTop`
for its top and `height` for its height. `inset-0` stays as the class, so a
browser without a visual viewport — and a pointer, where the two rectangles are
identical — gets exactly what it had. `top` and `height` win over `bottom` when
all three are set, which is what makes the override a narrowing rather than a
rewrite.

`resize` and `scroll` are both subscribed: the first is the keyboard opening, the
second is Safari sliding the visible rectangle up to reveal a focused field,
which moves it without resizing it.

**A dialog becomes a column: header, scrolling body, optional pinned footer.**
Bounding the card to the visible rectangle stops it being drawn off-screen, but
on its own it would put the buttons at the bottom of a scroll region instead —
reachable, but only by scrolling past the list to find them. The footer is for
whatever must be reachable from anywhere in the body: the buttons, the verdict
that enables them, and the errors they raise.

**Nothing nested scrolls.** The picker's list gave up `max-h-[45vh]`, which was
both a second touch scroller inside the first and a share of the very viewport
the keyboard had invalidated.

## Alternatives

**`100dvh` / `svh`.** The dynamic viewport units track the browser's own
retracting chrome, not the keyboard. On iOS Safari `dvh` is unchanged when the
keyboard opens, so this fixes nothing here.

**`interactive-widget=resizes-content` in the viewport meta.** Makes the layout
viewport shrink for the keyboard, which is exactly what is wanted — and is
Chrome-on-Android only. Safari ignores it, and Safari is the browser the owner
holds.

**Scroll the focused field into view on focus.** Treats the symptom, moves the
sheet around under the user's thumb, and still leaves the buttons off-screen.

## Consequences

The condition cannot be produced in Chromium, which has no software keyboard. The
regression test stubs `window.visualViewport` to the shape iOS gives it — a
window still 844 tall with 430 on screen — because the _disagreement between the
two rectangles_ is the whole of the bug, and that is reproducible exactly.

Verified failing before the fix and passing after: the sheet's bottom edge was
844 against a visible 430.
