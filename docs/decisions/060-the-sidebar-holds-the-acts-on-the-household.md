# 060 — The sidebar holds the acts on the household

**Status:** accepted
**Date:** 2026-09-11

Extends [ADR 059](059-one-tag.md), which moved the alerts and the budget's own
reading to the foot of the sidebar on the grounds that they are not facts about
the page they happen to be sitting on.

## Context

Delegate was the Budget page's primary button, and `ui-system.md` §5 named it as
the example of the rule: one primary per screen, and it is the thing you came to
that screen to do.

That was right while Budget was the only screen it could be pressed from. Two
things have since made it wrong.

**The figure it acts on left the page.** ADR 059 put `To delegate $1,240.00` at
the foot of the sidebar and made it always last, so the reading that says whether
to press Delegate is now on every screen while the button was on one.

**The undo offer expires wherever you are.** A press can be taken back for twelve
hours, and the only sign of that was a red button on a page somebody has to
already be looking at — most often not the register, which is where a wrong press
is noticed.

The owner asked for it moved to the sidebar, directly above Sync SimpleFIN, and
named the hazard that creates: two full-width buttons 8px apart, one of which
distributes a pay packet.

## Decision

**Delegate joins the sidebar's control zone, above Sync SimpleFIN.** Below the
alerts and the reading, above the sign-out block. It is an act on the household
rather than on a page, which is what Sync already is and what the alerts were
found to be.

**Both controls in that zone confirm.** Delegate always did. Undo Delegation did
not — it fired on the press — and in this slot that is the same hazard: an
accidental undo takes a whole distribution back out of the envelopes and rolls
the cycle with it, and nothing about that is recovered by pressing the same
button again. A misclick now costs a dialog either way.

**The shell keeps a primary, and pages therefore do not.** `ui-system.md` §5's
rule stands; what changes is whose primary it is. Delegate is the household's,
not a page's, and no page adds one beside it. `danger` on Undo Delegation is the
matching exception to "never sitting on a page".

**Below `sm` it falls back to `PageHeader`**, exactly as the alerts do and for
exactly their reason: there is no sidebar on a phone, and a control that lived
only there would take the act this application is named for off the small screen
entirely. Sync gains no such fallback — it did not have one and this is not the
change that gives it one.

**The Sync button carries its own state.** The caption under it is gone. "Synced
12m ago" is a figure nobody acts on, and "Last sync failed" was a second line
saying what a colour can say on the control somebody would press about it. A
failing run turns the button `warning` yellow, with the bridge's own recorded
error on its `title` — and on the collapsed rail the title carries the control's
name as well, because there a glyph is all it has.

## Consequences

- **The Budget page's header is a title and nothing else.** Its subtitle went
  with the button: what was delegated is said under the button now, capped and
  wrapping like everything else of uncontrolled length in the sidebar.
- **Two `DelegateControl` instances are mounted at once**, one in the sidebar and
  one in the header, and CSS decides which is drawn. That is how `Alerts` already
  works, and it is safe for the same reason: a `display: none` element is out of
  the accessibility tree, so exactly one is ever findable. The shared
  `undo-preview` query key means they cost one request between them.
- **`DelegateDialog` left `pages/MainBudget.tsx`** for
  `components/DelegateControl.tsx`. ADR 057's rule — a dialog lives with the
  screen that owns the thing it makes — is unchanged; what owns Delegate is now
  the shell.
- **A failed run with no error text still says something** — "The last sync
  failed." rather than an unexplained yellow, because the colour has to be
  accounted for even when the bridge wrote nothing down.
- The error the button reveals is the most recent run's own, which is the run
  `failing` is computed from. A second place reading `runs[0]` is a second place
  that has to agree about which run is latest; both take it from the same ordered
  response.
