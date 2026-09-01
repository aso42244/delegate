# 043. A rule does one of two things

**Status:** accepted
**Date:** 2026-09-01

## Context

Every auto-categorization rule assigned a delegation. `delegation_id` was `NOT
NULL`, and the whole of what a rule could say was "spending that looks like this
belongs in that envelope".

That left the most predictable transaction a household has as the one thing no
rule could touch.

A paycheck arrives from the same payer, on the same fortnight, with a
description that barely changes. It lands from the feed as `kind = normal`, which
means ordinary spending, so it goes into the uncategorized queue and sits there
until somebody opens the row menu and marks it income by hand. Every fortnight.
For ever. The same is true of every card payment and every mortgage payment,
which have to be labelled transfers before the pairing suggestion will even offer
them.

There was no way to automate it, because the only thing a rule could do to a
transaction was give it an envelope — and income and confirmed transfers
**allocate to nothing by definition**. Income arrives and is distributed by
Delegate; a movement between two owned accounts is not spending. Both are
enforced in `setAllocations`, which refuses allocations on either kind.

So the one automation the household would benefit from most was structurally
impossible, and nothing said so. It read as an odd gap: rules existed, worked
well, and simply never helped with the paycheck.

## Decision

**A rule carries an action, not a destination.** It either

- **categorizes** — assigns a delegation, as it always has; or
- **labels** — says the transaction _is_ income, or a transfer between owned
  accounts.

`delegation_id` becomes nullable and `set_kind` joins it. **Exactly one of the
two is set**, and that is held by a check constraint rather than by convention:

```sql
CHECK (
  (delegation_id IS NOT NULL AND set_kind IS NULL)
  OR (delegation_id IS NULL AND set_kind IN ('income', 'transfer'))
)
```

Both would categorize a row the domain forbids allocations on. Neither would
match and then change nothing, which is the worse of the two — a rule that
appears to work and does not is the shape this project has been bitten by
repeatedly, and it is the reason the constraint is in the database and not only
in `assertOneAction`.

**`normal` is refused as a label.** Only `normal` rows are examined in the first
place, so a rule labelling one `normal` would fire and do nothing.

**A labelling rule never touches a categorized row**, even under
`includeCategorized`, which is the flag that otherwise permits a bulk apply to
overwrite decisions made by hand. Re-labelling a categorized transaction would
mean destroying the allocations underneath it — and `updateTransaction` refuses
exactly that for a single row, with a message telling the reader to clear the
categorization first. **A bulk action must not do what the same action refuses
when it is asked for one row at a time.**

**The interface offers one control for the whole action.** Settings → Rules asks
"Then", and the select carries the delegations under one heading and the two
labels under another. A pair of controls that must not both be set is a pair
somebody will set both of; a single select whose value already says which of the
two it is cannot express the invalid state at all.

The column that read **"Categorizes as"** now reads **"Then"**, because a rule
that labels a paycheck as income categorizes nothing.

## Consequences

**Existing rules are unchanged.** Every stored row keeps its delegation and a
null `set_kind`, which is precisely what it did the day before. Nothing is
rewritten and no behaviour changes on upgrade.

**`applyRules` and `previewRules` return a third number.** `labelled` sits beside
`categorized`, and the two are counted separately because they are different
events: one moves an envelope balance and one does not. The Run rules dialog says
the second sentence only when there is something to say, so a household with no
labelling rules reads exactly the line it read before.

**The queue can finally empty.** Before this, a household that syncs is
guaranteed a permanent trickle of rows nobody can automate away — which is
corrosive in a queue whose entire value is that reaching zero means something.

**A labelling rule is more dangerous than a categorizing one, in one narrow
way.** Categorizing wrongly moves an envelope and is visible on the Budget page;
labelling wrongly takes a transaction _out_ of the queue, and a row nobody is
asked about is a row nobody looks at. The mitigations are the ones already here:
the rule list shows what each rule does, first-match-wins means one rule is
responsible, and the row menu can put a row back with **Mark as ordinary
spending**. It is worth knowing rather than worth blocking.
