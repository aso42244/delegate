# 052 — An income source is inferred, not entered

**Status:** accepted
**Date:** 2026-09-08

## Context

The cashflow chart needs both halves of a flow: where money went, and where it
came from.

The right-hand side already existed. `spending_by_grouping` reads allocations,
which is the household's own filing of its spending, and the groupings are named
by the people who made them.

The left-hand side has no stored answer at all. **Income in Delegate allocates to
nothing, by design** — "waiting to be categorized" means waiting for a decision,
and income has none to make. A paycheck is marked `kind = income` and that is the
whole of what is recorded about it. There is no field that says _which_ income
this is, and nothing has ever needed one.

So a chart with `Salary` and `Freelance` on the left needs those names to come
from somewhere. Three places they could come from:

1. **A table of income sources**, maintained by hand and assigned per
   transaction. This is the shape [ADR 045](045-a-bill-is-inferred-not-entered.md)
   already refused for bills, for a reason that applies here unchanged: a
   hand-kept list is a second copy of what the transactions already say, and it
   is wrong within a month in the direction nobody notices.
2. **A new field on the transaction**, filled during categorization. But income
   does not pass through categorization — that is the point of it — so this would
   put a decision back into a flow deliberately emptied of one, on every
   fortnightly paycheck, for ever.
3. **Inferred from the description**, the way a bill is.

## Decision

**Income sources are inferred, grouped by `merchantKey`, and named by the newest
transaction's own description.**

That is deliberately the same machinery bills use rather than a second one.
`merchantKey` is already load-bearing in four places — categorization
suggestions, the rule dialog, what counts as one bill, and possible duplicates —
and a fifth idea of what makes two rows the same payer would be a fifth thing to
keep in step, changing under all of them at once when it moved.

**A source first appears as whatever the bank's descriptor says.** That is the
honest starting point rather than a defect: naming it is a correction somebody
makes, not a guess this application makes on their behalf.

**Nothing is stored.** There is no income-source table, no column, and no
migration. Every figure on the chart is derived on every request from the
register, exactly as bills are.

**Uncategorized appears on both sides and is not filler.** A deposit nobody has
marked as income and a charge nobody has filed are both real money moving
through. Drawing them in the neutral grey the reference charts use would say the
household spends a third of its income on something called "Uncategorized". They
take the warning tone and the tile links to the queue, because they are the one
thing on the chart anybody can act on — and until they are worked, every other
figure on it is wrong by that much.

**The surplus is the remainder, never measured separately.** A Sankey whose two
sides do not sum to the same figure cannot be drawn, and computing the surplus
some other way would eventually produce one.

## Consequences

- The chart's left-hand column reads as the bank's descriptors until somebody
  looks at it. On a real register that means `ACH DEPOSIT EMPLOYER` rather than
  `Salary`.
- **Renaming a source is not built.** Bills carries `bill_overrides` for exactly
  this and the same shape would work here, but it is a correction worth building
  once somebody has seen what the inferred names actually look like — building it
  first would be guessing at which names are wrong. If it is built, it must use
  the vocabulary bills already established (_Give it a name_), not a second one.
- Income and spending are read with the same predicates the existing
  `income_vs_spending` tile uses, so the two cannot disagree about what came in.
  A figure on this chart that contradicted the figure beside it would be worse
  than either alone.
- A household with no income recorded in the window sees an empty state rather
  than an empty chart. `cycleMissing` is kept distinct from "nothing came in",
  because one means the window does not exist yet and the other means it does and
  held nothing.

## Amendment, 2026-09-09 — two nodes, by origin

**The decision above is reversed on its central point.** Income sources are no
longer inferred per payer. There are two nodes: `Income` and `Income (manual)`.

The reasoning held right up to the moment real data was drawn. A year of the
owner's income produced a left column of bank strings — `ACH Deposit 12208 ELO
PROF L PAYROLL 13977925` — about 420px of text in a 448px gap, and the same
employer drawn **twice**, because the rows he typed during the SimpleFIN outage
carry a `MANUAL - ` prefix and `merchantKey` reads the first three usable words.

Both problems were foreseen here and judged acceptable: "a source first appears
as whatever the bank's descriptor says, which is the honest starting point". What
that missed is that **naming them is work with no end.** A bill is renamed once
and stays renamed because it recurs under one descriptor; a payroll descriptor
carries a reference number that changes, and an employer that renames itself
starts a new source. The correction never finishes.

The grouping is now `transactions.source` — a fact the database records rather
than a convention in somebody's typing. Two nodes, each named for what it is:
money the bank reported, and money entered while its feed was behind.

**The second node is a signal rather than a category.** It says the figures are
part bank and part household, which is the same thing the `a` chip says on an
account row, and it disappears on its own once the feed catches up and those rows
are archived. The owner asked for it kept for exactly that reason.

What this gives up is real: a household with several genuinely different income
streams sees one node where it might want three. That is a worse chart for them
and a better one here, and it is reversible — `merchantKey` grouping is four
lines away if it is ever wanted, and it would need the renaming this ADR
originally deferred.

**Renaming is therefore not built, and now has no reason to be.** There is
nothing left to rename.
