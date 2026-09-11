# 064 — The corner of the screen answers one question

**Status:** accepted
**Date:** 2026-09-11

Amends [ADR 059](059-one-tag.md), which made the budget's reading the last tag in
the sidebar's alert column, and [ADR 063](063-the-feed-reports-in-its-own-button.md),
whose "colour in the control zone means a control is reporting a state" this
completes by giving the one control that _has_ a state a colour of its own.

## Context

The foot of the sidebar had four things in it and they were drawn as three
groups: a tag stack ending in the budget's reading, a ruled block holding
Delegate and Sync SimpleFIN, and a second ruled block holding the signed-in
address, the account's role, and a borderless Sign out.

Three problems, in the order they matter.

**The reading was the quietest thing in the corner.** Balanced / To delegate /
Over-delegated is what this household opens the application for, and it was a
13px pill — the same object as "1 account not reporting" — sitting above two
buttons that were larger, bolder and bordered. The thing being read looked like
an annotation on the things that act.

**It was also a dead end.** A reading that says `Over-delegated $240.00` is a
prompt to go and look at the lines, and it went nowhere: the owner read it, then
navigated to Overview by hand. `AlertTag` can be a link and every notification is
one; the reading was the only tag that reported something and offered no way to
it.

**Sign out was drawn as furniture.** `ghost` — no outline — under its own rule,
below a name and a role that are on Settings → Users and are not a question
anybody has while looking at a budget. And it was the only control in that corner
that did not ask before doing anything, 8px under the bank sync that gets pressed
several times a day, with a full page load behind it and no undo.

## Decision

**One group of four, under one rule.** The reading, Delegate, Sync SimpleFIN,
Sign out — 8px apart, all the same 28px face, all with the same `border-line`
outline. The divider between Sign out and the button above it said there were two
groups where there is one, and it is gone with the identity block above it.

**The reading is the top of that group and the only thing in it that is always
coloured.** Green when balanced, blue when there is money to delegate, red when
over-delegated. Everything below it is plain until hovered, or until the bank
feed has something to report (ADR 063). So a glance at the corner answers "where
does the budget stand" and nothing competes for it.

**Three states, three colours.** Over-delegation used to be yellow inside twice
the tolerance and red beyond it. That split is gone: over-delegated is the
direction that is genuinely wrong at any size, and this is now a control read at
a glance rather than a tag compared against its own past. Four colours on a
three-state reading also left it unable to say the two states that are _not_
faults in colours anybody would read as "fine".

**It goes to Overview whatever it says** — not only when something is wrong. A
control that is a link on the bad days and inert on the good ones is one nobody
learns to press, and the lines it is about are on Overview either way.

**Colour means a state; a hover means a consequence.** Delegate and Sign out have
no state, so no colour — but one distributes a pay packet and the other ends the
session, and 8px apart they should not look identical right up to the moment they
are clicked. Delegate tints blue on hover, Sign out red. Background and text
only: the outline stays `border-line` on all three, which is what makes them read
as one set.

**Sign out asks.** Same argument the other three already made and the strongest
case of the four: it is a full page load, so a misclick costs the session and
everything typed into it, with nothing to come back to.

**The signed-in address and role are gone from the sidebar.** They are on
Settings → Users, which is where an account is administered. `w-fit` sizing also
means an email address is the widest thing anybody could put in that column,
which is why it needed a cap in the first place.

## Consequences

- **`--color-accent-line` and `--color-positive-line` are new.** Warning, danger
  and confirm each had one; accent and positive did not, because nothing had yet
  drawn a soft blue or green _control_. The reading is the first.
- **`Button` gained `positive` and `info` variants and a `hover` axis.** `hover`
  is deliberately not a variant: `variant` is the state a control is in, `hover`
  is what pressing it will do, and collapsing the two would make "blue" mean both
  "there is money to delegate" and "this button delegates it".
- **`buttonFace()` is exported**, because the reading is a `Link` — it goes
  somewhere — and a link drawn by hand beside three buttons is how a set stops
  looking like a set.
- **`ControlPopover` is extracted.** Sync's folded alert list and the reading's
  arithmetic are the same object: a panel that hangs above a control at the foot
  of the sidebar, takes the pointer so its links can be reached, and opens on
  hover and on focus.
- **`role="status"` moved inside the link and the link is named explicitly.**
  `status` does not support name from content, so the words inside it do not
  reach the link — without an `aria-label` it announces as an unnamed link. The
  end-to-end suite could not find it by name either, which is how this was
  caught.
- **The reading keeps its tag form on a phone.** There is no sidebar below `sm`
  and so no control zone; `BalanceReading` stays beside the page title, one tone
  and one set of words with the button, computed once in `read()` so the two
  screens cannot disagree about one budget.
- **Settings → Users keeps an unconfirmed Sign out.** It is three navigations
  deep, nowhere near anything else, and on a phone it is the only route there is.
- **`Alerts` renders nothing when there is nothing to report.** It used to always
  have the reading as a floor.
