# 073. A maximum is the half of a target that writes

**Status:** accepted
**Date:** 2026-09-22

## Context

The owner asked for it in his own arithmetic:

> If a delegation's max is $400 and I delegate $200 per paycheck, and the current
> amount is $275, then when I hit delegate only $125 would go into the delegation
> and the remaining $75 would remain available for other things.

This is the case a fixed amount to delegate cannot express. A sinking fund for
car repairs wants $200 a paycheck until it holds $400 and nothing after that; the
line as it stood offers "$200 every time" or "nothing, and remember to type it
back in". The household's actual answer has been the second one — edit the row on
payday, put it back a fortnight later — which is by-hand arithmetic of exactly
the kind [ADR 047](047-a-target-never-moves-an-amount.md) removed at the other
end of the same line.

[ADR 047](047-a-target-never-moves-an-amount.md) is the reason this needs a
decision rather than a column. That ADR's whole content is that **a target never
moves an amount to delegate**: the figure is the household's, typed by hand, and
an application that rewrites it is moving real money for a reason nobody asked
for and nobody sees until afterwards. A maximum plainly does change what a press
moves. The question is whether that contradicts the promise.

## Decision

**It does not, because it caps a different number.** A target judges the amount
to delegate; a maximum caps the **balance**. What the household typed stays
exactly what they typed — on the row, in the database and on the next payday —
and what a press moves is whatever of it still fits. `amount_to_delegate_cents`
is never written by this feature, which is the promise ADR 047 actually made.

That distinction is not a technicality, it is what makes the feature safe to
leave alone. A maximum needs no undoing when the line is spent down: $400 capped,
$300 spent, and the next press puts the full $200 in by itself. A feature that
rewrote the amount would have to remember to put it back, and would be wrong
every fortnight it forgot.

**The two are one subject read from opposite ends** — a floor a line is working
towards, a ceiling it stops at — so a maximum is drawn exactly as a target is: a
quiet chip by the name saying one exists, the reading on the figure it acts on, a
dialog from the row menu, and the arithmetic in `@budget/shared` so the dialog,
the row and the run cannot give three answers.

### The money goes nowhere

**What a maximum holds back is not redistributed.** It is not pushed into the
next line, not spread across the others, and not quietly absorbed. It simply is
not delegated, so the budget's own reading — `To delegate $75.00` — rises by
exactly that much and offers it back.

This is the whole reason the feature works without any new machinery. The
identity already says what has landed and not been distributed; a line that stops
taking money makes that number larger, and that number is the one the household
reads on payday. Anything cleverer would be inventing a second allocator beside
the one the owner presses himself.

**The confirmation says so out loud.** The total in the Delegate dialog is
already net of every maximum, which makes it smaller than the To delegate column
on the page adds up to — and the figure it disagrees with is one the household
typed. So the dialog states what was held back and where it went: _"$75.00 is
held back by a line at its maximum and stays available to delegate."_ A figure
quietly reduced, with nothing on screen to say why, is the sort of number
somebody reconciles by hand and then stops trusting.

### Only Delegate is capped

**A transfer, a refund or a manual adjustment may take a line past its maximum,
and none of them is refused.** None is a distribution, and a cap that rejected a
refund would be losing money to enforce a preference. `roomCents` is therefore
floored at zero rather than reported negative: a line over its ceiling has no
room, and a negative number there invites somebody to add it up with something.

A negative amount to delegate — a line set to take money **out** every cycle — is
untouched for the same reason. A ceiling is about not putting too much in.

### The shape of the data

**One nullable column, `max_balance_cents`, and one check constraint.** Null is
no maximum, which is what every existing row gets and what nearly every row will
stay. Zero is refused, in the domain with a sentence and in the database with a
constraint, for the reason a zero target is: it would be an instruction never to
fund the line, which an empty amount to delegate already says — and says without
making every future press silently do nothing.

**It stands on its own.** A target is three fields that constrain each other, and
resolving them once as the values to be written is the correction that ADR 047's
amendment records. A maximum needs none of that: nothing else has to be sent with
it and it clears nothing else, so the update path takes it as an ordinary
optional field.

**No constraint ties it to the target.** A target above a maximum is coherent —
fund to $400 a payday and top the rest up by transfer — and refusing it would be
the application deciding how a household may use its own two numbers. It is far
more often a figure typed into the wrong box, though, so the dialog says so in
one line rather than refusing: _"delegating alone will never reach it. A transfer
still can."_

## Consequences

**The arithmetic lives in `@budget/shared`**, as `amountThatFits` and
`maximumProgress`, beside the target helpers. `previewDelegate` and the run go
through the first, the read model through the second, and the dialog through both
— so what a dialog promises is what the ledger records. A second copy would be a
second answer, and this one would be a second answer about money that moved.

**A capped line still gets its event, at the capped amount**, including an event
of zero when the line is full. That is exactly what a line set to an explicit $0
has always done, and it keeps `lineCount` meaning what it has always meant: the
lines this press considered. Undo reverses what was written, so a capped press
undoes to the balance the line actually held.

**The chip is `mx`.** `m` is spent on a manual account and both kinds of row sit
on the Budget page together, so two letters, which the vocabulary already allows
for `sp` and `tg`. Quiet rather than yellow: a full envelope is this feature
working, and §9 keeps yellow for a thing to do.

**It reaches Overview for free.** The band at the top of Overview and the Budget
page draw the same `DelegationsTable` (`ui-system.md` §11a), so a mark added to
the shared vocabulary appears on both screens or on neither — which is why the
owner's request for "a visual clue on the Overview page" is a chip in `chips.ts`
rather than anything on Overview itself.

**Settings → Delegations edits it, where it only reads a target.** That asymmetry
is deliberate and is about the explanation rather than the capability: the target
dialog is mostly a paragraph about what a target does not do, and a terser second
editor would be that paragraph missing. A maximum is one figure that does what it
says, so §9.5 applies straightforwardly and it is an ordinary money box beside
the amount it caps.

**The read door carries it.** `GET /api/read/budget` sends `max` present and null
on a line without one, like the check fields beside it — a key that is sometimes
absent and sometimes null is two shapes for one thing.
