# 074. A bank can count its own pending charges

**Status:** accepted
**Date:** 2026-09-25

## Context

[ADR 020](020-pending-transactions-in-the-identity.md) added categorized pending
charges to the identity as a fourth term, because the SimpleFIN specification
defines `balance` as the settled balance: categorizing a pending charge empties
its envelope at once, and the account has not caught up yet. Its consequences
named the case it could not cover:

> An institution that instead folds pending activity into `balance` would now be
> corrected twice and read as over-delegated by the pending amount.

It happened on 2026-09-24. A $200.00 ACH debit from Plains Commerce Checking to
a brokerage arrived pending and was categorized. The budget went from balanced to
**Over delegated $200.00**. The bank's own app showed the debit as posted, with
the running balance beside it, and that balance was the one the feed reported. The $200 was out of the first term and the fourth term took it out
again.

Nothing about the pending lifecycle was wrong. The feed still flagged the row
pending while the institution had already moved the money; the gap closes by
itself when the feed reports it posted, and reopens on the next such debit.
Credit card charges on the same budget behaved as ADR 020 expects, which is why
this is a property of an institution and not of the feed.

## Decision

**A per-account switch: the balance includes pending.** `accounts.balance_includes_pending`,
false by default. An account marked with it is left out of the fourth term —
in `computeBudgetIdentity` and in the nightly snapshot's copy of the same sum,
which must stay the same figure the page shows.

It is set from the account's row menu — on the Budget page, on Overview's band
and on Settings → Accounts — and offered only on a synced account. A manual
account has no pending charges: every row on one is created settled and moves
the balance itself. The API refuses the switch there rather than storing a flag
that does nothing, because a switch that does nothing is one somebody turns on
while looking for the one that would have helped.

Two alternatives, both named in ADR 020 and both passed over:

- **Read `available-balance` for that account.** It is optional in the feed and
  also carries holds, so it would trade one disagreement with the bank's page
  for another, and it would change the balance shown on every screen rather than
  one term of one sum.
- **Detect it.** A balance that moved by exactly a pending amount looks the same
  as a settled charge of the same amount landing in the same sync. A guess that
  is wrong moves the reading silently, which is what ADR 020 displayed the term
  to avoid.

## Consequences

The pending term on the reading's equation now reads what it actually corrects
for. A marked account's pending charges still empty their envelopes when
categorized — ADR 009 and `pending.ts` are unchanged — and still carry across to
the posted row when it arrives. Only the correction is skipped, because the
account never needed it.

Marking an account whose institution does _not_ fold pending in reproduces the
original ADR 020 defect for that account: a categorized pending charge reads as
money available to delegate until it posts. It is visible in the same place,
and the switch is one press back.
