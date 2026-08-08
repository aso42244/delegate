# 004 — An envelope transfer writes no transaction row

**Status:** accepted
**Date:** 2026-08-08
**Deviates from:** build specification §6.7

## Context

The specification says the Transfer button should "post a transaction to the
Transactions page, since it is real money movement the owner may want to see in
context".

Moving money between two envelopes is not money movement. No account balance
changes; a label changes. Building it as specified has two concrete problems:

1. `transactions.account_id` is required, and an envelope transfer has no account.
   Any value chosen would be a fiction, and it would corrupt that account's
   register and every per-account report.
2. If the posted transaction carried allocations, those allocations would write
   `categorize` events on top of the `transfer` events and both delegations would
   move twice.

## Decision

Transfer writes a `delegation_transfers` row and two paired `transfer` events that
net to zero, leaving the identity unchanged — which is correct, because no real
money moved.

The owner's underlying need — seeing the movement in context — is met by an
**Envelope transfers** filter on the Transactions page, reading
`delegation_transfers` and rendering the two legs as one entry, visibly separate
from the real journal and excluded from all spending math. Transfers also appear
in per-line history.

## Consequences

The Transactions page gains a source of rows that is not the `transactions` table,
which is a small amount of extra work in that one view. In exchange the journal
stays a faithful record of real money, per-account registers stay correct, and
there is no double-movement to guard against.

Raised with the owner before any code was written and confirmed.
