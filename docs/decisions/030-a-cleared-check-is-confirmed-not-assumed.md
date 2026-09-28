# 030. A cleared check is confirmed, not assumed

**Status:** accepted
**Date:** 2026-08-24

## Context

A sync settled outstanding checks by itself. After importing transactions and
applying rules it ran `matchClearedChecks`, and any check whose exact amount and
whose number appeared as a whole token in a payment's description was cleared on
the spot: the payment allocated to the delegation the check was drawn on, the
check's holding moved back, the line archived.

The criteria were deliberately strict and the reasoning for acting on them was
written into the code — "requiring both is what makes this safe to apply without
asking". As far as anyone can tell it never settled the wrong check.

Safety was not the problem. **Silence** was.

Settling a check moves money between envelopes and archives a line. It ran
inside the hourly sync, so it happened at three in the morning with a log entry
as its only trace. The owner would come to the budget and find a check gone and
an envelope changed, with nothing on screen saying it had happened or why. The
one place it might have shown up — the delegation's history — is a page nobody
opens unless they already suspect something.

There is a second, quieter problem. The match is a judgement about the physical
world: that the piece of paper written on the 3rd is the debit that posted on the
6th. The bank's description is evidence for it, not proof. The household is the
only thing that actually knows, and it was never asked.

## Decision

**A sync proposes. A person settles.**

`matchClearedChecks` is replaced by `proposeCheckMatches`, which is a **pure
read**. It writes nothing. `clearCheck` is unchanged and is still the only thing
that settles a check — now called only from a person's click, either confirming
a proposal or matching by hand on the Transactions page.

**The criteria stay exactly as strict.** They were never the weak part. Loosening
them now that a human is in the loop would be a mistake of a different kind: a
proposal presented as "this cleared" is one somebody confirms without reading, so
a loose proposal is barely safer than a loose auto-match. An amount alone matches
any payment for the same figure; a number alone matches a coincidence in a
description. A check whose bank text never named it still goes through the manual
path, exactly as before.

**The proposal is computed on read, never stored**, like every other
notification in this application. A stored proposal needs something to clear it,
and the something is always missed. This one stops existing the moment it stops
being true.

**It is surfaced twice**, because one place would be the wrong number:

- A **banner** at the top of every page, purple, naming the checks.
- A **`Confirm it cleared` button on the check's own row**, in the slot beside
  Remaining that the absorb affordance uses — and always visible there rather
  than revealed on hover, because this is a standing state rather than an offer.
  A state nobody can see until they hover the right row is one the banner would
  be pointing at in vain.

**Purple is a new semantic colour**, and the fourth. Blue means "here is a
fact", yellow "this needs attention", red "this is wrong". A proposal is none of
those: it is something the application has worked out and will not act on until
somebody says so. `#6b3fa0` on `#f4ecfb` is 6.41:1, which sits with danger's 6.53
rather than scraping the 4.5 floor, and the dot reuses the grouping purple so the
hue is one the palette already owns.

**There is no reject button.** A proposal is recomputed from the data every time
it is asked for, so "no" would have to be remembered somewhere, and that store
would need its own clearing rules and its own bugs. The way to decline is to
categorize the payment as whatever it actually was — the transaction stops being
uncategorized, the proposal stops being made, and the check stays outstanding
holding its money. The dialog says so in as many words.

## Consequences

**A check now stays outstanding until somebody looks.** That is the cost, and it
is the point. The budget is not wrong in the meantime: the check line holds the
money, the payment sits uncategorized, and the identity is exact either way —
what has changed is that finishing it is a thing the owner does rather than a
thing that happened to him.

If the banner is ignored for weeks, the effect is an uncategorized payment and a
check line that should be empty. Both are visible. Neither is a silent error, and
that is a strictly better failure than the one this replaces.

**The banner snoozes for a day like every other**, keyed on its message, so a
second check clearing is news again.

**A `confirm` severity now exists** on the notification model. It sorts above
`info` and below the faults: not something that has gone wrong, but money in the
wrong place until somebody finishes the job.
