# 023. Bitcoin holdings are a dated ledger

**Status:** accepted
**Date:** 2026-08-18

## Context

A Bitcoin holding was one number: `accounts.bitcoin_sats`. That left the net
worth chart with nowhere to read a past quantity from, so it applied **today's**
quantity to every historical price. The code said so in a comment rather than
pretending otherwise:

> Today's quantity against each historical price — quantity history is not
> stored, and the widget says so.

The consequence is not subtle. Bitcoin bought last week appeared to have been
held all year, and every point on the chart before the purchase was overstated by
whatever it was worth then. The owner asked to track historic purchases, which is
the same request from the other side.

## Decision

`bitcoin_holding_events`: a dated, signed, append-only ledger, deliberately the
same shape as `delegation_events`.

- **`occurred_at` is the date it happened**, not the date it was typed in. A
  purchase remembered three weeks late belongs in the week it happened, or every
  point between the two is wrong — which is the bug being fixed.
- **Reversal is a stamp, not a delete.** A correction cannot silently rewrite
  what the chart showed yesterday.
- **`accounts.bitcoin_sats` becomes a cache** of the un-reversed sum, written in
  the same transaction as the event, and `recompute-balances` now rebuilds and
  checks it alongside delegation balances. One command, two ledgers — there is no
  second thing to remember to run.

**Magnitude in, direction from the kind.** A caller gives a positive quantity and
says `sale`; it does not also give a negative number. Asking for both is asking
the same question twice, and the two answers disagreeing would be a silent wrong
balance. `adjustment` is the exception and carries its own sign, because a
correction genuinely goes either way.

**A price only where a price means something.** `purchase` and `sale` carry what
one whole Bitcoin cost at the time. A transfer between your own wallets buys
nothing, so a price on one would invent a gain out of moving your own money; the
API refuses it rather than storing it and hoping nobody reads it.

**Cost basis is average, and says what it does not know.** Average rather than
FIFO or specific-identification: this is a household budget, not a tax return,
and the figure exists so "worth $50,000" can be read against "cost $31,000".
Choosing a lot-matching method would imply a precision the application cannot
stand behind for a filing.

Satoshis whose cost is unknown — an opening balance from before this ledger, a
transfer in from elsewhere — are reported **separately** rather than valued at
zero. Zero would read as "free", which is a lie in the flattering direction. A
disposal reduces the priced and unpriced pools in proportion, because taking it
from either one first would flatter the basis in one direction or the other.

**History starts at the later of a quantity and a price.** The chart needs both.
Having a price from before you owned any Bitcoin is not the same as having
something to value with it, so the series begins where both are known rather than
drawing a flat line through days it cannot speak for.

## Consequences

Existing holdings get an `opening` event dated from `balance_as_of`, which is the
most recent moment the quantity is known to have been right. That is deliberately
conservative: dating it earlier would put Bitcoin on the chart before it is known
to have been held, which is the error this ADR exists to remove.

Those opening satoshis have no cost, and always will not. The cost basis
therefore reads as partial until the owner records what he actually paid — which
is honest, and is the prompt to do it.

Typing a new total still works and is still the fastest correction, but it can no
longer write the column. The difference becomes an `adjustment` event, so what
changed and when stays answerable afterwards.
