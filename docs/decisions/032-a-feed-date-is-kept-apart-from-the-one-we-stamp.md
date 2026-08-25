# 032. A feed's date is kept apart from the one we stamp

**Status:** accepted
**Date:** 2026-08-25

## Context

Ten charges on the household's credit card sat marked `p` for days after the
card's own website showed them posted. The report was that Delegate had stopped
clearing pending transactions.

It had not. Every settlement path works and each is covered: the same id
re-reported as settled updates in place, a new id on settlement is matched to the
pending row on account, exact amount and date proximity, and a pending row that
disappears matching nothing is reversed. A pending row the feed still reports as
pending is deliberately left alone, and `sync.test.ts` pins that.

The arithmetic settled it. The stored card balance was $5,609.83; the ten stuck
rows summed to $811.97; the card's posted balance was $6,421.80. The balance and
the pending set were consistent with each other **and both were behind**. The
bridge was reporting the connection healthy and answering every request
promptly — with a snapshot several days old.

So the application was right about everything it had been told, and had no way to
show that what it had been told was old. The one fact that would have shown it —
the `balance-date` the feed sends with every account — was being folded into
`balanceAsOf` and lost:

```ts
balanceAsOf: feedAccount.balanceAsOf ?? now,
```

That column answers two questions with one value. When the feed sends a date, it
holds the feed's date and is honest. When the feed does not, it holds the time of
our own request. Afterwards the two are indistinguishable: _the bridge says this
balance is current_ and _the bridge said nothing and we filled it in_ are the
same row.

This is the shape of failure this project keeps meeting. A nightly backup failed
for weeks because the question asked was "did the attempt throw" rather than "is
there a dump on disk". The tor container crash-looped for a fortnight because the
only symptom was a message that also appears when nothing is wrong. Each time,
something recorded that we had acted rather than what we had learned.

## Decision

**`accounts.feed_balance_as_of` holds what the feed said, and nothing else.**

Written only from `balance-date`, null when the feed omits it, never filled in
from the clock. `balanceAsOf` keeps its existing meaning and its existing
fallback — manual accounts confirm by hand and the staleness interval still reads
it — so nothing that worked before changes.

The new column's value is precisely that it can be **null**. Unknown is a third
state, and one column with a fallback cannot express it.

**`isFeedBalanceStale` is a separate question from `isBalanceStale`.** One asks
how old the institution's answer is; the other asks when a person last confirmed
a figure by hand. A bridge can reply within the second with a snapshot from
Tuesday, so neither answers for the other.

**The threshold is two days, not one.** Bridges refresh roughly daily and the
household's own bridge says transactions "often take a few days to appear". A
one-day threshold would mark most accounts most mornings, and a warning that
fires in the ordinary case is one nobody reads — which is how the backup failed
in plain sight.

**Null is not stale.** A feed that sends no date says nothing about the age of
its answer. Manufacturing a warning from silence is the same error as
manufacturing freshness, pointed the other way.

**The `s` chip widens rather than a new chip being added.** It read "Not
confirmed recently", which was written for a manual balance. It now reads
"Balance may not be current", which is true of both cases. One letter, one
meaning still holds; the meaning was always this and the wording was narrower
than it. `docs/design.md` carries the amendment.

**The date itself is shown beside the mark on Settings → Accounts**, and only
when it is old. A chip alone sends somebody looking inside the application for a
fault that is not there. Naming the day the institution's own answer came from
moves the question to the bridge, where it can be acted on.

## Consequences

**Existing rows are null until their next sync.** The feed's date for a balance
already stored cannot be recovered, and inventing one would recreate exactly the
ambiguity this removes.

**A bridge that lies is still undetectable.** If a feed stamps an old snapshot
with today's date, nothing here catches it. That is not a gap this can close —
it is the limit of trusting a remote source at all. What has changed is that the
common case, a bridge honest about its own staleness, is now visible instead of
silently absorbed.

**No banner.** The staleness notification still keys on the manual interval,
which is opt-in per account. A synced account a few days behind is ordinary, and
raising a banner for it would train the owner to dismiss banners. The signal
lives on the page somebody visits when they are already asking the question.

**Nothing about the pending lifecycle changed**, because nothing about it was
wrong. The charges in the report were left to settle on their own when the bridge
catches up, which is the correct handling and was already the behaviour.
