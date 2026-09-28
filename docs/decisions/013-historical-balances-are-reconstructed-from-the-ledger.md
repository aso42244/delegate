# 013 — Historical balances are reconstructed from the ledger, not stored

**Status:** accepted
**Date:** 2026-08-09

## Context

Four widgets in the §9.4 catalog are time series over balances: net worth over
time, credit card balance trend, home equity over time, and Bitcoin holdings
value over time. All four have to answer "what was this worth on that date".

The schema stores **current** balances only. `accounts.balance_cents` is what an
account holds now — stamped by a sync for a fed account, set by hand for a manual
one. Nothing records what it held in March.

Three options were available.

1. **Snapshot balances nightly.** A new table, a new scheduled job, and a chart
   that begins the day the feature ships — useless for the twelve months of
   history the owner is about to import, which is the history he actually wants
   to look at.
2. **Reconstruct from the transaction ledger.** A balance on a date is the
   current balance minus everything that has moved since. No new storage, and it
   covers history that arrived before the feature existed.
3. **Do not build the widgets.** They are four of twelve, and three of them
   concern precisely the net-worth-only accounts the owner asked to keep visible.

## Decision

**Reconstruct.** For an account with transactions:

```
balance_on(date) = balance_now − Σ accountBalanceDelta(type, amount)
                                  for transactions after date
```

`accountBalanceDelta` is the same single function the rest of the application
uses, so a debt's opposing sign convention is applied in one place rather than
re-derived here.

Two kinds of account do not work that way, and are handled by what they actually
have:

- A **property** has no transactions. Its value on a date comes from
  `account_valuations` through `valueOnDate`, which already returns the most
  recent valuation at or before that date.
- A **Bitcoin holding** is a quantity, not a balance. Its value on a date is that
  quantity times the daily close in `bitcoin_prices`.

## Consequences

- **A reconstructed series is only as trustworthy as the transactions behind it.**
  It is exact back to the earliest transaction held for an account and
  meaningless before that. Reaching further back would draw a flat line at the
  oldest reconstructable balance, which looks like data and is not. The series
  therefore begins at the earliest transaction, and the API reports that date so
  the interface can say where the history genuinely starts.
- **Roughly six months, not twelve.**
  [ADR 009](009-simplefin-sync-cadence-and-window.md) records that the real feed
  returns about six months however the window is requested. These charts inherit
  that, and it is a property of the institutions rather than something to
  engineer around.
- **A gap in the transactions becomes a wrong balance, silently.** If the feed
  omits one, every reconstructed point before it is off by that amount while
  today's balance stays right. That is the honest cost of not storing snapshots,
  and it is why these are presented as a trend rather than as a statement of
  record.
- **Bitcoin quantity history is not stored either.** The value series applies
  today's quantity to each historical price. A holding that has not changed is
  exact; one that has is a "what it would have been worth" line. That is said on
  the widget rather than left to be assumed.
- Nothing new is written, so there is no migration, no job, and no stored copy
  that can drift from the ledger it came from — the same reasoning that keeps
  equity computed on read.
