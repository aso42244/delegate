# 049. A duplicate is proposed, never archived

**Status:** accepted
**Date:** 2026-09-02

## Context

Reconnecting an institution at the bridge changes every account's external id.
Delegate matches imported rows on that id, so the accounts come back looking new
— and so do their transactions. A card's whole recent history arrives a second
time.

This is written down in `docs/handoff.md` as something that happened, not as a
risk. `upsertAccount` was taught to adopt an account whose id the feed no longer
mentions, which fixed the accounts. The transactions were left: archiving one has
been possible from the row menu since v0.29, but only a duplicate somebody had
already noticed.

Which in practice means noticing that a balance is wrong and working backwards.
Every figure in the application is wrong in the meantime, and nothing anywhere
says so.

## Decision

**A reading over the register, proposed and never applied.** Two rows in the same
account, for the same amount to the cent, within two days, neither archived.

It writes nothing. Archiving reverses whatever envelope movement a row caused,
and a machine picking wrongly between two identical rows is not something to
discover later — the same line drawn for a cleared check
([ADR 030](030-a-cleared-check-is-confirmed-not-assumed.md)), a transfer pair
(§7), and a suggested delegation
([ADR 044](044-the-queue-teaches-the-rules.md)).

**The match is narrow, and every loosening was refused:**

- **A near amount is not a duplicate.** $42.10 against $42.09 is a fee or two
  purchases, and both readings need a person.
- **A different account is not a duplicate.** The same amount leaving two owned
  accounts on one day is what a transfer looks like, and there is already a
  proposal for that. Offering to archive half of one would be wrong in a way that
  is expensive to undo.
- **A different description still is one.** A feed rewords its own text between
  the pending and posted versions of one purchase, so matching on description
  would miss the commonest case there is.

**Two days, not one.** A re-import lands on the same day, because the day comes
from the feed with everything else. The slack covers a pending row that settled
and its re-imported twin arriving against the settled date, without reaching far
enough to sweep in something that genuinely bills twice a week.

**Both rows are shown, and the one carrying a categorization is marked.**
Archiving that one puts money back in an envelope; archiving the other does not.
Both are offered, because the copy that carries the decision is sometimes the one
worth keeping.

**A pair that came back with different external ids is marked `re-imported`.**
That is the signature: a genuine second identical charge on one day carries one
id from the feed and appears once.

**Each row is named once.** Three copies are two proposals rather than three,
because confirming one changes what the others mean.

## Consequences

**No header pill, and the dismissal lasts a session.** A pill was built and taken
out within the hour: it is computed on the server from the rows, so it went on
saying "1 possible duplicate" after the panel had been waved off, and the two
disagreed on screen. ADR 030 gives the reason not to fix that by storing the
refusal — a remembered "no" needs its own clearing rules and its own bugs.

Nothing is lost. A re-import arrives as _uncategorized_ rows, so the backlog pill
already leads to the page where these are dealt with.

**Two genuinely identical charges are proposed for ever.** Two coffees on one
card on one day will be offered again on every visit, and waving it off lasts
until the tab is closed. That is the cost of not storing a refusal, and it is the
same cost the pair suggestions have carried since they shipped.

**The ordering has an arbitrary tie-break, deliberately.** The original is the
earlier posting date, then the earlier `created_at` — which is what separates a
re-import, months apart, from its original. Where both are identical the rows
genuinely cannot be told apart, and `id` decides so that the answer is at least
_stable_: without it the pair would swap sides between two reads of the same
data, and the button that says "archive the later one" would archive a different
row each time.
