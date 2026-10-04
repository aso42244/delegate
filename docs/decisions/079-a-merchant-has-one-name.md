# 079. A merchant has one name, laid over the bank's

**Status:** accepted
**Date:** 2026-10-04

## Context

A bank's description is written for the bank: `AMAZON MKTPL*RT4G93`, a
reference that never recurs, a store number. Recurring already let a bill be
renamed, stored per merchant in `bill_overrides.display_name`, but the name
stopped at Recurring — the register, the uncategorized queue and the day
dialog all showed the bank's string.

Rewriting the row's `description` would fix the display and lose the record:
the feed text is what a statement says, what rules match on, and what the
merchant key is computed from.

## Decision

**A merchant has one name of the household's own, kept on the merchant and
laid over the bank's description when a charge is read.** Nothing on the row
changes.

- It is the record Recurring's rename already wrote, keyed by `merchantKey`.
  One record, wherever it is set from — "Rename" on a bill, or "Name this
  merchant" in any register row's menu — so a name set in one place is the
  name in the other.
- The register lists `merchantKey` and `merchantName` per row. Where there is
  a name it leads, and the bank's text follows it, muted, on the same line;
  the uncategorized queue and the day dialog show the name with the bank's
  text on hover.
- **A search for the name finds the merchant's charges**, by the bank's words
  recorded when it was named.
- Rules still match the bank's description. A name is a label, not a fact the
  ledger acts on.

## Consequences

- Naming a merchant names its past charges as well as its future ones, which
  is the point: the name is about who it is, not about one row.
- Two merchants the key cannot tell apart share a name; the key is the same
  one Recurring has grouped bills by since ADR 045.
- The table keeps its historical name. `bill_overrides` now holds everything
  said about a merchant, bill or not — renaming it would be a migration with
  nothing to show for it.
