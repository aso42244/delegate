# 050 — The budget boundary is a wall, not a suggestion

**Status:** accepted
**Date:** 2026-09-05

## Context

An account carries two orthogonal booleans, `in_budget` and `in_net_worth`. The
house and the mortgage are net-worth-only, which is exactly why the mortgage does
not swamp the budget identity. A Roth IRA and a brokerage account are the same
shape: real money the household owns, deliberately outside the envelope budget.

The identity sums `in_budget` accounts only:

```
SUM(in-budget assets) − SUM(in-budget debts) − SUM(delegations) + SUM(pending) ≈ 0
```

Nothing enforced that boundary anywhere else. Three places crossed it, and all
three surfaced in one afternoon when a $200 Roth contribution and the four ETF
purchases it paid for arrived in the register.

**Categorizing was permitted.** `setAllocations` checked the transaction's kind
and never the account. Categorizing a $200 purchase inside the IRA moved a
delegation by $200 while no summed balance moved with it — measured at exactly
`−20000` cents of drift, from a reading of zero.

**A transfer was suggested across it.** `findPairCandidates` matched on opposite
signs, equal magnitude and five days, with a comment saying "both accounts are
owned by definition — everything here is ours." True, and not the question. The
outgoing $200 had already been correctly categorized to the envelope it was saved
in, and `confirmPair` **clears the allocations on both sides**: confirming would
have taken the money back out of that envelope while the balance stayed gone.
The suggestion was offering an action that could not be right.

**The queue held rows that could never leave it.** `uncategorized` already
excluded income and confirmed transfers, with a comment explaining that they
allocate to nothing by design and would otherwise sit in the queue "uncloseable,
for as long as the budget exists." An out-of-budget row is the same case and was
missed: five of them appeared at once, against an account whose entire purpose is
that the budget does not track it.

## Decision

**A transaction on an account the budget does not sum is not a budget event.**

- **It cannot be categorized.** `setAllocations` refuses it, so every route
  through it — single, bulk, split, rule — refuses it too. The register offers no
  field on such a row, the same way it offers none on income.
- **It cannot be paired with a transaction that is in the budget.** Both
  `findPairCandidates` and `confirmPair` require the two accounts to be on the
  same side. **Two out-of-budget accounts still pair with each other**: neither
  is in the identity, nothing that mattered is cleared, and a transfer between
  two brokerage accounts is exactly as much "not spending" as one between two
  current accounts.
- **It is not in the uncategorized queue, or in the pill that counts it.** Both
  read the same definition, because a pill leading to a list that disagrees with
  its own count is a pill nobody can clear.
- **It stays in the register.** The journal is where somebody goes to see what an
  account did. It is the _queue_ these rows leave — the list of decisions waiting
  to be made, none of which is one.

## Why money leaving the budget is spending, not a transfer

This is the part worth stating plainly, because the instinct runs the other way.

A contribution from a current account into a Roth IRA looks like a transfer: the
household owns both ends and is no poorer. But the envelope budget's subject is
not net worth — it is the money the household has left to allocate. Money that
has gone into a retirement account is no longer available to delegate, so from
the budget's point of view it has been spent, and the envelope it was saved in is
the record of that.

Marking it a transfer would exclude it from every spending figure while the
balance it left is genuinely gone. The identity would then be short by the
contribution, permanently, with nothing on screen to explain it.

The arrival on the other side is the same money seen from outside the budget.
Categorizing it as well would count it twice.

## Consequences

- **Nothing existing is rewritten.** The guard is on the write, so allocations
  made before this — including on an account later moved out of the budget —
  stand until somebody changes them.
- **Moving an account out of the budget does not clear its allocations**, and
  deliberately: that would silently move envelopes as a side effect of a settings
  toggle. It does remove its rows from the queue and stop new categorizations.
- The refusal messages name the account and say where the money should be
  recorded instead, because "not in the budget" without that is a dead end.
- ADR 020's fourth term is unaffected: a pending charge on an in-budget account
  is still counted, and one on an out-of-budget account never was.
